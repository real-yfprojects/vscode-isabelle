/* Locating an Isabelle distribution and launching `isabelle vscode_server`.
 *
 * The server is a normal LSP process speaking JSON-RPC over stdin/stdout
 * ("Run the VSCode Language Server protocol (JSON RPC) over stdin/stdout"),
 * so a stock extension can spawn it directly - no patched editor involved.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode'
import { Executable } from 'vscode-languageclient/node'

export class IsabelleNotFound extends Error {}

/** Windows path -> the /cygdrive/... form Isabelle's bundled Cygwin expects.
 *
 * path.win32.resolve, not path.resolve. The host's resolver is the Windows one only when
 * the host is Windows, so on Linux `path.resolve("C:\\x")` yields "<cwd>/C:\x" -- no drive
 * letter at position 0, the regex below misses, and the result is a mangled path rather
 * than a Cygwin one. Production never saw it, because serverPath only calls this when the
 * target platform is win32 and that is the host too; but the platform argument exists so
 * the launch can be checked from any host, and this function quietly did not support that.
 * CI on Linux is what surfaced it.
 */
export function toCygwinPath(p: string): string {
  const win = path.win32.resolve(p)
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

/**
 * Whether to start the server from the extension's own build of Isabelle/Scala.
 *
 * server/<IDENTIFIER>.jar is the distribution's lib/classes/isabelle.jar compiled with the
 * language-server additions the panels marked experimental need (scripts/build-server-jar.sh).
 * getsettings seeds ISABELLE_CLASSPATH from the caller's CLASSPATH before any component
 * appends to it, so a jar named there comes first and every isabelle.* class loads from
 * it rather than from the distribution -- which is never modified, and still serves
 * jEdit and everything else unchanged.
 *
 * The jar is compiled against one release, and Scala classes from one release do not
 * link against another, so it is used only when the distribution names that release.
 */
export type ExtendedServer =
  | { kind: 'off' }
  | { kind: 'on', jar: string, identifier: string }
  | { kind: 'unavailable', reason: string }

export function extendedServer(isabelleHome: string, extensionPath: string): ExtendedServer {
  if (!vscode.workspace.getConfiguration('isabelle').get<boolean>('extendedServer')) {
    return { kind: 'off' }
  }
  let identifier: string
  try {
    identifier = fs.readFileSync(path.join(isabelleHome, 'etc', 'ISABELLE_IDENTIFIER'), 'utf8').trim()
  } catch {
    return {
      kind: 'unavailable',
      reason: `${isabelleHome} is not a released Isabelle (it has no etc/ISABELLE_IDENTIFIER).`,
    }
  }
  const serverDir = path.join(extensionPath, 'server')
  const jar = path.join(serverDir, `${identifier}.jar`)
  if (fs.existsSync(jar)) return { kind: 'on', jar, identifier }

  let available: string[] = []
  try {
    available = fs.readdirSync(serverDir).filter(n => n.endsWith('.jar')).map(n => n.slice(0, -4))
  } catch { /* none bundled */ }
  return {
    kind: 'unavailable',
    reason: available.length > 0
      ? `The extended server is built for ${available.join(', ')}, not ${identifier}.`
      : 'This build of the extension does not include the extended server.',
  }
}

/**
 * A copy of the extended server's jar for the server to run, never the extension's own file.
 *
 * A JVM keeps the jars on its classpath open, and on Windows an open jar can still be
 * overwritten in place: tested, the copy succeeds and the running JVM's next class load
 * fails with ClassNotFoundException (deleting or renaming over it is refused instead). So
 * rebuilding server/<IDENTIFIER>.jar, or an extension update replacing it, would break a
 * server that is running it the moment it first loaded, say, a panel's classes. The copy
 * is named by content and never written again once in place, so a running server keeps
 * its jar and the next start picks up a new one.
 */
export function stageExtendedJar(jar: string, storageDir: string): string {
  const bytes = fs.readFileSync(jar)
  const digest = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  const base = path.basename(jar, '.jar')
  const staged = path.join(storageDir, `${base}-${digest}.jar`)
  if (!fs.existsSync(staged)) {
    fs.mkdirSync(storageDir, { recursive: true })
    // Written aside and renamed, so no server ever sees half a jar under that name.
    const tmp = `${staged}.${process.pid}.tmp`
    fs.writeFileSync(tmp, bytes)
    try { fs.renameSync(tmp, staged) } catch (err) {
      // Another window staged the same content first; that copy is as good.
      fs.rmSync(tmp, { force: true })
      if (!fs.existsSync(staged)) throw err
    }
  }
  /* Earlier copies, where nothing runs them any more. One a server still runs cannot be
     deleted on Windows and stays; on POSIX it goes, and the server keeps its open file. */
  for (const name of fs.readdirSync(storageDir)) {
    const file = path.join(storageDir, name)
    if (file !== staged && name.startsWith(`${base}-`) && name.endsWith('.jar')) {
      try { fs.rmSync(file) } catch { /* in use */ }
    }
  }
  return staged
}

/** Isabelle ships its own Cygwin on Windows; its bash is how the tool script must be run. */
function cygwinBash(isabelleHome: string): string {
  return path.join(isabelleHome, 'contrib', 'cygwin', 'bin', 'bash.exe')
}

/**
 * A path as the *server* must see it.
 *
 * On Windows the server runs under Isabelle's bundled Cygwin, and Isabelle's own
 * Path.explode rejects a native path: a `-d c:\Users\...` argument makes vscode_server
 * exit 1 before the client ever sees an initialize reply. Only the launcher path was
 * being converted, which went unnoticed while nobody had sessionDirs set.
 *
 * A path that is already POSIX is left alone -- path.resolve would otherwise turn
 * "/cygdrive/c/x" into "C:\cygdrive\c\x" and break a setting that was correct.
 */
export function serverPath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return p
  if (p.startsWith('/')) return p
  return toCygwinPath(p)
}

