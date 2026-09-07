// Reveal-at-cursor boundaries, selection extension, and navigation of escapes that
// are NOT rendered as a glyph.
//
// Where a case depends on a built-in command's effect, we assert on the *decision*
// (jump vs. delegate) via isabelle.atomicProbe instead: the test window runs
// unfocused, and built-ins racing a programmatically-set selection are unreliable
// there. The decision is the part this extension actually owns.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

async function open(name, lines) {
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, name)
  fs.writeFileSync(file, lines.join('\n'), 'utf8')
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  await wait(700)
  return { doc, editor }
}

const setCaret = async (editor, line, col) => {
  editor.selection = new vscode.Selection(line, col, line, col)
  await wait(300)
}
const glyphCount = async () =>
  (await vscode.commands.executeCommand('isabelle.decorationRanges')).withGlyph
const probe = dir => vscode.commands.executeCommand('isabelle.atomicProbe', dir)

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()

  // ==================== reveal boundaries ====================
  const { doc, editor } = await open('Reveal.thy', [
    'theory Reveal', '  imports Main', 'begin', '',
    'lemma q: "\\<forall>x. x \\<le> x"', '', 'end', '',
  ])
  const line = doc.lineAt(4).text
  const s = line.indexOf('\\<forall>')
  const e = s + '\\<forall>'.length
  console.log(`\\<forall> spans columns ${s}..${e} of ${JSON.stringify(line)}`)

  await setCaret(editor, 4, 0)
  const baseline = await glyphCount()
  assert.strictEqual(baseline, 2, 'both symbols decorated when the caret is away')

  await setCaret(editor, 4, s)
  assert.strictEqual(await glyphCount(), baseline,
    'caret ON the start boundary must NOT reveal')
  pass('caret at start boundary keeps the glyph')

  await setCaret(editor, 4, e)
  assert.strictEqual(await glyphCount(), baseline,
    'caret ON the end boundary must NOT reveal (glyph appears immediately after expansion)')
  pass('caret at end boundary keeps the glyph')

  await setCaret(editor, 4, s + 4)
  assert.strictEqual(await glyphCount(), baseline - 1,
    'caret strictly inside must reveal exactly that symbol')
  pass('caret strictly inside reveals the escape as raw text')

  // ==================== selection ====================
  editor.selection = new vscode.Selection(4, 0, 4, s)
  await wait(300)
  assert.strictEqual(await glyphCount(), baseline,
    'a selection ending exactly at the symbol start must not reveal it')
  pass('selection abutting a symbol keeps the glyph')

  editor.selection = new vscode.Selection(4, 0, 4, s + 3)
  await wait(300)
  assert.strictEqual(await glyphCount(), baseline - 1,
    'a selection overlapping the symbol must reveal it')
  pass('selection overlapping a symbol reveals it')

  await setCaret(editor, 4, e)
  await vscode.commands.executeCommand('isabelle.cursorLeftSelect')
  await wait(250)
  let sel = editor.selection
  console.log(`  shift+Left from ${e}: anchor=${sel.anchor.character} active=${sel.active.character} text=${JSON.stringify(doc.getText(sel))}`)
  assert.strictEqual(sel.anchor.character, e, 'anchor must stay put')
  assert.strictEqual(sel.active.character, s, 'active must jump to the escape start')
  assert.strictEqual(doc.getText(sel), '\\<forall>', 'the whole escape must be selected')
  pass('shift+Left selects \\<forall> as a single unit, anchor preserved')

  await setCaret(editor, 4, s)
  await vscode.commands.executeCommand('isabelle.cursorRightSelect')
  await wait(250)
  sel = editor.selection
  assert.strictEqual(doc.getText(sel), '\\<forall>', 'shift+Right must select the whole escape')
  assert.strictEqual(sel.active.character, e)
  assert.strictEqual(sel.anchor.character, s, 'anchor must stay at the start')
  pass('shift+Right selects \\<forall> as a single unit, anchor preserved')

  // ==================== motion decisions ====================
  await setCaret(editor, 4, e)
  let d = await probe('left')
  console.log(`  probe left @${e}: ${JSON.stringify(d)}`)
  assert.strictEqual(d.delegate, false, 'from the end boundary, Left must jump atomically')
  assert.strictEqual(d.target, s)
  assert.strictEqual(d.text, '\\<forall>')
  pass('decision: Left at the end boundary jumps over the whole escape')

  await setCaret(editor, 4, s)
  d = await probe('right')
  assert.strictEqual(d.delegate, false, 'from the start boundary, Right must jump atomically')
  assert.strictEqual(d.target, e)
  pass('decision: Right at the start boundary jumps over the whole escape')

  // Past the escape there is nothing to jump over: must fall through to the built-in.
  await setCaret(editor, 4, e)
  d = await probe('right')
  console.log(`  probe right @${e}: ${JSON.stringify(d)}`)
  assert.strictEqual(d.delegate, true,
    'moving right away from a symbol must delegate, not jump')
  pass('decision: moving away from a symbol delegates to the built-in')

  // A revealed symbol (caret strictly inside) must be walked per character.
  await setCaret(editor, 4, s + 4)
  d = await probe('left')
  console.log(`  probe left inside @${s + 4}: ${JSON.stringify(d)}`)
  assert.strictEqual(d.delegate, true,
    'a revealed symbol is shown as raw text, so motion inside it must be per character')
  pass('decision: a revealed symbol is navigated per character')

  // ==================== escapes with no glyph ====================
  // \<notasymbol> is not in etc/symbols, so it is never decorated. Navigation must match
  // what is displayed, or the text would be visible but unreachable by keyboard.
  const unknown = await open('Unknown.thy', [
    'theory Unknown', '  imports Main', 'begin', '',
    'text \\<open>\\<notasymbol> here\\<close>', '', 'end', '',
  ])
  const uline = unknown.doc.lineAt(4).text
  const us = uline.indexOf('\\<notasymbol>')
  const ue = us + '\\<notasymbol>'.length
  console.log(`\\<notasymbol> spans ${us}..${ue} of ${JSON.stringify(uline)}`)

  await setCaret(unknown.editor, 4, 0)
  const glyphs = (await vscode.commands.executeCommand('isabelle.decorationRanges')).glyphs
  console.log(`  glyphs on that line: ${JSON.stringify(glyphs)}`)
  assert.ok(glyphs.includes('‹'), 'the \\<open> cartouche should still be decorated')

  await setCaret(unknown.editor, 4, ue)
  d = await probe('left')
  console.log(`  probe left @${ue} (un-rendered escape): ${JSON.stringify(d)}`)
  assert.strictEqual(d.delegate, true,
    'an escape with no codepoint is displayed raw, so it must NOT be skipped atomically')
  pass('decision: un-rendered escapes are navigated per character, matching the display')

  // ...while a rendered one on the same line still is atomic.
  const os = uline.indexOf('\\<open>')
  const oe = os + '\\<open>'.length
  await setCaret(unknown.editor, 4, oe)
  d = await probe('left')
  assert.strictEqual(d.delegate, false, '\\<open> IS rendered, so it stays atomic')
  assert.strictEqual(d.target, os)
  pass('decision: a rendered escape on the same line remains atomic')

  console.log(`\n${passed} checks passed`)
  console.log('SUITE4_OK')
}

module.exports = { run }
