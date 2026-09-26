// The Isabelle terminal (src/terminal.ts): a shell where `isabelle` is the distribution
// the extension runs -- on Windows, a shell of Isabelle's own Cygwin.
//
// The options are checked for every platform from whichever this is, as suite26 does for
// the server launch. Then, when a distribution is installed, a real terminal is opened
// through the command and the Isabelle profile, and made to run `isabelle` and report
// where it is: a terminal whose shell starts but cannot find the tool, or starts in HOME
// instead of the workspace, looks entirely normal until someone types into it.
//
// Needs no prover; runAll starts it with isabelle.autoStart off.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { terminalOptions, findIsabelleHome, toCygwinPath, IsabelleNotFound } =
  require('../out/isabelle.js')

const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

async function until(what, seconds, probe, interval = 1000) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await wait(interval)
  }
  throw new Error(`timed out after ${seconds}s: ${what}`)
}

async function run() {
  try { await drive() } catch (err) {
    console.error('SUITE40 FAILED: ' + (err && err.stack || err))
    throw err
  }
}

async function drive() {
  // --- options, for every platform ---------------------------------------------------
  const posix = terminalOptions('/opt/Isabelle2025-2', 'linux', { PATH: '/usr/bin:/bin' })
  assert.strictEqual(posix.shellPath, undefined, 'off Windows the user keeps their own shell')
  assert.strictEqual(posix.env.PATH, '/opt/Isabelle2025-2/bin:/usr/bin:/bin')
  assert.strictEqual(posix.env.CHERE_INVOKING, undefined,
    'CHERE_INVOKING is a Cygwin concern and must not leak onto POSIX')
  assert.strictEqual(posix.cwd, undefined, 'VS Code chooses the folder, as for any terminal')
  pass('the POSIX terminal is the default shell with the distribution\'s bin/ first')

  assert.throws(
    () => terminalOptions('C:\\nowhere\\Isabelle2025-2', 'win32', { Path: 'C:\\Windows' }),
    err => err instanceof IsabelleNotFound && /Cygwin-Setup\.bat/.test(err.message),
    'a distribution without its Cygwin must say how to fix it')
  pass('a distribution without Cygwin is reported, with the fix')

  let home
  try { home = findIsabelleHome() } catch {
    console.log('SKIP: no Isabelle distribution here; the terminal itself is not opened')
  }

  if (home && process.platform === 'win32') {
    const win = terminalOptions(home, 'win32', { Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u' })
    assert.ok(win.shellPath.endsWith(path.join('contrib', 'cygwin', 'bin', 'bash.exe')),
      `the shell must be Isabelle's own bash: ${win.shellPath}`)
    assert.deepStrictEqual(win.shellArgs, ['--login', '-i'])
    assert.strictEqual(win.env.Path, `${path.join(home, 'bin')};C:\\Windows`)
    assert.ok(!('PATH' in win.env), 'the host\'s own spelling of Path is reused, not doubled')
    assert.strictEqual(win.env.CHERE_INVOKING, 'true')
    pass('the Windows terminal is Cygwin-Terminal.bat\'s bash, environment and all')
  }

  if (!home) return finish()

  await vscode.workspace.getConfiguration('isabelle')
    .update('autoStart', false, vscode.ConfigurationTarget.Global)

  // --- a real terminal, through the command and through the profile -----------------
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  const shellPath = p => process.platform === 'win32' ? toCygwinPath(p) : p
  // Cygwin spells the drive in lower case; the rest of the path is compared as is.
  const same = (a, b) => process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase() : a === b

  /** Make `terminal` report its directory and ISABELLE_HOME through a file. */
  async function probe(terminal, label) {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'isa-term-')), 'out.txt')
    await until(`${label}: shell process`, 30, () => terminal.processId)
    terminal.sendText(
      `{ pwd; isabelle getenv -b ISABELLE_HOME; } > '${shellPath(out)}.tmp' 2>&1; ` +
      `mv '${shellPath(out)}.tmp' '${shellPath(out)}'`)
    const text = await until(`${label}: isabelle getenv`, 90, () =>
      fs.existsSync(out) && fs.readFileSync(out, 'utf8'))
    /* VS Code's shell integration reaches Isabelle's bash too, and its DEBUG trap runs
       inside the redirected group, so its OSC 633 marks land in the file. */
    const [pwd, isabelleHome] = text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
      .trim().split(/\r?\n/)
    assert.ok(same(isabelleHome, shellPath(home)),
      `${label}: \`isabelle\` must be the extension's distribution ${home}; got:\n${text}`)
    if (folder) {
      assert.ok(same(pwd, shellPath(folder)),
        `${label}: the shell must start in the workspace ${folder}, not ${pwd}`)
    }
  }

  /* Found in window.terminals rather than taken from anywhere else: a value crossing
     executeCommand arrives as a serialized copy, with a name but no sendText. */
  const opened = (label, before) => until(`${label}: a new terminal named Isabelle`, 30, () =>
    vscode.window.terminals.find(t => !before.has(t) && t.name === 'Isabelle'))

  let before = new Set(vscode.window.terminals)
  await vscode.commands.executeCommand('isabelle.openTerminal')
  const byCommand = await opened('command', before)
  await probe(byCommand, 'command')
  pass('the command\'s terminal runs the extension\'s isabelle, in the workspace')
  byCommand.dispose()

  before = new Set(vscode.window.terminals)
  // What the "+" menu does with a contributed profile: an ICreateTerminalOptions whose
  // config names the extension and the profile id from package.json.
  await vscode.commands.executeCommand('workbench.action.terminal.newWithProfile', {
    config: {
      extensionIdentifier: 'yfprojects.vscode-isabelle', id: 'isabelle.terminal', title: 'Isabelle',
    },
  })
  const byProfile = await opened('profile', before)
  await probe(byProfile, 'profile')
  pass('the terminal profile opens the same shell')
  byProfile.dispose()

  finish()
}

function finish() {
  console.log(passed + ' checks passed')
  console.log('SUITE40_OK')
}

module.exports = { run }
