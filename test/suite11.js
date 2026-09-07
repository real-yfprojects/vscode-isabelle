// Visual check: TextMate grammar highlighting and the Symbols category jump.
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const wait = ms => new Promise(r => setTimeout(r, ms))

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Syntax.thy')
  fs.writeFileSync(file, [
    'theory Syntax',
    '  imports Main',
    'begin',
    '',
    '(* a block comment, which the grammar scopes as comment.block.isabelle *)',
    '',
    'text \\<open>Prose in a cartouche, scoped as a string by the grammar.\\<close>',
    '',
    'definition two :: nat where "two = 2"',
    '',
    'lemma sets: "A \\<union> B \\<subseteq> C \\<Longrightarrow> \\<forall>x. x \\<in> A"',
    '  by auto',
    '',
    'end',
    '',
  ].join('\n'), 'utf8')

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  editor.selection = new vscode.Selection(13, 0, 13, 0)

  // Confirm the grammar is actually bound to this document.
  const scopes = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri)
  console.log('languageId: ' + doc.languageId + ', document symbols: ' + (scopes ? scopes.length : 'none'))

  // Give PIDE time to attach so grammar tokens and PIDE markup are both visible.
  await wait(25000)
  console.log('pide: ' + JSON.stringify(await vscode.commands.executeCommand('isabelle.pideDecorationSummary')))
  await vscode.commands.executeCommand('isabelle-symbols.focus')
  await wait(3000)

  fs.writeFileSync(path.join(ws, '..', 'READY'), 'ready', 'utf8')
  console.log('READY_FOR_SCREENSHOT')
  await wait(18000)
  console.log('VISUAL_DONE')
}

module.exports = { run }
