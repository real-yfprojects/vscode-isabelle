// Pure checks for word motion over rendered symbols.
//
// The failure being held down: editor.wordSeparators leaves out `\`, `<` and `>` so that
// `\<forall>` is one word, which also made `\<open>foo\<close>` one word -- Ctrl+Right
// from the start of a cartouche jumped over all of it, and Ctrl+Backspace after `foo`
// took the opening delimiter with it. Each symbol now counts as the single character it
// is drawn as, classed by what it means rather than how it is spelled.
const assert = require('assert')
const path = require('path')

const { CharClass, separatorClassifier, symbolClass, toUnits, wordLeft, wordEndRight,
        deleteWordLeftFrom, deleteWordRightTo } =
  require(path.join(__dirname, '..', 'out', 'words.js'))
const { SYMBOL_RE } = require(path.join(__dirname, '..', 'out', 'symbols.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

// The separators the extension ships for Isabelle files, not a copy of them.
const SEPARATORS = require(path.join(__dirname, '..', 'package.json'))
  .contributes.configurationDefaults['[isabelle]']['editor.wordSeparators']

/** Units for a line in which every symbol is rendered. */
function units(text) {
  const atoms = []
  SYMBOL_RE.lastIndex = 0
  let m
  while ((m = SYMBOL_RE.exec(text)) !== null) {
    atoms.push({ start: m.index, end: m.index + m[0].length, cls: symbolClass(m[0]) })
  }
  return toUnits(text, atoms, separatorClassifier(SEPARATORS))
}

/** Every stop of repeated Ctrl+Right (or Ctrl+Left) across the whole line. */
function stops(text, step, from) {
  const u = units(text)
  const out = []
  let at = from
  for (;;) {
    const next = step(u, at)
    if (next === at) return out
    out.push(next)
    at = next
  }
}

async function run() {
  // --- classification ---------------------------------------------------------------
  for (const s of ['\\<A>', '\\<z>', '\\<AA>', '\\<zz>', '\\<alpha>', '\\<Omega>', '\\<^sub>', '\\<^sup>']) {
    assert.strictEqual(symbolClass(s), CharClass.Regular, `${s} belongs inside a name`)
  }
  for (const s of ['\\<open>', '\\<close>', '\\<forall>', '\\<Longrightarrow>', '\\<lambda>',
                   '\\<Aa>', '\\<^bsub>', '\\<notasymbol>']) {
    assert.strictEqual(symbolClass(s), CharClass.Separator, `${s} stands on its own`)
  }
  pass('letters, Greek and sub/superscript join a name; delimiters and operators do not')

  // --- cartouches: the reported bug -------------------------------------------------
  //         0    5      12  15 16 19      27
  const cart = 'text \\<open>foo bar\\<close>'
  assert.deepStrictEqual(stops(cart, wordEndRight, 0), [4, 15, 19, 27],
    'Ctrl+Right stops after `text`, `‹foo`, `bar` and `›`')
  assert.deepStrictEqual(stops(cart, wordLeft, cart.length), [16, 12, 5, 0],
    'Ctrl+Left stops before `bar›`, `foo`, `‹` and `text`')
  pass('Ctrl+arrows stop at the words inside a cartouche, not at its ends')

  const u = units(cart)
  assert.strictEqual(deleteWordLeftFrom(u, 15), 12, 'Ctrl+Backspace after foo leaves ‹ alone')
  assert.strictEqual(deleteWordLeftFrom(u, 27), 19, 'Ctrl+Backspace after › removes only ›')
  assert.strictEqual(deleteWordRightTo(u, 12), 15, 'Ctrl+Delete before foo stops before the blank')
  assert.strictEqual(deleteWordRightTo(u, 16), 19, 'Ctrl+Delete before bar leaves › alone')
  pass('Ctrl+Backspace/Delete remove a word without the delimiter next to it')

  // A symbol is one character wide for the lone-separator rule, exactly as `"` is in
  // `"foo"`: Ctrl+Right from before ‹ lands after foo, not after ‹.
  const plain = 'text "foo bar"'
  assert.deepStrictEqual(stops(plain, wordEndRight, 0), [4, 9, 13, 14])
  pass('a cartouche stops where the same text in double quotes does')

  // --- names built from symbols -----------------------------------------------------
  //          0        9 10 12      20     27 28
  const names = 'x\\<^sub>1 = \\<alpha>\\<beta>\''
  assert.deepStrictEqual(stops(names, wordEndRight, 0), [9, 11, 28])
  assert.deepStrictEqual(stops(names, wordLeft, names.length), [12, 10, 0])
  pass('x\\<^sub>1 and \\<alpha>\\<beta>\' are single words')

  // --- operators --------------------------------------------------------------------
  const forall = '\\<forall>x. P x'
  assert.strictEqual(wordEndRight(units(forall), 0), 10, '∀ is skipped like `!` in `!x`, landing after x')
  const imp = 'A \\<Longrightarrow> B'
  assert.strictEqual(wordEndRight(units(imp), 1), 19, 'a free-standing ⟹ is a word of its own')
  const lam = '\\<lambda>x. x'
  assert.strictEqual(wordEndRight(units(lam), 0), 10, 'λ is the binder, not a letter')
  const pair = 'f \\<open>\\<close>'
  assert.strictEqual(wordEndRight(units(pair), 1), pair.length, 'adjacent delimiters form one run')
  pass('operator symbols are words of their own, merging with adjacent separators')

  // --- no symbols: the built-in's own rules -----------------------------------------
  const call = 'foo (bar) --> baz'
  assert.deepStrictEqual(stops(call, wordEndRight, 0), [3, 8, 9, 13, 17])
  assert.deepStrictEqual(stops(call, wordLeft, call.length), [14, 10, 5, 4, 0])
  pass('a line without symbols moves as VS Code moves it')

  assert.strictEqual(wordEndRight(units(''), 0), 0)
  assert.strictEqual(wordLeft(units('   '), 3), 0)
  pass('empty and blank lines')

  console.log(passed + ' checks passed')
  console.log('SUITE32_OK')
}

module.exports = { run }

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1) })
}
