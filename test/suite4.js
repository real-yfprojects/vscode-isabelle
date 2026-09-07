// How aggressive is reveal-at-cursor, and does it interact with atomic motion?
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const wait = ms => new Promise(r => setTimeout(r, ms))

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Reveal.thy')
  fs.writeFileSync(file, [
    'theory Reveal', '  imports Main', 'begin', '',
    'lemma q: "\\<forall>x. x \\<le> x"', '', 'end', '',
  ].join('\n'), 'utf8')

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  await wait(1200)

  const line = doc.lineAt(4).text
  const s = line.indexOf('\\<forall>')
  const e = s + '\\<forall>'.length
  console.log(`line 5: ${JSON.stringify(line)}`)
  console.log(`\\<forall> occupies columns ${s}..${e}`)

  const probe = async (label, col) => {
    editor.selection = new vscode.Selection(4, col, 4, col)
    await wait(350)
    const d = await vscode.commands.executeCommand('isabelle.decorationRanges')
    console.log(`  caret col ${String(col).padEnd(3)} ${label.padEnd(28)} withGlyph=${d.withGlyph} glyphs=${JSON.stringify(d.glyphs)}`)
    return d.withGlyph
  }

  console.log('\n--- reveal behaviour ---')
  const away = await probe('far away (baseline)', 0)
  const atStart = await probe('exactly AT start boundary', s)
  const inside = await probe('strictly inside', s + 4)
  const atEnd = await probe('exactly AT end boundary', e)
  const after = await probe('one past the end', e + 1)

  console.log('\n--- verdict ---')
  console.log(`baseline decorated symbols : ${away}`)
  console.log(`touching start boundary    : ${atStart}  ${atStart < away ? '=> REVEALS on touch' : '=> stays a glyph'}`)
  console.log(`strictly inside            : ${inside}  ${inside < away ? '=> REVEALS' : '=> stays a glyph'}`)
  console.log(`touching end boundary      : ${atEnd}  ${atEnd < away ? '=> REVEALS on touch' : '=> stays a glyph'}`)
  console.log(`one column past            : ${after}  ${after < away ? '=> REVEALS' : '=> stays a glyph'}`)

  // Can atomic motion ever place the caret strictly inside a symbol?
  console.log('\n--- atomic motion: where does the caret actually land? ---')
  editor.selection = new vscode.Selection(4, e, 4, e)
  await wait(200)
  await vscode.commands.executeCommand('isabelle.cursorLeft')
  await wait(200)
  const landed = editor.selection.active.character
  console.log(`  from col ${e}, one Left -> col ${landed} (symbol spans ${s}..${e})`)
  console.log(`  strictly inside? ${landed > s && landed < e}`)

  fs.writeFileSync(path.join(ws, '..', 'READY'), 'ready', 'utf8')
  console.log('\nREADY_FOR_SCREENSHOT')
  await wait(18000)
  console.log('REVEAL_DONE')
}

module.exports = { run }
