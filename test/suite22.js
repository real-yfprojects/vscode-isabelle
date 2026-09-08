// Visual + live: PIDE markup under a NON-default colour theme.
// Before semantic tokens, checked text kept Isabelle's palette (which is Dark+/Light+),
// so installing a theme recoloured only the text PIDE had not reached.
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const wait = ms => new Promise(r => setTimeout(r, ms))

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Theme.thy')
  fs.writeFileSync(file, [
    'theory Theme', '  imports Main', 'begin', '',
    'definition twice :: "nat => nat" where',
    '  "twice n = n + n"', '',
    'lemma twice_zero: "twice 0 = 0"',
    '  unfolding twice_def by simp', '',
    'lemma twice_mono: "m <= n ==> twice m <= twice n"',
    '  unfolding twice_def by simp', '',
    'text \\<open>Prose with an antiquotation @{term "twice 3"} in it.\\<close>', '',
    'end', '',
  ].join('\n'), 'utf8')

  const cfg = vscode.workspace.getConfiguration()
  // A theme that is emphatically not Dark+, so "the theme applied" is unmistakable.
  await cfg.update('workbench.colorTheme', process.env.ISABELLE_TEST_THEME || 'Monokai',
    vscode.ConfigurationTarget.Global)
  await cfg.update('editor.semanticHighlighting.enabled', true, vscode.ConfigurationTarget.Global)

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  editor.selection = new vscode.Selection(8, 4, 8, 4)
  await wait(30000)

  const summary = await vscode.commands.executeCommand('isabelle.pideDecorationSummary')
  console.log('pide: ' + JSON.stringify(summary))
  const legend = await vscode.commands.executeCommand(
    'vscode.provideDocumentSemanticTokensLegend', doc.uri)
  console.log('legend: ' + (legend ? JSON.stringify(legend.tokenTypes) : 'none'))
  const tokens = await vscode.commands.executeCommand(
    'vscode.provideDocumentSemanticTokens', doc.uri)
  console.log('semantic tokens: ' + (tokens ? tokens.data.length / 5 : 'none'))

  fs.writeFileSync(path.join(ws, '..', 'READY'), 'ready', 'utf8')
  console.log('READY_FOR_SCREENSHOT')
  await wait(18000)
  console.log('VISUAL_DONE')
}
module.exports = { run }
