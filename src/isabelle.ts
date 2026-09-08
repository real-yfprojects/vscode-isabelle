/* Locating an Isabelle distribution and launching `isabelle vscode_server`.
 *
 * The server is a normal LSP process speaking JSON-RPC over stdin/stdout
 * ("Run the VSCode Language Server protocol (JSON RPC) over stdin/stdout"),
 * so a stock extension can spawn it directly - no patched editor involved.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode'
import { Executable } from 'vscode-languageclient/node'

export class IsabelleNotFound extends Error {}

/** Windows path -> the /cygdrive/... form Isabelle's bundled Cygwin expects. */
export function toCygwinPath(p: string): string {
  const win = path.resolve(p)
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(win)
  if (!m) return win.replace(/\\/g, '/')
  return `/cygdrive/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

function isDistribution(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'bin', 'isabelle')).isFile() &&
      fs.statSync(path.join(dir, 'etc', 'symbols')).isFile()
  } catch { return false }
}

/** Newest-looking Isabelle* child directory of `parent`, if any. */
function scanForDistribution(parent: string): string | undefined {
  let entries: string[]
  try { entries = fs.readdirSync(parent) } catch { return undefined }
  const candidates = entries
    .filter(n => /^Isabelle\d{4}(-\d+)?$/.test(n))
    .map(n => path.join(parent, n))
    .filter(isDistribution)
    .sort()
  return candidates.pop()
}

export function findIsabelleHome(): string {
  const configured = vscode.workspace.getConfiguration('isabelle').get<string>('home')?.trim()
  if (configured) {
    if (!isDistribution(configured)) {
      throw new IsabelleNotFound(
        `isabelle.home is set to "${configured}", but that is not an Isabelle distribution ` +
        `(expected bin/isabelle and etc/symbols beneath it).`)
    }
    return configured
  }

  const env = process.env.ISABELLE_HOME
  if (env && isDistribution(env)) return env

  const home = os.homedir()
  const roots = process.platform === 'win32'
    ? [path.join(home, 'Isabelle'), home, 'C:\\']
    : process.platform === 'darwin'
      ? ['/Applications', path.join(home, 'Applications'), home]
      : [home, '/opt', '/usr/local']

  for (const root of roots) {
    const found = scanForDistribution(root)
    if (found) return found
  }

  throw new IsabelleNotFound(
    'No Isabelle distribution found. Set "isabelle.home" to the directory containing bin/isabelle.')
}

/** Isabelle ships its own Cygwin on Windows; its bash is how the tool script must be run. */
function cygwinBash(isabelleHome: string): string {
  return path.join(isabelleHome, 'contrib', 'cygwin', 'bin', 'bash.exe')
}

export function serverArguments(): string[] {
  const cfg = vscode.workspace.getConfiguration('isabelle')
  const args: string[] = []

  const logic = cfg.get<string>('logic')?.trim()
  /* -R builds the image of a session's *requirements* rather than the session itself,
     which is the setup you want while editing that session's own theories: everything
     they import comes from a heap and is never re-checked, while the files you are
     editing stay live. Plain -l loads the named session itself, so its theories are
     already in the image and PIDE treats them as loaded rather than editable. */
  if (logic) args.push(cfg.get<boolean>('logicRequirements') ? '-R' : '-l', logic)

  for (const dir of cfg.get<string[]>('sessionDirs') ?? []) {
    if (dir.trim()) args.push('-d', dir.trim())
  }
  for (const opt of cfg.get<string[]>('serverOptions') ?? []) {
    if (opt.trim()) args.push('-o', opt.trim())
  }
  // A dedicated setting rather than making users hand-write an -o override.
  if (cfg.get<boolean>('spellChecker') === false) args.push('-o', 'spell_checker=false')
  /* jEdit's "Continuous checking" toggle has no direct counterpart here: the server
     narrows the document perspective to vscode_caret_perspective lines around the caret,
     and 0 means the whole visible theory instead. The option is read once when the
     session starts, so the command that flips this setting restarts the server. */
  if (cfg.get<boolean>('continuousChecking')) args.push('-o', 'vscode_caret_perspective=0')
  if (cfg.get<boolean>('verbose')) args.push('-v')
  args.push(...(cfg.get<string[]>('serverArgs') ?? []))
  return args
}

/**
 * The extension host runs with ELECTRON_RUN_AS_NODE=1 and a pile of VSCODE_* variables.
 * Inheriting those into a child that eventually launches a JVM is at best noise and at
 * worst makes an Electron binary in the chain misbehave, so strip them.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('VSCODE_') || k.startsWith('ELECTRON_')) continue
    env[k] = v
  }
  if (process.platform === 'win32') {
    env.HOME = env.HOME || env.USERPROFILE
    env.CHERE_INVOKING = 'true'
    env.LANG = env.LANG || 'en_US.UTF-8'
  }
  return env
}

export function buildServerOptions(isabelleHome: string): Executable {
  const args = serverArguments()
  // Pin cwd: the extension host's own cwd may be somewhere Cygwin cannot chdir into,
  // and CHERE_INVOKING makes the login shell try to stay there.
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? isabelleHome
  const options = { env: childEnv(), shell: false, cwd }

  if (process.platform === 'win32') {
    const bash = cygwinBash(isabelleHome)
    if (!fs.existsSync(bash)) {
      throw new IsabelleNotFound(
        `Isabelle's bundled Cygwin is missing at ${bash}. ` +
        `Run Cygwin-Setup.bat in the Isabelle directory once after installing.`)
    }
    return {
      command: bash,
      args: ['-l', `${toCygwinPath(isabelleHome)}/bin/isabelle`, 'vscode_server', ...args],
      options,
    }
  }

  return {
    command: path.join(isabelleHome, 'bin', 'isabelle'),
    args: ['vscode_server', ...args],
    options,
  }
}
