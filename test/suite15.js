// End-to-end test of the Query panel against a PATCHED Isabelle.
//
// Needs an Isabelle whose language server exposes PIDE/query_* -- the vscode-query-panel
// branch of mirror-isabelle. Point ISABELLE_QUERY_HOME at such a build; the suite skips
// itself if that is not set, so it stays harmless in a normal run.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }
const parity = () => vscode.commands.executeCommand('isabelle.jEditParityState')
const queryState = () => vscode.commands.executeCommand('isabelle.queryState')

async function run() {
  const home = process.env.ISABELLE_QUERY_HOME
  if (!home) {
    console.log('SKIP: ISABELLE_QUERY_HOME is not set, so there is no patched Isabelle to test')
    console.log('SUITE15_SKIPPED')
    return
  }
  console.log('patched Isabelle: ' + home)

  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Q.thy')
  fs.writeFileSync(file,
    'theory Q\n  imports Main\nbegin\n\nlemma q: "(1::nat) + 1 = 2"\n  by simp\n\nend\n', 'utf8')
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })

  const cfg = vscode.workspace.getConfiguration('isabelle')
  await cfg.update('home', home, vscode.ConfigurationTarget.Global)
  await cfg.update('queryPanel', true, vscode.ConfigurationTarget.Global)
  await vscode.commands.executeCommand('isabelle.restartServer')

  let deadline = Date.now() + 240000
  while (Date.now() < deadline) {
    const s = await vscode.commands.executeCommand('isabelle.serverState')
    if (s && s.state === 'Running') break
    console.log(`  ...restarting against the patched build (${Math.round((deadline - Date.now()) / 1000)}s left)`)
    await wait(4000)
  }
  const server = await vscode.commands.executeCommand('isabelle.serverState')
  assert.strictEqual(server.state, 'Running', 'the patched Isabelle should start normally')
  console.log('isabelle home in use: ' + server.isabelleHome)
  pass('language server runs against the patched build')

  // The panel probes for support on resolve.
  await vscode.commands.executeCommand('isabelle-query.focus')
  deadline = Date.now() + 60000
  let state
  while (Date.now() < deadline) {
    state = await parity()
    if (state.querySupported !== undefined) break
    console.log(`  ...probing for query support (${Math.round((deadline - Date.now()) / 1000)}s left)`)
    await wait(3000)
  }
  console.log('querySupported: ' + JSON.stringify(state.querySupported))
  assert.strictEqual(state.querySupported, true,
    'the patched server should answer PIDE/query_operations_request')
  pass('server advertises query operations over LSP')

  // Put the caret in the proof so the query has a context, then search.
  editor.selection = new vscode.Selection(5, 2, 5, 2)
  await wait(6000)
  await vscode.commands.executeCommand('isabelle.runQuery', 'find_theorems', ['5', 'false', '"_ + _"'])
  console.log('find_theorems dispatched')

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
  console.log('status: ' + q.status)
  console.log('output: ' + text.slice(0, 240))
  assert.ok(text.length > 0, 'output should not be empty')
  pass('find_theorems returned results through PIDE/query_output')

  await cfg.update('home', '', vscode.ConfigurationTarget.Global)
  await cfg.update('queryPanel', false, vscode.ConfigurationTarget.Global)

  console.log(`\n${passed} checks passed`)
  console.log('SUITE15_OK')
}

module.exports = { run }
