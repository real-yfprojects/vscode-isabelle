// Pure checks for the code skeletons (src/skeletons.ts) on sendback snippets as the server
// sends them -- recorded from Isabelle2025-2's own server: the outline after
// `proof (induction xs)` and try0's proofs.
//
// What is held down: an outline is told from a found proof by its shape, its title counts
// the top-level cases only, and the ghost text starts with whatever the caret's line
// already holds, so VS Code shows it.
const assert = require('assert')
const path = require('path')

const { classifySendback, isOutline, ghostText, mayCarrySkeleton, startsOutline, addedLines,
  isGhostCandidate } =
  require(path.join(__dirname, '..', 'out', 'skeletons.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

const LIST = '  case Nil\n  then show ?case sorry\nnext\n  case (Cons a xs)\n  then show ?case sorry\nqed'
// print_cases_proof with nested cases: braces around a level with several, indented by 2 more.
const NESTED = '  case A\n  {\n    case B\n    then show ?case sorry\n  next\n    case C\n' +
  '    then show ?case sorry\n  }\nnext\n  case D\n  then show ?thesis sorry\nqed'
const ISAR = 'proof -\n  have "x = y"\n    by simp\n  then show ?thesis\n    by auto\nqed'

async function run() {
  // --- classification --------------------------------------------------------------------
  assert.deepStrictEqual(classifySendback(LIST),
    { kind: 'outline', title: 'Insert proof outline (2 cases)' })
  assert.deepStrictEqual(classifySendback(NESTED),
    { kind: 'outline', title: 'Insert proof outline (2 cases)' }, 'nested cases are not counted')
  assert.strictEqual(classifySendback('  case 1\n  then show ?case sorry\nqed').title,
    'Insert proof outline (1 case)')
  pass('an outline is titled by its number of top-level cases')

  assert.deepStrictEqual(classifySendback('by simp'), { kind: 'proof', title: 'Insert proof: by simp' })
  assert.deepStrictEqual(classifySendback(ISAR),
    { kind: 'proof', title: 'Insert proof: proof - … (6 lines)' })
  assert.ok(!isOutline(ISAR), 'an Isar proof ends in qed but is no outline')
  assert.ok(!isOutline('case x of None => 0'), 'no qed, no outline')
  pass('found proofs are titled by their first line')

  // --- ghost text --------------------------------------------------------------------------
  // `  proof (induction xs)` and ENTER: the editor indents the new line by two more.
  assert.strictEqual(ghostText(LIST, '  ', '    '),
    '    case Nil\n    then show ?case sorry\n  next\n    case (Cons a xs)\n    then show ?case sorry\n  qed',
    'the same text the server\'s own edit inserts')
  assert.strictEqual(ghostText(LIST, '  ', '').split('\n')[0], '    case Nil',
    'a caret at column 0 still gets the command\'s indentation')
  assert.strictEqual(ghostText(LIST, '  ', '      ').split('\n')[0], '      case Nil',
    'a caret indented further moves the outline right')
  assert.strictEqual(ghostText(LIST, '  ', '      ').split('\n')[2], '    next')
  for (const caret of ['', '  ', '    ', '      ']) {
    assert.ok(ghostText(LIST, '  ', caret).startsWith(caret),
      `the ghost text extends the caret's line (${JSON.stringify(caret)})`)
  }
  assert.strictEqual(ghostText(LIST + '\n', '', '').split('\n').length, 6, 'no trailing blank line')
  pass('the ghost text starts at the caret and keeps the outline\'s shape')

  // --- when to ask -------------------------------------------------------------------------
  assert.ok(mayCarrySkeleton('  proof (induction xs)'))
  assert.ok(mayCarrySkeleton('lemma "P x" proof (cases x)'))
  assert.ok(!mayCarrySkeleton('  by simp'))
  assert.ok(!mayCarrySkeleton("  have proof': \"P\""), 'proof\' is a name, not the command')
  assert.ok(mayCarrySkeleton('instantiation nat :: foo'))
  assert.ok(startsOutline('    case Nil') && startsOutline('  qed') && !startsOutline('  oops'))
  pass('waits only below a proof or an instantiation, and not over an outline already written')

  // --- from the edit back to the skeleton ---------------------------------------------------
  // A stock server's sendback: the command rewritten to itself and the outline.
  const SENT = 'proof (induction xs)\n    case Nil\n    then show ?case sorry\n  next\n' +
    '    case (Cons a xs)\n    then show ?case sorry\n  qed'
  assert.strictEqual(addedLines('proof (induction xs)', SENT, '  '), LIST)
  // The extended server's skeleton: inserted at the command's end.
  assert.strictEqual(
    addedLines('', '\ndefinition z_nat :: nat where\n  "z_nat = undefined"\n\ninstance ..', ''),
    'definition z_nat :: nat where\n  "z_nat = undefined"\n\ninstance ..')
  assert.strictEqual(addedLines('proof (cases x)', SENT, '  '), undefined,
    'an edit that does not start with the command is not ours')
  pass('the skeleton is read back from the edit, whichever way the server sends it')

  assert.ok(isGhostCandidate(undefined, LIST), 'a stock server\'s outline')
  assert.ok(!isGhostCandidate(undefined, 'by simp'))
  assert.ok(isGhostCandidate('refactor.rewrite.isabelle.outline', 'Insert proof outline (2 cases)'))
  assert.ok(isGhostCandidate('refactor.rewrite.isabelle.skeleton', 'Insert instantiation skeleton'))
  assert.ok(!isGhostCandidate('refactor.rewrite.isabelle.suggestion', 'Insert Isar sketch'),
    'a sketch is one choice among others: only from the light bulb')
  assert.ok(!isGhostCandidate('quickfix.isabelle.proof', 'Insert proof: by simp'))
  pass('ghost text only for what the text already determines')

  console.log(`${passed} checks passed`)
  console.log('SUITE60_OK')
}

run().catch(e => { console.error(e); process.exit(1) })
