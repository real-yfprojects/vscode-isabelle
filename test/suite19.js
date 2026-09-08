// Theory outline: the structure behind Ctrl+Shift+O, breadcrumbs, folding and the
// sticky header. Pure -- no prover involved.
const assert = require('assert')
const path = require('path')
const { buildOutline, scanCommands, nameAfter, headingText, enclosing } =
  require(path.join(__dirname, '..', 'out', 'outline.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }
const names = nodes => nodes.map(n => n.name)

async function run() {
  // Names: the forms that actually occur, including ones a naive /^lemma (\w+)/ misses.
  assert.strictEqual(nameAfter(' foo: "P"'), 'foo')
  assert.strictEqual(nameAfter(' foo [simp]: "P"'), 'foo')
  assert.strictEqual(nameAfter(" 'a tree = Leaf | Node"), 'tree')
  assert.strictEqual(nameAfter(" ('a, 'b) either = L | R"), 'either')
  assert.strictEqual(nameAfter(' myconst :: "nat => nat" where'), 'myconst')
  // Anonymous goals must not be named after the word that follows them.
  assert.strictEqual(nameAfter(' "P --> P"'), undefined)
  assert.strictEqual(nameAfter(' assumes a: "P" shows "P"'), undefined)
  assert.strictEqual(nameAfter(''), undefined)
  pass('declared names are read from every common command form')

  assert.strictEqual(headingText(' \\<open>A small document\\<close>'), 'A small document')
  assert.strictEqual(headingText(' "Quoted heading"'), 'Quoted heading')
  pass('heading text is read from cartouches and strings')

  // The point of scanning rather than matching: prose is where "lemma" occurs most.
  const tricky = [
    'theory T',
    '  imports Main',
    'begin',
    '',
    'text \\<open>',
    '  A paragraph that says lemma and section and even',
    '  a nested \\<open>cartouche\\<close> before it ends.',
    '\\<close>',
    '',
    '(* a comment mentioning',
    '   definition and datatype *)',
    '',
    'lemma real_one: "P --> P"',
    '  by simp',
    '',
    'end',
    '',
  ].join('\n')
  const found = scanCommands(tricky).map(c => c.command)
  assert.ok(found.includes('lemma'), 'the real command must be found: ' + found)
  assert.ok(!found.includes('definition'), 'a command named in a comment is not a command')
  assert.ok(!found.includes('section'), 'a command named in prose is not a command')
  const outline = buildOutline(tricky, tricky.split('\n').length)
  assert.deepStrictEqual(names(outline), ['theory T', 'lemma real_one'])
  pass('commands inside comments and cartouches are not mistaken for structure')

  // Nesting: headings contain items, and a locale contains its own.
  const structured = [
    'theory S',                     // 0
    '  imports Main',               // 1
    'begin',                        // 2
    '',                             // 3
    'section \\<open>First\\<close>', // 4
    '',                             // 5
    'definition d where "d = 1"',   // 6
    '',                             // 7
    'locale L =',                   // 8
    '  fixes x',                    // 9
    'begin',                        // 10
    '',                             // 11
    'lemma inner: "x = x" by simp',  // 12
    '',                             // 13
    'end',                          // 14
    '',                             // 15
    'subsection \\<open>Deeper\\<close>', // 16
    '',                             // 17
    'lemma outer: "True" by simp',  // 18
    '',                             // 19
    'end',                          // 20
  ].join('\n')
  const tree = buildOutline(structured, 21)
  assert.deepStrictEqual(names(tree), ['theory S', 'First'])
  const section = tree[1]
  assert.deepStrictEqual(names(section.children), ['definition d', 'locale L', 'Deeper'])
  assert.deepStrictEqual(names(section.children[1].children), ['lemma inner'],
    'a locale must own the lemmas between its begin and end')
  assert.deepStrictEqual(names(section.children[2].children), ['lemma outer'])
  pass('headings, blocks and items nest the way the source does')

  // Ranges drive folding and the sticky header, so they must actually close.
  assert.strictEqual(section.children[1].line, 8)
  assert.strictEqual(section.children[1].endLine, 15,
    'the locale must end before the subsection, not run to the end of the file')
  assert.strictEqual(section.endLine, 20)
  pass('node ranges close at the next sibling rather than at the end of file')

  // Sticky scroll asks what encloses the first visible line.
  assert.deepStrictEqual(names(enclosing(tree, 12)), ['First', 'locale L', 'lemma inner'])
  assert.deepStrictEqual(names(enclosing(tree, 18)), ['First', 'Deeper', 'lemma outer'])
  assert.deepStrictEqual(names(enclosing(tree, 1)), ['theory S'])
  pass('enclosing nodes are what a sticky header should show')

  // Sticky scroll: registering an outline provider CHANGED which lines VS Code makes
  // sticky (editor.stickyScroll.defaultModel prefers the outline over indentation), so
  // the viewport model has to follow it or the sticky header goes back to being partly
  // coloured -- the bug that produced viewport.ts in the first place.
  const vscode = require('vscode')
  const { stickyLines } = require(path.join(__dirname, '..', 'out', 'viewport.js'))
  const doc = await vscode.workspace.openTextDocument({ content: structured, language: 'isabelle' })
  // Line 12 is `lemma inner` inside `locale L` inside `section First`.
  assert.deepStrictEqual(stickyLines(doc, 12), [4, 8],
    'the section and the locale enclose line 12 and both start above it')
  assert.deepStrictEqual(stickyLines(doc, 13), [4, 8, 12],
    'once past the lemma line it becomes sticky too')
  assert.deepStrictEqual(stickyLines(doc, 0), [], 'nothing is sticky at the top')
  pass('sticky lines follow the outline, which is the model VS Code now uses')

  // A theory with no structure must still get a header rather than nothing.
  const flatDoc = await vscode.workspace.openTextDocument({
    content: 'begin\n  a\n    b\n      c\n', language: 'isabelle',
  })
  assert.deepStrictEqual(stickyLines(flatDoc, 3), [0, 1, 2],
    'with no outline nodes the indentation model still applies')
  pass('indentation remains the fallback when a document has no structure')

  console.log(`${passed} checks passed`)
  console.log('SUITE19_OK')
}

module.exports.run = () => run().catch(err => {
  console.error('FAIL: ' + (err && err.stack || err))
  process.exit(1)
})
