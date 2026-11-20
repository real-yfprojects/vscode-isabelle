// Setting up: the window that starts without finding Isabelle, and how it recovers.
//
// Reported from macOS: Isabelle was not found, and once isabelle.home was set, "there were
// a few quirks about restarting the engine". Activation used to stop at the failed lookup
// for good. The setting was then read by nothing, and "Start / Restart Language Server" --
// the button on the error, the link in the status bar -- answered "command not found",
// since it was registered past the lookup; only a window reload recovered.
//
// So: start with an isabelle.home that names no distribution, check what a user is shown
// and that the commands they are pointed at exist, then fix the setting and expect the
// server to come up and check a theory, in the same window.
//
// runAll starts it without theories, so the setting is in place before activation.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { findIsabelleHome } = require('../out/isabelle.js')
const { escapeMarkdown } = require('../out/status_items.js')

const EXT_ID = 'yfprojects.vscode-isabelle'
const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

async function until(what, seconds, probe, interval = 500) {
  const deadline = Date.now() + seconds * 1000
  let last
  while (Date.now() < deadline) {
    last = await probe()
    if (last) return last
    await wait(interval)
  }
  throw new Error(`timed out after ${seconds}s: ${what} (last: ${JSON.stringify(last)})`)
}

async function run() {
  try { await drive() } catch (err) {
    console.error('SUITE73 FAILED: ' + (err && err.stack || err))
    throw err
  }
}

async function drive() {
  const ext = vscode.extensions.getExtension(EXT_ID)
  assert.ok(!ext.isActive, 'nothing has activated the extension yet')

  // The distribution this machine has, found before the setting below hides it.
  let home
  try { home = findIsabelleHome() } catch {
    console.log('SKIP: no Isabelle distribution here to recover with')
    return finish()
  }
  console.log(`isabelle: ${home}`)

  const cfg = () => vscode.workspace.getConfiguration('isabelle')
  const nowhere = fs.mkdtempSync(path.join(os.tmpdir(), 'not-isabelle-'))
  await cfg().update('home', nowhere, vscode.ConfigurationTarget.Workspace)

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Probe.thy')
  fs.copyFileSync(path.join(__dirname, 'workspace', 'Probe.thy'), file)
  const uri = vscode.Uri.file(file)
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri))
  await ext.activate()

  // --- not found ------------------------------------------------------------------------
  const failed = await until('the status bar to report the failed lookup', 30, async () => {
    const s = await vscode.commands.executeCommand('isabelle.statusBarState')
    return s && s.server === 'failed' && s
  })
  assert.ok(String(failed.tooltip).includes(escapeMarkdown(nowhere)),
    `the status bar's tooltip should name the setting's path: ${failed.tooltip}`)
  pass('a wrong isabelle.home shows as a failed server, naming the path')

  const commands = await vscode.commands.getCommands(true)
  for (const command of ['isabelle.restartServer', 'isabelle.checkInstallation', 'isabelle.gettingStarted']) {
    assert.ok(commands.includes(command), `${command} must exist while Isabelle is missing`)
  }
  pass('the commands the error and the walkthrough point at exist')

  // Asked again while still wrong: reported again, and nothing breaks.
  await vscode.commands.executeCommand('isabelle.restartServer')
  await vscode.commands.executeCommand('isabelle.checkInstallation')
  const still = await vscode.commands.executeCommand('isabelle.statusBarState')
  assert.strictEqual(still.server, 'failed')
  pass('restarting and checking with the setting still wrong report it again')

  // --- fixed --------------------------------------------------------------------------
  await cfg().update('home', home, vscode.ConfigurationTarget.Workspace)
  editor.selection = new vscode.Selection(8, 2, 8, 2)

  const state = await until('the server to start from the corrected setting', 300, async () => {
    const commands = await vscode.commands.getCommands(true)
    if (!commands.includes('isabelle.serverState')) return undefined
    const s = await vscode.commands.executeCommand('isabelle.serverState')
    if (s.state === 'StartFailed') throw new Error(`the server failed to start: ${s.lastError}`)
    return s.state === 'Running' && s
  }, 1000)
  assert.strictEqual(state.isabelleHome, home)
  assert.ok(state.symbols > 0, 'the symbol table is loaded from the distribution')
  pass('setting isabelle.home starts the server, without a reload')

  const diags = await until('the theory to be checked', 240, () => {
    const d = vscode.languages.getDiagnostics(uri)
    return d.length > 0 && d
  }, 2000)
  assert.ok(diags.some(d => d.range.start.line === 8),
    `expected the failing proof on line 9 to be flagged; got lines ${diags.map(d => d.range.start.line + 1)}`)
  pass('and it checks the open theory')

  fs.rmSync(nowhere, { recursive: true, force: true })
  finish()
}

function finish() {
  console.log(passed + ' checks passed')
  console.log('SUITE73_OK')
}

module.exports = { run }
