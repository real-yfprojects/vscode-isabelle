// `\` shorthands in a real editor, typed through VS Code's own typing path (the `type`
// command), so auto-closed brackets and the rewriter's edits interleave as they do for a
// user. No prover: the symbol table, the rewriter, the hover and the completion list are
// all client-side.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

const LINE = 4

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Shorth.thy')
  fs.writeFileSync(file, ['theory Shorth', '  imports Main', 'begin', '', '', '', 'end', ''].join('\n'))
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  await wait(500)

  const state = () => vscode.commands.executeCommand('isabelle.shorthandsState')

  /* Wait for the rewriter instead of sleeping a fixed time: it answers a keystroke with an
     edit of its own, a round trip that takes much longer on a CI machine shared with a
     prover. Typing on before it lands makes VS Code drop the edit as stale, so a sleep
     that is too short both misses the expansion and loses it for good. Settled means no
     edit in flight and the document unchanged across two polls. */
  async function settle() {
    const deadline = Date.now() + 10_000
    let version = -1
    for (;;) {
      if ((await state()).rewritesInFlight === 0 && doc.version === version) return
      if (Date.now() > deadline) throw new Error('the shorthand rewriter did not settle within 10 s')
      version = doc.version
      await wait(25)
    }
  }

  /* Type one character and wait until this document has it. The `type` command goes to
     whichever editor has focus, and this copy of the document hears of the change by a
     message of its own, so neither the command returning nor a quiet moment says the
     character is in. On Windows CI a line once read `x\` after typing `x\_1`. A keystroke
     that never arrives means focus was elsewhere: say where, refocus, and type it again. */
  async function keystroke(ch) {
    for (let tries = 0; tries < 2; tries++) {
      const before = doc.version
      await vscode.commands.executeCommand('type', { text: ch })
      for (const deadline = Date.now() + 5_000; doc.version === before && Date.now() < deadline;) {
        await wait(25)
      }
      if (doc.version !== before) return
      const active = vscode.window.activeTextEditor
      console.log(`keystroke ${JSON.stringify(ch)} did not reach the document; the active editor ` +
        `was ${active ? active.document.uri.toString() : 'none'}; refocusing`)
      await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false })
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')
    }
    throw new Error(`keystroke ${JSON.stringify(ch)} never reached the document`)
  }

  /** Clear the probe line, then type `text` one character at a time. */
  async function type(text) {
    await editor.edit(b => b.replace(doc.lineAt(LINE).range, ''))
    const start = new vscode.Position(LINE, 0)
    await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false })
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')
    editor.selection = new vscode.Selection(start, start)
    const rejected = (await state()).rewritesRejected
    for (const ch of text) {
      await keystroke(ch)
      await settle()
    }
    // Cannot happen while each keystroke waits; if it does, say so instead of a bare diff.
    assert.strictEqual((await state()).rewritesRejected, rejected,
      `a rewrite was dropped as stale while typing ${JSON.stringify(text)}`)
    return { line: doc.lineAt(LINE).text, caret: editor.selection.active.character }
  }

  let r = await type('\\forall')
  if (r.line !== '\\<forall>') console.log('document now: ' + JSON.stringify(doc.getText()))
  assert.strictEqual(r.line, '\\<forall>', 'an Isabelle name still expands at once')
  pass('\\forall -> \\<forall>, as before')

  r = await type('\\all x')
  assert.strictEqual(r.line, '\\<forall> x')
  r = await type('\\ne ')
  assert.strictEqual(r.line, '\\<noteq> ', '\\ne waits (\\neg, \\neq ...) and expands on the blank')
  r = await type('\\iff')
  assert.strictEqual(r.line, '\\<longleftrightarrow>')
  pass('aliases: \\all, \\ne (on a terminator), \\iff')

  r = await type('\\<->')
  assert.strictEqual(r.line, '\\<longleftrightarrow>', '\\<-> is a key, though it starts like an escape')
  r = await type('\\<- ')
  assert.strictEqual(r.line, '\\<leftarrow> ', '\\<- waits for \\<-> and expands on the blank')
  r = await type('\\==>')
  assert.strictEqual(r.line, '\\<Longrightarrow>')
  pass('punctuation keys: \\<->, \\<-, \\==>')

  r = await type('\\<forall>')
  assert.strictEqual(r.line, '\\<forall>', 'a raw escape typed by hand is left alone')
  r = await type('x\\_1')
  assert.strictEqual(r.line, 'x\\<^sub>1')
  pass('raw escapes are untouched; \\_1 gives a subscript')

  r = await type('\\[[')
  console.log(`after \\[[: ${JSON.stringify(r)}`)
  assert.strictEqual(r.line, '\\<lbrakk>\\<rbrakk>', 'the brackets VS Code closed go with the key')
  assert.strictEqual(r.caret, '\\<lbrakk>'.length, 'the caret sits between the halves')
  await keystroke('A')
  await settle()
  assert.strictEqual(doc.lineAt(LINE).text, '\\<lbrakk>A\\<rbrakk>')
  r = await type('\\<>')
  assert.strictEqual(r.line, '\\<langle>\\<rangle>')
  assert.strictEqual(r.caret, '\\<langle>'.length)
  pass('pairs: \\[[ and \\<> leave the caret inside')

  // ---------- hover: every way to type the symbol under the mouse ----------
  await editor.edit(b => b.replace(doc.lineAt(LINE).range, 'x \\<forall>y'))
  await wait(150)
  const hovers = await vscode.commands.executeCommand(
    'vscode.executeHoverProvider', doc.uri, new vscode.Position(LINE, 5))
  const text = (hovers || []).flatMap(h => h.contents).map(c => c.value ?? String(c)).join('\n')
  console.log('hover: ' + JSON.stringify(text))
  assert.ok(text.includes('`\\forall`') && text.includes('`\\all`') && text.includes('`ALL`'),
    'the hover lists the name, the shorthand and the ASCII abbrev')
  pass('hovering a symbol shows how to type it')

  // ---------- completion: shorthands are listed with their result ----------
  await editor.edit(b => b.replace(doc.lineAt(LINE).range, '\\al'))
  await wait(100)
  const list = await vscode.commands.executeCommand(
    'vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(LINE, 3))
  const all = list.items.find(i => (typeof i.label === 'string' ? i.label : i.label.label) === '\\all')
  assert.ok(all, 'the \\all shorthand should be offered for \\al')
  assert.ok(all.detail.includes('∀'), `detail shows the glyph: ${all.detail}`)
  await editor.edit(b => b.replace(doc.lineAt(LINE).range, '\\[['))
  const pairs = await vscode.commands.executeCommand(
    'vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(LINE, 3))
  const brakk = pairs.items.find(i => (typeof i.label === 'string' ? i.label : i.label.label) === '\\[[')
  assert.ok(brakk && brakk.insertText instanceof vscode.SnippetString, 'a pair completes as a snippet')
  assert.strictEqual(brakk.insertText.value, '\\\\<lbrakk>$0\\\\<rbrakk>')
  pass('shorthands appear in the completion list, pairs as snippets')

  // ---------- custom shorthands ----------
  const cfg = vscode.workspace.getConfiguration('isabelle')
  await cfg.update('input.customShorthands', { cup: '∪' }, vscode.ConfigurationTarget.Global)
  // The extension hears of the new setting by an event of its own, some time after this.
  for (const deadline = Date.now() + 10_000; !(await state()).keys.includes('cup');) {
    if (Date.now() > deadline) throw new Error('the custom shorthand never took effect')
    await wait(25)
  }
  r = await type('\\cup')
  assert.strictEqual(r.line, '\\<union>', 'a custom shorthand written with a glyph types the escape')
  await cfg.update('input.customShorthands', undefined, vscode.ConfigurationTarget.Global)
  pass('custom shorthands from settings, glyph stored as escape')

  await editor.edit(b => b.replace(doc.lineAt(LINE).range, ''))
  await doc.save()
  console.log(passed + ' checks passed')
  console.log('SUITE35_OK')
}

module.exports = { run }
