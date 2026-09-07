// Step 1 acceptance: does the stock-VS-Code extension actually drive Isabelle/PIDE?
const vscode = require('vscode')
const assert = require('assert')
const path = require('path')

const EXT_ID = 'spike.isabelle-pide-stock'
const wait = ms => new Promise(r => setTimeout(r, ms))

async function pollFor(what, predicate, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = predicate()
    if (last !== undefined && last !== false && !(Array.isArray(last) && last.length === 0)) return last
    await wait(intervalMs)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

async function run() {
  const ext = vscode.extensions.getExtension(EXT_ID)
  assert.ok(ext, `extension ${EXT_ID} not found`)

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const uri = vscode.Uri.file(path.join(ws, 'Probe.thy'))
  const doc = await vscode.workspace.openTextDocument(uri)
  const editor = await vscode.window.showTextDocument(doc)

  console.log('languageId          : ' + doc.languageId)
  assert.strictEqual(doc.languageId, 'isabelle', 'the .thy file was not recognised as Isabelle')

  await ext.activate()
  console.log('extension active    : ' + ext.isActive)
  assert.ok(ext.isActive)

  // Put the caret in the file: PIDE only processes what is inside the caret perspective.
  editor.selection = new vscode.Selection(4, 2, 4, 2)
  await wait(500)
  editor.selection = new vscode.Selection(8, 2, 8, 2)

  console.log('waiting for Isabelle to build/load the HOL image and check the theory...')

  // Fail fast and loudly if the language client died, rather than polling for four minutes.
  const deadline = Date.now() + 240000
  let diags = []
  while (Date.now() < deadline) {
    const status = await vscode.commands.executeCommand('isabelle.serverState')
    if (status.state === 'StartFailed' || status.state === 'Stopped') {
      throw new Error(`language client state=${status.state}\nlastError: ${status.lastError}`)
    }
    diags = vscode.languages.getDiagnostics(uri)
    if (diags.length > 0) break
    await wait(2000)
  }
  if (diags.length === 0) throw new Error('timed out waiting for diagnostics')

  console.log(`diagnostics (${diags.length}):`)
  for (const d of diags) {
    console.log(`  line ${d.range.start.line + 1}: ${String(d.message).split('\n')[0].slice(0, 140)}`)
  }

  // Probe.thy line 9 (index 8) is `by simp` under an unprovable lemma.
  const onBadProof = diags.filter(d => d.range.start.line === 8)
  assert.ok(onBadProof.length > 0,
    `expected a diagnostic on line 9 (the failing proof); got lines ${diags.map(d => d.range.start.line + 1)}`)
  console.log('PASS: diagnostic reported on the failing proof')

  // The good lemma on line 5 must NOT be flagged.
  const onGoodProof = diags.filter(d => d.range.start.line === 4 || d.range.start.line === 5)
  assert.strictEqual(onGoodProof.length, 0,
    `the well-formed lemma was flagged: ${onGoodProof.map(d => d.message).join(' | ')}`)
  console.log('PASS: the well-formed lemma is clean')

  // Hover: probe a few positions and report which yield content.
  const positions = [
    ['line 5, "forall" escape', new vscode.Position(4, 16)],
    ['line 5, the "=" ', new vscode.Position(4, 31)],
    ['line 6, "simp"', new vscode.Position(5, 6)],
    ['line 1, theory name', new vscode.Position(0, 8)],
  ]
  let hoverHits = 0
  for (const [label, pos] of positions) {
    const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, pos)
    const text = (hovers || []).flatMap(h => h.contents.map(c => (typeof c === 'string' ? c : c.value)))
      .join(' ').replace(/\s+/g, ' ').trim()
    if (text) hoverHits++
    console.log(`hover @ ${label.padEnd(24)}: ${text ? text.slice(0, 120) : '(empty)'}`)
  }
  assert.ok(hoverHits > 0, 'no position produced hover content')
  console.log(`PASS: hover produced content at ${hoverHits}/${positions.length} probed positions`)

  console.log('\nSTEP1_OK')
}

module.exports = { run }
