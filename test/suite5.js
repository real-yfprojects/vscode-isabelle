// Does "sendback" reach us as a standard LSP code action, with no PIDE-specific code?
// Isabelle2025 exposed sendback via codeActionProvider, which vscode-languageclient
// wires up automatically -- so this should work without the extension doing anything.
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const wait = ms => new Promise(r => setTimeout(r, ms))

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Sendback.thy')
  fs.writeFileSync(file, [
    'theory Sendback',
    '  imports Main',
    'begin',
    '',
    'lemma trivial_goal: "(1::nat) + 1 = 2"',
    '  try0',
    '',
    'end',
    '',
  ].join('\n'), 'utf8')

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })

  // Park the caret on the try0 line so PIDE actually processes it.
  editor.selection = new vscode.Selection(5, 2, 5, 2)
  console.log('waiting for try0 to run...')

  const deadline = Date.now() + 180000
  let actions = []
  let diags = []
  while (Date.now() < deadline) {
    await wait(3000)
    diags = vscode.languages.getDiagnostics(doc.uri)
    const range = new vscode.Range(5, 2, 5, 6)
    actions = (await vscode.commands.executeCommand(
      'vscode.executeCodeActionProvider', doc.uri, range)) || []
    if (actions.length > 0) break
  }

  console.log(`\ndiagnostics on the file (${diags.length}):`)
  for (const d of diags) {
    console.log(`  line ${d.range.start.line + 1}: ${String(d.message).replace(/\s+/g, ' ').slice(0, 160)}`)
  }

  console.log(`\ncode actions offered at line 6 (${actions.length}):`)
  for (const a of actions) {
    const edit = a.edit
    let newText
    if (edit) {
      for (const [, edits] of edit.entries()) {
        if (edits.length) newText = edits[0].newText
      }
    }
    console.log(`  title=${JSON.stringify(a.title)} kind=${a.kind && a.kind.value} newText=${JSON.stringify(newText)}`)
  }

  console.log(actions.length > 0 ? '\nSENDBACK_PRESENT' : '\nSENDBACK_ABSENT')
  console.log('SUITE5_DONE')
}

module.exports = { run }
