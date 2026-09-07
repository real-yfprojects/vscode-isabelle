// Visual check for the ported UI: markup colouring, State panel, Symbols palette.
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const wait = ms => new Promise(r => setTimeout(r, ms))

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Panels.thy')
  fs.writeFileSync(file, [
    'theory Panels',
    '  imports Main',
    'begin',
    '',
    'text \\<open>Markup colouring, symbols and panels together.\\<close>',
    '',
    'lemma q: "P \\<longrightarrow> P"',
    '  apply (rule impI)',
    '  apply assumption',
    '  done',
    '',
    'definition sq :: nat where "sq = x\\<^sub>1 + y\\<^sup>2"',
    '',
    'lemma sets: "A \\<union> B \\<subseteq> C \\<Longrightarrow> \\<not> D \\<or> \\<forall>x. x \\<in> A"',
    '  by auto',
    '',
    'end',
    '',
  ].join('\n'), 'utf8')

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  editor.selection = new vscode.Selection(7, 2, 7, 2)   // inside the proof
  await wait(2000)

  await vscode.commands.executeCommand('isabelle-output.focus')
  await wait(2000)
  await vscode.commands.executeCommand('isabelle-state.focus')
  await wait(3000)
  editor.selection = new vscode.Selection(7, 2, 7, 2)
  await vscode.commands.executeCommand('isabelle.stateUpdate')
  await wait(6000)

  console.log('decorations: ' +
    JSON.stringify(await vscode.commands.executeCommand('isabelle.pideDecorationSummary')))

  fs.writeFileSync(path.join(ws, '..', 'READY'), 'ready', 'utf8')
  console.log('READY_FOR_SCREENSHOT')
  await wait(22000)

  // Second shot: the Symbols palette.
  await vscode.commands.executeCommand('isabelle-symbols.focus')
  await wait(2500)
  fs.writeFileSync(path.join(ws, '..', 'READY2'), 'ready', 'utf8')
  console.log('READY_FOR_SCREENSHOT_2')
  await wait(20000)
  console.log('VISUAL_DONE')
}

module.exports = { run }
