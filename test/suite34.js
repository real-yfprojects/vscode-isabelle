// Pure checks for the `\` shorthands (src/shorthands.ts) against the real etc/symbols.
//
// What is held down: Isabelle's own names win over Lean-style aliases, a key waits while a
// longer one is reachable, pairs carry the caret position, custom entries may be written
// with glyphs but always produce ASCII escapes.
const assert = require('assert')
const path = require('path')
const fs = require('fs')

const { SymbolTable } = require(path.join(__dirname, '..', 'out', 'symbols.js'))
const { Shorthands, typedKey, autoClosers } = require(path.join(__dirname, '..', 'out', 'shorthands.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

function isabelleHome() {
  const candidates = [process.env.ISABELLE_PATCHED_HOME, process.env.ISABELLE_HOME,
    'C:/Users/yanni/Isabelle/Isabelle2025-2', 'C:/Users/yanni/Isabelle/Isabelle2025-2-query']
  return candidates.find(h => h && fs.existsSync(path.join(h, 'etc', 'symbols')))
}

async function run() {
  const home = isabelleHome()
  if (!home) {
    console.log('SKIP: no Isabelle with etc/symbols found (set ISABELLE_HOME)')
    console.log('SUITE34_SKIPPED')
    return
  }
  const table = SymbolTable.load(home)
  const s = new Shorthands(table)
  const plain = k => { const e = s.lookup(k); return e && !e.after ? e.before : e }

  // --- aliases, by meaning in Isabelle --------------------------------------------------
  assert.strictEqual(plain('all'), '\\<forall>')
  assert.strictEqual(plain('ex'), '\\<exists>')
  assert.strictEqual(plain('ne'), '\\<noteq>')
  assert.strictEqual(plain('iff'), '\\<longleftrightarrow>')
  assert.strictEqual(plain('to'), '\\<Rightarrow>', 'to is the HOL function type, not \\<rightarrow>')
  assert.strictEqual(plain('imp'), '\\<longrightarrow>')
  assert.strictEqual(plain('la'), '\\<lambda>')
  assert.strictEqual(plain('|-'), '\\<turnstile>')
  pass('aliases expand to the Isabelle symbol of the same meaning')

  // --- Isabelle names always win ------------------------------------------------------
  assert.strictEqual(plain('forall'), '\\<forall>')
  assert.strictEqual(plain('a'), '\\<a>', '\\a is Isabelle\'s own \\<a>, never Lean\'s alpha')
  assert.strictEqual(plain('sub'), '\\<^sub>', '\\sub stays the subscript control symbol')
  assert.strictEqual(plain('N'), '\\<N>')
  pass('Isabelle symbol names are never shadowed by an alias')

  // --- sub- and superscripts ------------------------------------------------------------
  assert.strictEqual(plain('_1'), '\\<^sub>1')
  assert.strictEqual(plain('_i'), '\\<^sub>i')
  assert.strictEqual(plain('^2'), '\\<^sup>2')
  assert.strictEqual(s.lookup('^s'), undefined, '\\^s must stay open for \\^sub')
  assert.ok(s.canExtend('_') && s.canExtend('^'))
  pass('\\_x and \\^digit give sub- and superscripts')

  // --- waiting for a longer key -----------------------------------------------------------
  assert.ok(s.canExtend('<-'), '<- waits for <->')
  assert.ok(!s.canExtend('<->'))
  assert.ok(s.canExtend('|-'), '|- waits for |->')
  assert.ok(s.canExtend('='), '= waits for => and ==>')
  assert.ok(!s.canExtend('==>'))
  assert.ok(s.canExtend('subset'), 'subset still waits for subseteq')
  assert.ok(s.canExtend('la'), 'la waits for lambda, langle, ...')
  pass('a key waits while a longer one is reachable')

  // --- pairs ------------------------------------------------------------------------------
  assert.deepStrictEqual(s.lookup('[['), { before: '\\<lbrakk>', after: '\\<rbrakk>' })
  assert.deepStrictEqual(s.lookup('<>'), { before: '\\<langle>', after: '\\<rangle>' })
  assert.deepStrictEqual(s.lookup('floor'), { before: '\\<lfloor>', after: '\\<rfloor>' })
  assert.ok(!s.canExtend('[['), '[[ expands at once, closers or not')
  assert.strictEqual(autoClosers('[['), ']]')
  assert.strictEqual(autoClosers('(|'), ')')
  assert.strictEqual(autoClosers('<>'), '')
  pass('pairs put the caret between the halves, and know which closers VS Code added')

  // --- every built-in expansion names real symbols ----------------------------------------
  for (const [k, e] of s.entries()) {
    for (const m of (e.before + e.after).matchAll(/\\<\^?[A-Za-z][A-Za-z0-9_']*>/g)) {
      assert.ok(table.has(m[0]), `${k} -> unknown ${m[0]}`)
    }
    assert.ok(!table.lookupByKey(k), `${k} shadows an Isabelle name`)
  }
  pass(`all ${s.entries().length} built-in shorthands name known symbols and shadow none`)

  // --- the typed key --------------------------------------------------------------------
  assert.strictEqual(typedKey('x \\all'), 'all')
  assert.strictEqual(typedKey('x \\[['), '[[')
  assert.strictEqual(typedKey('x \\<forall'), undefined, 'a raw escape being typed is no key')
  assert.strictEqual(typedKey('x \\<^sub>i'), undefined)
  assert.strictEqual(typedKey('x \\<->'), '<->', 'but \\<-> is a key: - is no letter')
  assert.strictEqual(typedKey('x \\al l'), undefined, 'a key has no blanks')
  pass('the key is what follows the last backslash, raw \\<name> escapes excepted')

  // --- custom shorthands ------------------------------------------------------------------
  s.setCustom({ cup: '∪', pair: '\\<langle>$CURSOR\\<rangle>', all: '∃', bad: '\\<nosuchsymbol>', 'a b': 'x' })
  assert.strictEqual(plain('cup'), '\\<union>', 'a glyph is stored as its escape')
  assert.deepStrictEqual(s.lookup('pair'), { before: '\\<langle>', after: '\\<rangle>' })
  assert.strictEqual(plain('all'), '\\<exists>', 'custom entries override built-in ones')
  assert.deepStrictEqual(s.invalidCustom.sort(), ['a b', 'bad'])
  assert.deepStrictEqual(s.keysFor('\\<union>').sort(), ['cup', 'un'])
  s.setCustom({})
  assert.strictEqual(plain('all'), '\\<forall>')
  pass('custom shorthands: glyphs become escapes, overrides apply, bad entries are reported')

  console.log(passed + ' checks passed')
  console.log('SUITE34_OK')
}

module.exports = { run }

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1) })
}
