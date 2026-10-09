// Pure checks for Sledgehammer jobs (src/sledgehammer_text.ts, src/theory_lexer.ts): the
// `sorry`s of a text, where a job's place is after an edit, the parameters of a run, the
// edit that puts a proof in, and what counts as a falsification.
//
// What is held down: a `sorry` in a comment, a string or a cartouche is none; typing the
// next step after a job's place leaves it where it is, and typing before it moves it along;
// a proof goes in place of the job's `sorry`, or of the `sorry` after its command; and the
// outline's commands are what they were before the scan grew words that start no line.
const assert = require('assert')
const path = require('path')

const { scanWords } = require(path.join(__dirname, '..', 'out', 'theory_lexer.js'))
const { findSorries, shiftAnchor, serverParams, isFalsification, proofEdit } =
  require(path.join(__dirname, '..', 'out', 'sledgehammer_text.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

const THEORY = [
  'theory T imports Main begin',
  '(* sorry in a comment *)',
  'lemma a: "P \\<longrightarrow> P" (* nested (* sorry *) *)',
  '  text \\<open>a sorry in a cartouche \\<open>sorry\\<close>\\<close>',
  '  have "x = sorry" sorry',
  '  show ?thesis',
  '    sorry',
  '  ML_file "foo.ML"',
  'end',
].join('\n')

async function run() {
  // --- the scan ----------------------------------------------------------------------------
  const words = scanWords(THEORY)
  const starts = words.filter(w => w.atLineStart).map(w => w.word)
  assert.deepStrictEqual(starts, ['theory', 'lemma', 'text', 'have', 'show', 'sorry', 'ML_file', 'end'],
    'the commands at the starts of lines, as the outline reads them')
  assert.ok(!words.some(w => w.word === 'longrightarrow'), 'a symbol is not a word')
  pass('commands at line starts are found as before; symbols are no words')

  const sorries = findSorries(THEORY)
  assert.strictEqual(sorries.length, 2, 'only the two sorrys that are commands')
  for (const s of sorries) assert.strictEqual(THEORY.slice(s.offset, s.offset + s.length), 'sorry')
  assert.ok(THEORY.slice(0, sorries[0].offset).endsWith('" '), 'the first after the have')
  pass('a sorry in a comment, a string or a cartouche is none')

  const lineOf = o => THEORY.slice(0, o).split('\n').length - 1
  const showLine = THEORY.split('\n').findIndex(l => l.includes('show ?thesis'))
  const from = THEORY.split('\n').slice(0, showLine).join('\n').length
  assert.deepStrictEqual(findSorries(THEORY, from).map(s => lineOf(s.offset)), [showLine + 1],
    'within a range')
  pass('sorrys within a range')

  // --- anchors ------------------------------------------------------------------------------
  const anchor = { start: 10, end: 15 }
  assert.deepStrictEqual(shiftAnchor(anchor, { offset: 2, length: 0, text: 3 }),
    { start: 13, end: 18, touched: false }, 'typing before moves it')
  assert.deepStrictEqual(shiftAnchor(anchor, { offset: 10, length: 0, text: 2 }),
    { start: 12, end: 17, touched: false }, 'typing right before it moves it too')
  assert.deepStrictEqual(shiftAnchor(anchor, { offset: 15, length: 0, text: 4 }),
    { start: 10, end: 15, touched: false }, 'typing the next step right after it leaves it')
  assert.deepStrictEqual(shiftAnchor(anchor, { offset: 20, length: 3, text: 0 }),
    { start: 10, end: 15, touched: false }, 'deleting after it leaves it')
  assert.deepStrictEqual(shiftAnchor(anchor, { offset: 0, length: 4, text: 1 }),
    { start: 7, end: 12, touched: false }, 'deleting before it moves it back')
  const touched = shiftAnchor(anchor, { offset: 12, length: 2, text: 5 })
  assert.ok(touched.touched, 'an edit inside touches it')
  assert.deepStrictEqual([touched.start, touched.end], [10, 18], 'and it spans the new text')
  assert.ok(shiftAnchor(anchor, { offset: 8, length: 10, text: 0 }).touched, 'deleting it touches it')
  pass('a job\'s place follows the edits around it')

  // --- parameters ----------------------------------------------------------------------------
  const options = {
    provers: ' cvc5 e ', timeout: 12.4, isar: 'smart', try0: true, stopAtFirst: true,
    falsify: true, abduce: false, induction: true, subgoal: 2, facts: '',
  }
  assert.deepStrictEqual(serverParams(options, 'C:/cache'), [
    'provers', 'cvc5 e', 'timeout', '12', 'isar_proofs', 'smart', 'try0', 'true',
    'max_proofs', '1', 'falsify', 'smart', 'induction_rules', 'instantiate', 'cache_dir', 'C:/cache'])
  const plain = serverParams({ ...options, provers: '', stopAtFirst: false, falsify: false,
    induction: false, abduce: true, try0: false, isar: 'false' })
  assert.deepStrictEqual(plain, ['timeout', '12', 'isar_proofs', 'false', 'try0', 'false',
    'abduce', 'smart'], 'what is off is left to Sledgehammer\'s defaults')
  pass('the options become Sledgehammer parameters')

  // --- falsification -------------------------------------------------------------------------
  assert.ok(isFalsification('<writeln>The goal is falsified by these facts: foo, bar</writeln>'))
  assert.ok(isFalsification('cvc5 found a falsification...'))
  assert.ok(isFalsification('Derived "False" from these facts alone: x'))
  assert.ok(!isFalsification('<writeln>Try this: <sendback>by simp</sendback> (0.4 ms)</writeln>'))
  assert.ok(!isFalsification('No proof found'))
  pass('a falsification is told from a proof and from no proof')

  // --- putting a proof in --------------------------------------------------------------------
  const T = 'lemma x: "P"\n  have "Q"\n    sorry\n  show ?thesis\nqed\n'
  const s = T.indexOf('sorry')
  let e = proofEdit(T, { kind: 'sorry', start: s, end: s + 5 }, 'by simp')
  assert.deepStrictEqual(e, { start: s, end: s + 5, text: 'by simp' }, 'in place of its sorry')
  e = proofEdit(T, { kind: 'sorry', start: s, end: s + 5 }, 'proof -\n  show Q by simp\nqed')
  assert.strictEqual(e.text, 'proof -\n      show Q by simp\n    qed', 'an Isar proof indented there')

  const have = T.indexOf('have "Q"')
  e = proofEdit(T, { kind: 'command', start: have, end: have + 'have "Q"'.length }, 'by auto')
  assert.deepStrictEqual(e, { start: s, end: s + 5, text: 'by auto' },
    'after its command, in place of the sorry that follows')

  const show = T.indexOf('show ?thesis')
  e = proofEdit(T, { kind: 'command', start: show, end: show + 'show ?thesis'.length }, 'by blast')
  assert.deepStrictEqual(e, { start: show + 12, end: show + 12, text: '\n  by blast' },
    'else on a line of its own, indented as its command')
  const sorryish = 'have "Q" sorryX'
  e = proofEdit(sorryish, { kind: 'command', start: 0, end: 8 }, 'by simp')
  assert.strictEqual(e.start, 8, 'a word that only begins with sorry is not replaced')
  pass('a proof goes in place of the sorry, or after the command')

  console.log(`${passed} checks passed`)
  console.log('SUITE67_OK')
}

run().catch(e => { console.error(e); process.exit(1) })
