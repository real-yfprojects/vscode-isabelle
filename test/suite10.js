// Visual check for panel theming: run Sledgehammer, then hold the window open briefly
// so the Sledgehammer, State and Output panels can be screenshotted.
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
    'theory Theme',
    '  imports Main',
    'begin',
    '',
    'lemma demo: "P \\<longrightarrow> P"',
    '  apply (rule impI)',
    '  apply assumption',
    '  done',
    '',
    'end',
    '',
  ].join('\n'), 'utf8')

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  editor.selection = new vscode.Selection(5, 2, 5, 2)
  await wait(2500)

  await vscode.commands.executeCommand('isabelle-sledgehammer.focus')
  await wait(2500)
  await vscode.commands.executeCommand('isabelle.sledgehammer')

  const until = Date.now() + 60000
  while (Date.now() < until) {
    const s = await vscode.commands.executeCommand('isabelle.sledgehammerState')
    if (s && s.status === 'Finished' && s.output) break
    console.log(`  ...status=${JSON.stringify(s && s.status)} (${Math.round((until - Date.now()) / 1000)}s left)`)
    await wait(4000)
  }
  const s = await vscode.commands.executeCommand('isabelle.sledgehammerState')
  console.log('output: ' + String(s && s.output).replace(/\s+/g, ' ').slice(0, 200))

  fs.writeFileSync(path.join(ws, '..', 'READY'), 'ready', 'utf8')
  console.log('READY_FOR_SCREENSHOT')
  await wait(20000)
  console.log('VISUAL_DONE')
}

module.exports = { run }
