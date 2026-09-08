// Visual: selections covering exactly the escape ranges. If the highlight also covers the
// preceding space, the caret is being *drawn* in the wrong place even though its offset is
// right -- which is what "jumps over a preceding whitespace" would look like.
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const wait = ms => new Promise(r => setTimeout(r, ms))

const LINES = [
  'lemma a: "A \\<and> B"',
  'lemma b: "A \\<and> B"',
  'lemma c: "xx \\<forall> yy"',
  'lemma d: "xx \\<forall> yy"',
  'lemma e: "A \\<and> B"',
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

  // Lines 0 and 2: select the escape itself. Lines 1 and 3: select the space before it.
  const sels = []
  for (let i = 0; i < LINES.length; i++) {
    const L = head.length + i
    const text = LINES[i]
    const m = /\\<\^?[A-Za-z][A-Za-z0-9_']*>/.exec(text)
    const start = m.index
    const end = m.index + m[0].length
    if (i % 2 === 0) sels.push(new vscode.Selection(L, start, L, end))
    else sels.push(new vscode.Selection(L, start - 1, L, start))
    console.log(`line ${i}: escape [${start},${end}) of ${JSON.stringify(text)}`)
  }
  editor.selections = sels

  // Isolate the CSS question behind Ctrl+hover: any underline the editor draws over a
  // range must reach the glyph, not only the (invisible) escape text beneath it.
  const underline = vscode.window.createTextEditorDecorationType({ textDecoration: 'underline' })
  const last = head.length + LINES.length - 1
  editor.setDecorations(underline,
    [new vscode.Range(last, 10, last, LINES[LINES.length - 1].length)])
  await wait(4000)

  fs.writeFileSync(path.join(ws, '..', 'READY'), 'ready', 'utf8')
  console.log('READY_FOR_SCREENSHOT')
  await wait(15000)
  console.log('VISUAL_DONE')
}
module.exports = { run }
