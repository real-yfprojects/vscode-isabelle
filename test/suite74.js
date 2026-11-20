// An Isabelle installed as a user installs it, found with nothing pointing at it.
//
// CI runs this once per platform and release, after installing the downloaded release the
// way Isabelle's instructions do: on macOS the .app unpacked into /Applications, on Linux
// the folder unpacked into ~, on Windows the self-extracting installer run with its
// defaults, which puts Isabelle on the Desktop and initializes its Cygwin. No isabelle.home
// and no ISABELLE_HOME: everything else hands the extension one of those, so this is the
// one place its own search runs against a real installation -- and on Windows, the one
// place the server starts from a Cygwin the installer set up rather than the CI script.
//
//   ISABELLE_TEST_EXPECT_HOME   where the installation is: the folder holding bin/isabelle
//
// Not part of the regression set: it needs that installation, and a run without
// ISABELLE_HOME. suite72 checks the search itself against fake installations.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const EXT_ID = 'yfprojects.vscode-isabelle'
const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

async function until(what, seconds, probe, interval = 1000) {
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
    console.error('SUITE74 FAILED: ' + (err && err.stack || err))
    throw err
  }
}

async function drive() {
  const expected = process.env.ISABELLE_TEST_EXPECT_HOME
  assert.ok(expected, 'set ISABELLE_TEST_EXPECT_HOME to the installation the extension should find')
  assert.ok(!process.env.ISABELLE_HOME,
    `ISABELLE_HOME is set (${process.env.ISABELLE_HOME}), so the search would never run`)
  const set = vscode.workspace.getConfiguration('isabelle').inspect('home')
  assert.ok(!set.globalValue && !set.workspaceValue && !set.workspaceFolderValue,
    'isabelle.home is set, so the search would never run')
  pass('nothing tells the extension where Isabelle is')

  const ext = vscode.extensions.getExtension(EXT_ID)
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const uri = vscode.Uri.file(path.join(ws, 'Probe.thy'))
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri))
  await ext.activate()
  editor.selection = new vscode.Selection(8, 2, 8, 2)

  const state = await until('the server to start', 300, async () => {
    const commands = await vscode.commands.getCommands(true)
    if (!commands.includes('isabelle.serverState')) {
      const status = await vscode.commands.executeCommand('isabelle.statusBarState')
      if (status?.server === 'failed') throw new Error(`Isabelle was not found: ${status.tooltip}`)
      return undefined
    }
    const s = await vscode.commands.executeCommand('isabelle.serverState')
    if (s.state === 'StartFailed') throw new Error(`the server failed to start: ${s.lastError}`)
    return s.state === 'Running' && s
  })
  // Compared as real paths: a runner's temp and home folders can be reached through links.
  assert.strictEqual(fs.realpathSync(state.isabelleHome), fs.realpathSync(expected),
    `found ${state.isabelleHome}, expected ${expected}`)
  pass(`the extension found ${state.isabelleHome} on its own`)

  const diags = await until('the theory to be checked', 240, () => {
    const d = vscode.languages.getDiagnostics(uri)
    return d.length > 0 && d
  }, 2000)
  assert.ok(diags.some(d => d.range.start.line === 8),
    `expected the failing proof on line 9 to be flagged; got lines ${diags.map(d => d.range.start.line + 1)}`)
  pass('the server it started checks a theory')

  console.log(passed + ' checks passed')
  console.log('SUITE74_OK')
}

module.exports = { run }
