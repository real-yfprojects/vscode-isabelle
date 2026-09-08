// The Query panel needs server support that released Isabelle lacks. Check it degrades
// honestly: enabled by setting, registered, and reporting "unsupported" rather than
// hanging silently.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }
const parity = () => vscode.commands.executeCommand('isabelle.jEditParityState')

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Query.thy')
  fs.writeFileSync(file,
    'theory Query\n  imports Main\nbegin\n\nlemma q: "(1::nat) + 1 = 2"\n  by simp\n\nend\n', 'utf8')
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  await vscode.window.showTextDocument(doc, { preview: false })
  await wait(1500)

  // Off by default, so a stock distribution shows no dead view.
  let state = await parity()
  assert.strictEqual(state.queryPanelEnabled, false,
    'the Query panel must be off unless isabelle.queryPanel is set')
  pass('Query panel is off by default')

  // Enabling it takes effect on the next server start.
  await vscode.workspace.getConfiguration('isabelle')
    .update('queryPanel', true, vscode.ConfigurationTarget.Global)
  await vscode.commands.executeCommand('isabelle.restartServer')

  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    const s = await vscode.commands.executeCommand('isabelle.serverState')
    if (s && s.state === 'Running') break
    console.log(`  ...restarting server, state=${JSON.stringify(s && s.state)}`)
    await wait(4000)
  }
  state = await parity()
  assert.strictEqual(state.queryPanelEnabled, true, 'the panel should register once enabled')
  pass('Query panel registers when isabelle.queryPanel is set')

  // Focusing it probes the server; released Isabelle never replies, and after the probe
  // window the panel must settle on "unsupported" rather than waiting forever.
  await vscode.commands.executeCommand('isabelle-query.focus')
  const until = Date.now() + 30000
  while (Date.now() < until) {
    state = await parity()
    if (state.querySupported !== undefined) break
    console.log(`  ...probing for query support (${Math.round((until - Date.now()) / 1000)}s left)`)
    await wait(3000)
  }
  console.log(`querySupported: ${JSON.stringify(state.querySupported)}`)
  assert.strictEqual(typeof state.querySupported, 'boolean',
    'the panel must settle on a definite answer, not stay undefined')
  assert.strictEqual(state.querySupported, false,
    'released Isabelle2025-2 has no PIDE/query_* messages, so support must read false')
  pass('Query panel reports the server as unsupported instead of hanging')

  await vscode.workspace.getConfiguration('isabelle')
    .update('queryPanel', false, vscode.ConfigurationTarget.Global)

  console.log(`\n${passed} checks passed`)
  console.log('SUITE14_OK')
}

module.exports.run = () => run().catch(err => {
  console.error('FAIL: ' + (err && err.stack || err))
  process.exit(1)
})
