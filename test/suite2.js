// Step 2 acceptance: symbol table, viewport rendering, input, normalisation, atomic motion.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
function pass(msg) { passed++; console.log('PASS: ' + msg) }

async function openScratch(name, content) {
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, name)
  fs.writeFileSync(file, content, 'utf8')
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  await wait(400)
  return { file, doc, editor }
}

/** Type one character at a time so the rewriter sees realistic single-char changes. */
async function typeText(editor, position, text) {
  let pos = position
  for (const ch of text) {
    await editor.edit(b => b.insert(pos, ch), { undoStopBefore: false, undoStopAfter: false })
    // the rewriter may have replaced \name with \<name>, so re-derive from the line end
    await wait(60)
    const line = editor.document.lineAt(pos.line)
    pos = new vscode.Position(pos.line, line.text.length)
    editor.selection = new vscode.Selection(pos, pos)
  }
  await wait(200)
  return editor.document.lineAt(position.line).text
}

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  assert.ok(ext)
  await ext.activate()

  // ---------- 1. symbol table from etc/symbols ----------
  const status = await vscode.commands.executeCommand('isabelle.serverState')
  console.log(`symbols loaded      : ${status.symbols}`)
  assert.ok(status.symbols > 400, `expected >400 symbols, got ${status.symbols}`)
  pass(`symbol table parsed from etc/symbols (${status.symbols} entries, no VSCodium needed)`)

  // ---------- 2. viewport rendering ----------
  const body = [
    'theory Scratch',
    '  imports Main',
    'begin',
    '',
    'lemma a: "\\<forall>x. x \\<longrightarrow> x"',
    '  by simp',
    '',
    'definition d :: nat where "d = 1"',
    '',
    'end',
    '',
  ].join('\n')
  const { editor } = await openScratch('Scratch.thy', body)

  let deco = await vscode.commands.executeCommand('isabelle.decorationRanges')
  console.log('decorations         : ' + JSON.stringify(deco))
  assert.ok(deco.withGlyph >= 2, `expected >=2 glyph substitutions, got ${deco.withGlyph}`)
  assert.ok(deco.glyphs.includes('∀'), `expected the forall glyph among ${deco.glyphs}`)
  assert.ok(deco.glyphs.includes('⟶'), `expected the longrightarrow glyph among ${deco.glyphs}`)
  pass('viewport decorations substitute the right glyphs, buffer untouched')
  assert.ok(editor.document.getText().includes('\\<forall>'), 'buffer must still hold ASCII escapes')
  pass('buffer still contains \\<forall> (disk stays build-valid)')

  // ---------- 3. reveal-at-cursor ----------
  const before = deco.withGlyph
  editor.selection = new vscode.Selection(4, 14, 4, 14) // inside \<forall>
  await wait(300)
  deco = await vscode.commands.executeCommand('isabelle.decorationRanges')
  assert.strictEqual(deco.withGlyph, before - 1,
    `caret inside a symbol should reveal exactly one escape (${before} -> ${deco.withGlyph})`)
  pass('the symbol under the caret is revealed as raw text for editing')
  editor.selection = new vscode.Selection(9, 0, 9, 0)
  await wait(200)

  // ---------- 4. control symbols render as sub/superscript ----------
  const ctl = await openScratch('Ctl.thy', [
    'theory Ctl', '  imports Main', 'begin', '',
    'definition x\\<^sub>1 :: nat where "x\\<^sub>1 = 1"',
    '', 'end', '',
  ].join('\n'))
  ctl.editor.selection = new vscode.Selection(6, 0, 6, 0)
  await wait(400)
  const cdeco = await vscode.commands.executeCommand('isabelle.decorationRanges')
  console.log('control decorations : ' + JSON.stringify(cdeco))
  assert.ok(cdeco.sub >= 2, `expected >=2 subscripted chars, got ${cdeco.sub}`)
  pass('control symbols render as subscripts (escape hidden, next char styled)')

  // ---------- 5. abbreviation rewriter ----------
  const scr = await openScratch('Type.thy', [
    'theory Type', '  imports Main', 'begin', '', '', 'end', '',
  ].join('\n'))
  let line = await typeText(scr.editor, new vscode.Position(4, 0), '\\forall')
  console.log('after typing \\forall: ' + JSON.stringify(line))
  assert.strictEqual(line, '\\<forall>', 'unambiguous name should expand immediately')
  pass('typing \\forall expands to the ASCII escape \\<forall>')

  // ---------- 6. ambiguous prefixes wait for a terminator ----------
  const scr2 = await openScratch('Type2.thy', [
    'theory Type2', '  imports Main', 'begin', '', '', 'end', '',
  ].join('\n'))
  line = await typeText(scr2.editor, new vscode.Position(4, 0), '\\subset')
  console.log('after typing \\subset: ' + JSON.stringify(line))
  assert.strictEqual(line, '\\subset',
    '\\subset must NOT expand early - \\<subseteq> extends it')
  pass('ambiguous prefix \\subset is held back (\\<subseteq> could still follow)')
  line = await typeText(scr2.editor, new vscode.Position(4, line.length), ' ')
  console.log('after terminator    : ' + JSON.stringify(line))
  assert.strictEqual(line, '\\<subset> ', 'a terminator should resolve the ambiguity')
  pass('typing a terminator expands the held-back abbreviation')

  // ---------- 7. save normalisation ----------
  const nrm = await openScratch('Norm.thy', [
    'theory Norm', '  imports Main', 'begin', '', '', 'end', '',
  ].join('\n'))
  await nrm.editor.edit(b => b.insert(new vscode.Position(4, 0), 'lemma z: "∀x. x = x"'))
  assert.ok(nrm.doc.getText().includes('∀'), 'precondition: buffer holds literal Unicode')
  await vscode.commands.executeCommand('workbench.action.files.save')
  await wait(1500)
  const onDisk = fs.readFileSync(nrm.file, 'utf8')
  console.log('disk after save     : ' + JSON.stringify(onDisk.split('\n')[4]))
  assert.ok(onDisk.includes('\\<forall>'), 'disk must hold the ASCII escape')
  assert.ok(!onDisk.includes('∀'), 'disk must not hold literal Unicode')
  pass('save participant normalised literal Unicode to \\<forall> on disk')

  // ---------- 8. atomic cursor motion ----------
  const atom = await openScratch('Atom.thy', [
    'theory Atom', '  imports Main', 'begin', '',
    'lemma q: "\\<forall>x. x = x"', '', 'end', '',
  ].join('\n'))
  const lineText = atom.doc.lineAt(4).text
  const symStart = lineText.indexOf('\\<forall>')
  const symEnd = symStart + '\\<forall>'.length
  atom.editor.selection = new vscode.Selection(4, symEnd, 4, symEnd)
  await wait(200)
  await vscode.commands.executeCommand('isabelle.cursorLeft')
  await wait(200)
  console.log(`cursorLeft          : ${symEnd} -> ${atom.editor.selection.active.character} (escape starts at ${symStart})`)
  assert.strictEqual(atom.editor.selection.active.character, symStart,
    'one left-arrow should jump over the whole escape')
  pass('left arrow steps over \\<forall> as a single unit')

  await vscode.commands.executeCommand('isabelle.cursorRight')
  await wait(200)
  assert.strictEqual(atom.editor.selection.active.character, symEnd,
    'one right-arrow should jump back over the whole escape')
  pass('right arrow steps over \\<forall> as a single unit')

  // ---------- 9. atomic deletion ----------
  atom.editor.selection = new vscode.Selection(4, symEnd, 4, symEnd)
  await wait(150)
  await vscode.commands.executeCommand('isabelle.deleteLeft')
  await wait(300)
  const after = atom.doc.lineAt(4).text
  console.log('after deleteLeft    : ' + JSON.stringify(after))
  assert.ok(!after.includes('\\<forall>'), 'backspace should remove the whole escape')
  assert.strictEqual(after, lineText.replace('\\<forall>', ''), 'only the escape should be gone')
  pass('backspace deletes \\<forall> as a single unit')

  console.log(`\n${passed} checks passed`)
  console.log('STEP2_OK')
}

module.exports = { run }
