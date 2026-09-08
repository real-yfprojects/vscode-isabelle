// Probe: does VS Code's own symbol search see anything in an Isabelle theory?
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const wait = ms => new Promise(r => setTimeout(r, ms))

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Sym.thy')
  fs.writeFileSync(file, [
    'theory Sym', '  imports Main', 'begin', '',
    'definition myconst :: "nat => nat" where "myconst n = n + 1"', '',
    'lemma mylemma: "myconst n = n + 1"', '  unfolding myconst_def by simp', '',
    'end', '',
  ].join('\n'), 'utf8')
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  editor.selection = new vscode.Selection(6, 8, 6, 8)
  await wait(25000)

  const ds = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri)
  console.log('documentSymbol: ' + (ds ? JSON.stringify(ds.map(s => s.name)) : 'undefined'))

  for (const q of ['mylemma', 'myconst', '']) {
    const wsr = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', q)
    console.log(`workspaceSymbol(${JSON.stringify(q)}): ` +
      (wsr ? wsr.length + ' -> ' + JSON.stringify(wsr.slice(0, 5).map(s => s.name)) : 'undefined'))
  }
  console.log('SUITE18_OK')
}
module.exports = { run }
