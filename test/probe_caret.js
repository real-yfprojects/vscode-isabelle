// Visual: does the glyph occupy exactly the escape's own columns?
//
// Selections are the instrument. Selecting only the space *before* a glyph, or only the
// space *after* it, must highlight one blank cell and leave the glyph outside. If either
// highlight swallows the glyph, its width is being attributed to the wrong column, which
// is what makes the caret appear to skip a space.
//
// The last line applies a plain underline decoration across the escape, to see whether an
// underline the editor draws over a range reaches the glyph at all -- the mechanism behind
// Ctrl+hover marking a name as clickable.
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const wait = ms => new Promise(r => setTimeout(r, ms))

const LINES = [
  'lemma a: "A \\<and> B"',   // select the escape
  'lemma b: "A \\<and> B"',   // select the space BEFORE
  'lemma c: "A \\<and> B"',   // select the space AFTER
  'lemma d: "A \\<and> B"',   // underline across the escape
]

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Caret.thy')
  const head = ['theory Caret', '  imports Main', 'begin', '']
  fs.writeFileSync(file, head.concat(LINES).concat(['', 'end', '']).join('\n'), 'utf8')
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  await wait(5000)

  const sels = []
  for (let i = 1; i < 4; i++) {
    const L = head.length + i
    const m = /\\<\^?[A-Za-z][A-Za-z0-9_']*>/.exec(LINES[i])
    const start = m.index
    const end = start + m[0].length
    if (i === 1) sels.push(new vscode.Selection(L, start, L, end))
    else if (i === 2) sels.push(new vscode.Selection(L, start - 1, L, start))
    else sels.push(new vscode.Selection(L, end, L, end + 1))
    console.log(`line ${i}: escape [${start},${end}) of ${JSON.stringify(LINES[i])}`)
  }
  editor.selections = sels

  const underline = vscode.window.createTextEditorDecorationType({ textDecoration: 'underline' })
  const L = head.length + 0
  const m = /\\<\^?[A-Za-z][A-Za-z0-9_']*>/.exec(LINES[0])
  editor.setDecorations(underline,
    [new vscode.Range(L, m.index, L, m.index + m[0].length)])
  await wait(4000)

  fs.writeFileSync(path.join(ws, '..', 'READY'), 'ready', 'utf8')
  console.log('READY_FOR_SCREENSHOT')
  await wait(25000)
  console.log('VISUAL_DONE')
}
module.exports = { run }