export function serverArguments(platform: NodeJS.Platform = process.platform): string[] {
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
    if (dir.trim()) args.push('-d', serverPath(dir.trim(), platform))
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
function childEnv(platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('VSCODE_') || k.startsWith('ELECTRON_')) continue
    env[k] = v
  }
  if (platform === 'win32') {
    env.HOME = env.HOME || env.USERPROFILE
    env.CHERE_INVOKING = 'true'
    env.LANG = env.LANG || 'en_US.UTF-8'
  }
  return env
}

/**
 * A shell with `isabelle` on its PATH: on Windows, what the distribution's
 * Cygwin-Terminal.bat opens.
 *
 * That script only works when started from the Isabelle directory (it prepends %CD%\bin),
 * so it cannot simply be launched from here; this is its environment, rebuilt. HOME is
 * the server's, not the script's %HOMEDRIVE%%HOMEPATH%: the two usually agree, and where
 * they do not, `isabelle build` in the terminal must still write the heaps under the
 * ~/.isabelle the server reads.
 *
 * Off Windows there is no second shell to reach, so it is the user's own shell with the
 * distribution's bin/ put first -- still the distribution the extension runs, rather than
 * whichever `isabelle` PATH happens to find. No cwd: VS Code then picks the workspace
 * folder itself, and asks which one in a multi-root workspace.
 */
export function terminalOptions(
  isabelleHome: string, platform: NodeJS.Platform = process.platform,
  hostEnv: NodeJS.ProcessEnv = process.env,
): vscode.TerminalOptions {
  const name = 'Isabelle'
  const iconPath = new vscode.ThemeIcon('terminal')
  /* Windows variable names are case-insensitive and PATH is usually spelled "Path".
     Setting "PATH" beside it would hand the shell two of them, and which one wins is up
     to whoever builds the environment block. */
  const pathKey = platform === 'win32'
    ? Object.keys(hostEnv).find(k => k.toUpperCase() === 'PATH') ?? 'Path'
    : 'PATH'
  const oldPath = hostEnv[pathKey]
  const sep = platform === 'win32' ? ';' : ':'
  const bin = (platform === 'win32' ? path.win32 : path.posix).join(isabelleHome, 'bin')
  const env: Record<string, string> = { [pathKey]: oldPath ? `${bin}${sep}${oldPath}` : bin }

  if (platform !== 'win32') return { name, iconPath, env }

  const bash = cygwinBash(isabelleHome)
  if (!fs.existsSync(bash)) {
    throw new IsabelleNotFound(
      `Isabelle's bundled Cygwin is missing at ${bash}. ` +
      `Run Cygwin-Setup.bat in the Isabelle directory once after installing.`)
  }
  const server = childEnv(platform)
  // A native PATH, as in the batch file: Cygwin converts it when bash starts.
  env.HOME = server.HOME ?? ''
  env.LANG = server.LANG ?? 'en_US.UTF-8'
  // Without it the login profile changes to HOME instead of staying in the workspace.
  env.CHERE_INVOKING = 'true'
  return {
    name, iconPath, env,
    shellPath: bash,
    shellArgs: ['--login', '-i'],
    message: 'This is the GNU Bash interpreter of Isabelle\'s Cygwin. ' +
      'Use command "isabelle" to invoke Isabelle tools.',
  }
}

/**
 * How to launch the server.
 *
 * `platform` is injectable so the launch path for an OS can be checked from any other --
 * only the Windows/Cygwin path has ever actually started a prover, and CI has no Isabelle
 * to change that, so the argument construction is the part that can be held still.
 */
export function buildServerOptions(
  isabelleHome: string, platform: NodeJS.Platform = process.platform, extendedJar?: string,
): Executable {
  const args = serverArguments(platform)
  const env = childEnv(platform)
  /* A native path list: on Windows getsettings converts CLASSPATH with `cygpath -p`,
     which expects the Windows form, separator included. */
  if (extendedJar) {
    const sep = platform === 'win32' ? ';' : ':'
    env.CLASSPATH = env.CLASSPATH ? `${extendedJar}${sep}${env.CLASSPATH}` : extendedJar
  }
  // Pin cwd: the extension host's own cwd may be somewhere Cygwin cannot chdir into,
  // and CHERE_INVOKING makes the login shell try to stay there.
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? isabelleHome
  /* Own process group, so the whole prover stack can be signalled as a unit: the JVM sits
     below the process we spawn and killing only our own child orphans it (process_tree.ts
     has the full story). Windows is deliberately excluded -- there `detached` means a new
     console rather than a new group, and taskkill /T walks the tree instead. */
  const options =
    { env, shell: false, cwd, detached: platform !== 'win32' }

  if (platform === 'win32') {
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
