// Visual check: open a theory, let the renderer settle, and hold the window open
// long enough for an external screenshot of this window.
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const wait = ms => new Promise(r => setTimeout(r, ms))

const SAMPLE = [
  'theory Render',
  '  imports Main',
  'begin',
  '',
  'lemma one: "\\<forall>x. x \\<longrightarrow> x"',
  'lemma two: "\\<lambda>x. \\<exists>y. x \\<le> y \\<and> y \\<in> A"',
  'lemma three: "A \\<union> B \\<subseteq> C \\<Longrightarrow> \\<not> D"',
  'definition sq :: nat where "sq = x\\<^sub>1 + y\\<^sup>2"',
  'text \\<open>plain ASCII line with no symbols at all\\<close>',
  '',
  'end',
  '',
].join('\n')

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Render.thy')
  fs.writeFileSync(file, SAMPLE, 'utf8')

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  // Park the caret away from the symbols so nothing is revealed as raw text.
  editor.selection = new vscode.Selection(10, 0, 10, 0)
  await wait(2500)

  const deco = await vscode.commands.executeCommand('isabelle.decorationRanges')
  console.log('decorations: ' + JSON.stringify(deco))

  fs.writeFileSync(path.join(ws, '..', 'READY'), 'ready', 'utf8')
  console.log('READY_FOR_SCREENSHOT')
  await wait(20000)
  console.log('VISUAL_DONE')
}

module.exports = { run }
