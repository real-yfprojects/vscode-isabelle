// The extended server against a STOCK Isabelle.
//
// isabelle.extendedServer starts vscode_server with server/<IDENTIFIER>.jar ahead of the
// distribution's own classes. This checks the whole claim end to end: the distribution
// found is an unmodified release, only that one setting is turned on (queryPanel stays
// off), and the Query panel -- whose messages a released server does not answer -- works.
//
// Skips itself when the jar has not been built (scripts/build-server-jar.sh), which is
// the normal state of a fresh checkout and of the integration job.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }
const parity = () => vscode.commands.executeCommand('isabelle.jEditParityState')
const queryState = () => vscode.commands.executeCommand('isabelle.queryState')

async function waitRunning(what) {
  const deadline = Date.now() + 240000
  while (Date.now() < deadline) {
    const s = await vscode.commands.executeCommand('isabelle.serverState')
    if (s && s.state === 'Running') return s
    console.log(`  ...${what} (${Math.round((deadline - Date.now()) / 1000)}s left)`)
    await wait(4000)
  }
  return vscode.commands.executeCommand('isabelle.serverState')
}

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()

  const first = await waitRunning('waiting for the standard server')
  const home = first.isabelleHome
  let identifier
  try {
    identifier = fs.readFileSync(path.join(home, 'etc', 'ISABELLE_IDENTIFIER'), 'utf8').trim()
  } catch {
    console.log(`SKIP: ${home} is not a released Isabelle`)
    console.log('SUITE36_SKIPPED')
    return
  }
  const jar = path.join(ext.extensionPath, 'server', `${identifier}.jar`)
  if (!fs.existsSync(jar)) {
    console.log(`SKIP: ${jar} has not been built (scripts/build-server-jar.sh)`)
    console.log('SUITE36_SKIPPED')
    return
  }
  console.log(`stock Isabelle: ${home}`)
  console.log(`extended server: ${jar}`)

  // Standard server first: the Query panel must not be there, or the check below proves
  // nothing about the setting.
  assert.strictEqual(await queryState(), undefined,
    'with neither setting on, the Query panel should not be registered')
  pass('the standard server comes up without the Query panel')

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'X.thy')
  fs.writeFileSync(file,
    'theory X\n  imports Main\nbegin\n\nlemma x: "(1::nat) + 1 = 2"\n  by simp\n\nend\n', 'utf8')
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })

  const cfg = vscode.workspace.getConfiguration('isabelle')
  await cfg.update('extendedServer', true, vscode.ConfigurationTarget.Global)
  await vscode.commands.executeCommand('isabelle.restartServer')
  const server = await waitRunning('restarting with the extended server')
  assert.strictEqual(server.state, 'Running', 'the extended server should start')
  assert.strictEqual(server.isabelleHome, home, 'the distribution must stay the stock one')
  pass('the extended server starts from the stock distribution')

  await vscode.commands.executeCommand('isabelle-query.focus')
  let deadline = Date.now() + 60000
  let state
  while (Date.now() < deadline) {
    state = await parity()
    if (state.querySupported !== undefined) break
    console.log(`  ...probing for query support (${Math.round((deadline - Date.now()) / 1000)}s left)`)
    await wait(3000)
  }
  assert.strictEqual(state.queryPanelEnabled, true,
    'extendedServer alone should enable the Query panel')
  assert.strictEqual(state.querySupported, true,
    'the extended server should answer PIDE/query_operations_request')
  pass('extendedServer alone enables the Query panel, and the server answers it')

  editor.selection = new vscode.Selection(5, 2, 5, 2)
  await wait(6000)
  await vscode.commands.executeCommand('isabelle.runQuery', 'find_theorems', ['5', 'false', '"_ + _"'])
  deadline = Date.now() + 90000
  let q
  while (Date.now() < deadline) {
    q = await queryState()
    if (q && q.output) break
    console.log(`  ...awaiting results, status=${JSON.stringify(q && q.status)}` +
                ` (${Math.round((deadline - Date.now()) / 1000)}s left)`)
    await wait(4000)
  }
  assert.ok(q && q.output, 'find_theorems should have produced output')
  const text = String(q.output).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  console.log('output: ' + text.slice(0, 200))
  assert.ok(text.length > 0, 'output should not be empty')
  pass('find_theorems returns results from the stock distribution')

  await cfg.update('extendedServer', false, vscode.ConfigurationTarget.Global)

  console.log(`\n${passed} checks passed`)
  console.log('SUITE36_OK')
}

module.exports = { run }
