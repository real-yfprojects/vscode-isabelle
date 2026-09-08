// PIDE markup as semantic tokens: the mechanism that lets a colour theme apply to
// checked text. Pure -- no prover involved.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vscode = require('vscode')
const { TOKEN_MAP, TOKEN_TYPES, buildTokens } =
  require(path.join(__dirname, '..', 'out', 'semantic_tokens.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }
const R = (sl, sc, el, ec) => ({ range: new vscode.Range(sl, sc, el, ec) })

// Types VS Code knows without being told; anything else must be declared in package.json.
const STANDARD = new Set([
  'namespace', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'type', 'parameter',
  'variable', 'property', 'enumMember', 'decorator', 'event', 'function', 'method', 'macro',
  'label', 'comment', 'string', 'keyword', 'number', 'regexp', 'operator',
])

async function run() {
  // A custom token type that package.json does not declare gets no superType and no
  // scope mapping, so themes leave it uncoloured -- silently.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  const declared = new Set((pkg.contributes.semanticTokenTypes || []).map(t => t.id))
  const scoped = (pkg.contributes.semanticTokenScopes || [])[0].scopes
  for (const type of TOKEN_TYPES) {
    if (STANDARD.has(type)) continue
    assert.ok(declared.has(type), `${type} must be in contributes.semanticTokenTypes`)
    assert.ok(scoped[type] && scoped[type].length > 0,
      `${type} needs TextMate scopes, or themes without semantic rules ignore it`)
  }
  for (const t of pkg.contributes.semanticTokenTypes || []) {
    assert.ok(t.superType, `${t.id} needs a superType as a fallback`)
    assert.ok(TOKEN_TYPES.includes(t.id), `${t.id} is declared but never emitted`)
  }
  pass('every custom token type is declared with a superType and TextMate scopes')

  // `main` is Isabelle's plain-text colour. Emitting it would repaint every ordinary
  // character and defeat the point, so it must stay untokenised.
  assert.ok(!('main' in TOKEN_MAP), 'main must not be tokenised')
  const mainOnly = new Map([['text_main', { items: [R(0, 0, 0, 5)] }]])
  assert.deepStrictEqual(buildTokens(mainOnly, () => 80), [])
  pass('plain text is left for the theme to colour')

  // Unknown categories and non-text decorations are ignored rather than mismapped.
  const other = new Map([
    ['background_unprocessed1', { items: [R(0, 0, 0, 9)] }],
    ['text_no_such_category', { items: [R(1, 0, 1, 9)] }],
  ])
  assert.deepStrictEqual(buildTokens(other, () => 80), [])
  pass('backgrounds and unknown categories produce no tokens')

  // Semantic tokens cannot span lines; PIDE ranges routinely do.
  const spanning = new Map([['text_inner_quoted', { items: [R(2, 4, 4, 3)] }]])
  const split = buildTokens(spanning, line => (line === 3 ? 20 : 10))
  assert.deepStrictEqual(split.map(t => [t.line, t.char, t.length]),
    [[2, 4, 6], [3, 0, 20], [4, 0, 3]], JSON.stringify(split))
  assert.ok(split.every(t => t.type === 'string'))
  pass('multi-line ranges are cut at line ends')

  // Overlaps should not occur -- text colours come from Snapshot.select, which yields
  // disjoint infos -- but one would corrupt the delta encoding of every *later* token,
  // so the result has to stay well-formed whatever arrives. Document order wins.
  const overlapping = new Map([
    ['text_free', { items: [R(0, 0, 0, 10)] }],
    ['text_keyword1', { items: [R(0, 2, 0, 5)] }],
  ])
  const resolved = buildTokens(overlapping, () => 80)
  assert.strictEqual(resolved.length, 1, JSON.stringify(resolved))
  assert.strictEqual(resolved[0].type, 'variable', 'the token that starts first wins')
  // Starting together, the shorter one is the more specific markup.
  const tied = buildTokens(new Map([
    ['text_free', { items: [R(0, 0, 0, 10)] }],
    ['text_keyword1', { items: [R(0, 0, 0, 4)] }],
  ]), () => 80)
  assert.strictEqual(tied.length, 1)
  assert.strictEqual(tied[0].type, 'keyword')
  // Whatever the policy, the output must never overlap.
  for (const set of [resolved, tied]) {
    let end = -1
    for (const t of set) { assert.ok(t.char >= end, 'tokens must not overlap'); end = t.char + t.length }
  }
  pass('overlapping markup is reduced to a well-formed, non-overlapping sequence')

  // Ordering must be by position, since the encoding is a delta from the previous token.
  const many = new Map([
    ['text_comment1', { items: [R(5, 0, 5, 3)] }],
    ['text_free', { items: [R(1, 8, 1, 9), R(1, 0, 1, 4)] }],
    ['text_bound', { items: [R(3, 2, 3, 6)] }],
  ])
  const ordered = buildTokens(many, () => 80)
  const positions = ordered.map(t => [t.line, t.char])
  assert.deepStrictEqual(positions, [[1, 0], [1, 8], [3, 2], [5, 0]], JSON.stringify(positions))
  pass('tokens come out in document order across categories')

  console.log(`${passed} checks passed`)
  console.log('SUITE21_OK')
}

module.exports.run = () => run().catch(err => {
  console.error('FAIL: ' + (err && err.stack || err))
  process.exit(1)
})
