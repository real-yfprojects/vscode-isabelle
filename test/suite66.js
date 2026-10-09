// Pure checks for find in a panel (src/find_bar.ts) -- no prover, no editor.
//
// What is held down: a plain query is text, not a pattern, and its spaces match wherever
// Isabelle broke the line; case and regular expressions are the reader's choice; a pattern
// that does not compile says so instead of throwing; and the script the page runs, which
// carries findMatches by its source text, is still a script.
const assert = require('assert')
const path = require('path')

const { findMatches, FIND_SCRIPT, FIND_BAR_HTML, FIND_LIMIT } =
  require(path.join(__dirname, '..', 'out', 'find_bar.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

const spans = (text, query, options = {}, limit = FIND_LIMIT) =>
  findMatches(text, query, options, limit).matches.map(([s, e]) => text.slice(s, e))

async function run() {
  // --- plain text -----------------------------------------------------------------
  const classes = 'class ord =\n  fixes less_eq :: "\'a ⇒ \'a ⇒ bool"\nclass order = preorder +\n  Ord'
  assert.deepStrictEqual(spans(classes, 'ord'), ['ord', 'ord', 'ord', 'Ord'], 'case is ignored by default')
  assert.deepStrictEqual(spans(classes, 'ord', { caseSensitive: true }), ['ord', 'ord', 'ord'])
  assert.deepStrictEqual(findMatches(classes, '', {}, FIND_LIMIT), { matches: [], capped: false })
  pass('a plain query matches anywhere, ignoring case unless asked')

  assert.deepStrictEqual(spans('a + b * (c)', '(c)'), ['(c)'])
  assert.deepStrictEqual(spans('x.y xzy', 'x.y'), ['x.y'], 'a dot is a dot')
  assert.deepStrictEqual(spans('a\\b $x', '\\b $x'), ['\\b $x'])
  pass('a plain query is text, not a pattern')

  assert.deepStrictEqual(spans('\'a ⇒\n    \'b', '\'a ⇒ \'b'), ['\'a ⇒\n    \'b'])
  assert.deepStrictEqual(spans('less_eq  x', 'less_eq x'), ['less_eq  x'])
  pass('a space matches a line break or indentation, wherever the margin put one')

  // --- regular expressions --------------------------------------------------------
  assert.deepStrictEqual(spans(classes, 'class \\w+', { regex: true }), ['class ord', 'class order'])
  assert.deepStrictEqual(spans('aaa', 'x*', { regex: true }), [], 'empty matches are skipped, not looped on')
  assert.deepStrictEqual(spans('a-b', 'a\\-b', { regex: true }), ['a-b'],
    'a pattern that only compiles without the u flag still works')
  const bad = findMatches('abc', '(', { regex: true }, FIND_LIMIT)
  assert.ok(bad.error && bad.matches.length === 0, 'an unbalanced pattern reports an error')
  pass('regular expressions, on request')

  // --- symbols outside the BMP ----------------------------------------------------
  assert.deepStrictEqual(spans('𝔄 x 𝔄', '𝔄'), ['𝔄', '𝔄'])
  assert.deepStrictEqual(spans('𝔄', '^.$', { regex: true }), ['𝔄'], 'one symbol is one character')
  pass('symbols outside the BMP are single characters')

  // --- the cap --------------------------------------------------------------------
  const many = findMatches('aaaaa', 'a', {}, 3)
  assert.strictEqual(many.matches.length, 3)
  assert.ok(many.capped)
  assert.ok(!findMatches('aaa', 'a', {}, 3).capped, 'exactly the limit is not capped')
  pass('matches stop at the limit and say so')

  // --- the page's script ----------------------------------------------------------
  assert.doesNotThrow(() => new Function(FIND_SCRIPT), 'FIND_SCRIPT parses')
  assert.ok(FIND_SCRIPT.includes('function findMatches('), 'it carries findMatches')
  for (const id of ['find', 'find-input', 'find-count', 'find-case', 'find-regex', 'find-prev',
                    'find-next', 'find-close']) {
    assert.ok(FIND_BAR_HTML.includes(`id="${id}"`), `the bar has #${id}`)
    assert.ok(FIND_SCRIPT.includes(`'${id}'`), `the script looks up #${id}`)
  }
  assert.ok(!/data-command/.test(FIND_BAR_HTML),
    'the bar\'s buttons are not panel commands, which the page would post to the extension')
  pass('the page\'s script parses and finds the bar it is given')

  console.log(`\n${passed} checks passed`)
  console.log('SUITE66_OK')
}

module.exports = { run }

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1) })
}
