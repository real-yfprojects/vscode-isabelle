// Visual: Outline view and the sticky header, scrolled into a locale.
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const wait = ms => new Promise(r => setTimeout(r, ms))

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Outline.thy')
  const lines = ['theory Outline', '  imports Main', 'begin', '']
  lines.push('section \\<open>Groups\\<close>', '')
  lines.push('definition unit_elem :: nat where "unit_elem = 0"', '')
  lines.push('locale monoid =', '  fixes f :: "nat => nat => nat"', 'begin', '')
  for (let i = 1; i <= 12; i++) {
    lines.push(`lemma step_${i}: "(${i}::nat) + 0 = ${i}"`, '  by simp', '')
  }
  lines.push('end', '')
  lines.push('subsection \\<open>Consequences\\<close>', '')
  lines.push('lemma after: "(1::nat) + 1 = 2"', '  by simp', '', 'end', '')
  fs.writeFileSync(file, lines.join('\n'), 'utf8')

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  editor.selection = new vscode.Selection(30, 2, 30, 2)
  editor.revealRange(new vscode.Range(30, 0, 40, 0), vscode.TextEditorRevealType.AtTop)
  await vscode.commands.executeCommand('outline.focus')
  await wait(18000)

  fs.writeFileSync(path.join(ws, '..', 'READY'), 'ready', 'utf8')
  console.log('READY_FOR_SCREENSHOT')
  await wait(18000)
  console.log('VISUAL_DONE')
}
module.exports = { run }
