// Visual check for the jEdit-parity additions: Documentation panel and theory Preview.
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const wait = ms => new Promise(r => setTimeout(r, ms))

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Parity.thy')
  fs.writeFileSync(file, [
    'theory Parity',
    '  imports Main',
    'begin',
    '',
    'section \\<open>A small document\\<close>',
    '',
    'text \\<open>Prose, a symbol \\<forall>x, and a lemma below.\\<close>',
    '',
    'lemma trivial: "(1::nat) + 1 = 2"',
    '  by simp',
    '',
    'end',
    '',
  ].join('\n'), 'utf8')

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  editor.selection = new vscode.Selection(9, 2, 9, 2)
  await wait(20000)

  await vscode.commands.executeCommand('isabelle-documentation.focus')
  await wait(6000)
  await vscode.window.showTextDocument(doc, { preview: false })
  await wait(800)
  await vscode.commands.executeCommand('isabelle.previewSplit')
  await wait(8000)

  console.log('parity: ' + JSON.stringify(await vscode.commands.executeCommand('isabelle.jEditParityState')))
  fs.writeFileSync(path.join(ws, '..', 'READY'), 'ready', 'utf8')
  console.log('READY_FOR_SCREENSHOT')
  await wait(20000)
  console.log('VISUAL_DONE')
}

module.exports = { run }
