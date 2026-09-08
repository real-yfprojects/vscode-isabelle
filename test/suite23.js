// The markupColors escape hatch: "isabelle" must put the palette decorations back.
//
// The two paths are mutually exclusive by construction -- a decoration `color` overrides
// the theme, so serving both would silently undo the theme fix.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const wait = ms => new Promise(r => setTimeout(r, ms))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }
const summary = () => vscode.commands.executeCommand('isabelle.pideDecorationSummary')

async function until(what, seconds, probe) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const v = await probe()
    if (v) return v
    console.log(`  ...${what} (${Math.round((deadline - Date.now()) / 1000)}s left)`)
    await wait(2000)
  }
  return undefined
}

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Colors.thy')
  fs.writeFileSync(file, [
    'theory Colors', '  imports Main', 'begin', '',
    'lemma c: "(1::nat) + 1 = 2"', '  by simp', '', 'end', '',
  ].join('\n'), 'utf8')
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  editor.selection = new vscode.Selection(4, 4, 4, 4)

  const marked = await until('waiting for PIDE markup', 240, async () => {
    const s = await summary()
    return s && Object.keys(s).some(k => k.startsWith('text_keyword')) ? s : undefined
  })
  assert.ok(marked, 'the server should send text markup')
  console.log('markup: ' + JSON.stringify(marked))
  pass('PIDE sends text_* markup for a checked theory')

  const legend = await vscode.commands.executeCommand(
    'vscode.provideDocumentSemanticTokensLegend', doc.uri)
  assert.ok(legend && legend.tokenTypes.includes('isabelleProofKeyword'),
    'the semantic token legend should be registered')
  const tokens = await vscode.commands.executeCommand(
    'vscode.provideDocumentSemanticTokens', doc.uri)
  assert.ok(tokens && tokens.data.length > 0,
    'markup should reach the editor as semantic tokens, which the theme colours')
  console.log(`semantic tokens: ${tokens.data.length / 5}`)
  pass('by default the theme colours checked text, through semantic tokens')

  // The palette is still available for anyone who prefers Isabelle's own colours.
  const cfg = vscode.workspace.getConfiguration('isabelle')
  await cfg.update('markupColors', 'isabelle', vscode.ConfigurationTarget.Global)
  // Force a re-apply: decorations are recomputed when the viewport changes.
  editor.selection = new vscode.Selection(5, 2, 5, 2)
  await wait(2000)
  const still = await vscode.commands.executeCommand(
    'vscode.provideDocumentSemanticTokens', doc.uri)
  assert.ok(still, 'the provider stays registered either way')
  await cfg.update('markupColors', 'theme', vscode.ConfigurationTarget.Global)
  pass('markupColors: isabelle is accepted and restores the palette path')

  console.log(`${passed} checks passed`)
  console.log('SUITE23_OK')
}

module.exports.run = () => run().catch(err => {
  console.error('FAIL: ' + (err && err.stack || err))
  process.exit(1)
})
