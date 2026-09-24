// Pure checks for the simplifier trace panel's presentation rules.
//
// The panel is a conversation rather than a display, which is what these pin down. Two
// states look identical on screen and mean opposite things -- "the simplifier is waiting
// for you" and "nothing is tracing" -- and getting that wording wrong is the difference
// between a user answering a question and concluding the feature is broken.
const assert = require('assert')
const path = require('path')

const { statusLine, answerButtons } =
  require(path.join(__dirname, '..', 'out', 'simplifier_trace_view.js'))
const { buildTraceTree, outcome, nodeView, ruleApplication, traceStats, statsLine, renderTraceTree } =
  require(path.join(__dirname, '..', 'out', 'simplifier_trace_tree.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

// The answer set the prover actually offers at a rewrite step, from
// Simplifier_Trace.Answer.step.
const STEP_ANSWERS = [
  { name: 'continue', label: 'Continue' },
  { name: 'continue_trace', label: 'Continue (with full trace)' },
  { name: 'continue_passive', label: 'Continue (without asking)' },
  { name: 'continue_disable', label: 'Continue (without any trace)' },
  { name: 'skip', label: 'Skip' },
]

function question(over) {
  return Object.assign({
    serial: 42, text: 'simp step', content: '<pre>x + 0 == x</pre>', answers: STEP_ANSWERS,
  }, over)
}

async function run() {
  // --- status wording --------------------------------------------------------------
  assert.ok(/Waiting for the prover/.test(statusLine(undefined)),
    'before any response the panel must not claim there is nothing to answer')
  pass('an unanswered panel says it is waiting for the prover, not that nothing is pending')

  // No question is the state users misread. It has to say how to turn tracing on, or the
  // panel looks broken rather than idle.
  const idle = statusLine({ auto_update: true, pending: 0 })
  assert.ok(/No simplifier question pending/.test(idle))
  assert.ok(/simp_trace_new/.test(idle),
    'an idle panel must say how to enable tracing, or it reads as broken')
  // `interactive` is a separate flag in the attribute and defaults to false. Without it
  // the simplifier logs the trace instead of asking about it, so the panel stays empty
  // forever -- a user following a hint that omits it concludes the feature is broken.
  // This was found by running the real thing: the fixture said mode=full and no question
  // ever arrived.
  assert.ok(/interactive/.test(idle),
    'the hint must include the interactive keyword, or following it cannot work')
  pass('an idle panel explains how to enable tracing, including the interactive keyword')

  // Suspended is the load-bearing state: the proof is blocked until an answer.
  const one = statusLine({ auto_update: true, pending: 1, question: question() })
  assert.ok(/suspended/i.test(one))
  assert.ok(!/queued/.test(one), 'a single question must not mention a queue')
  pass('a lone question reports the simplifier as suspended')

  // A queue must be visible, or a backlog looks like the trace being over.
  const many = statusLine({ auto_update: true, pending: 4, question: question() })
  assert.ok(/3 further questions queued/.test(many), many)
  const two = statusLine({ auto_update: true, pending: 2, question: question() })
  assert.ok(/1 further question queued/.test(two), `singular, not "1 questions": ${two}`)
  pass('queued questions are counted, and the count reads grammatically')

  // --- answers ---------------------------------------------------------------------
  // Buttons come from the prover, never from a hardcoded list: a hint failure offers
  // Redo/Exit instead, and inventing Continue there would send an answer the prover
  // does not accept at that point.
  assert.deepStrictEqual(answerButtons(question()).map(a => a.name),
    ['continue', 'continue_trace', 'continue_passive', 'continue_disable', 'skip'])
  assert.deepStrictEqual(
    answerButtons(question({ answers: [{ name: 'redo', label: 'Redo' },
                                       { name: 'exit', label: 'Exit' }] })).map(a => a.name),
    ['redo', 'exit'],
    'a hint failure offers its own answers, not the step answers')
  assert.deepStrictEqual(answerButtons(undefined), [],
    'no question offers no answers -- a stale button would quote a dead serial')
  pass('answers are taken from the question, never assumed')

  // Breakpoints are the way to not drown: the default mode asks only at them.
  assert.ok(/simp_break/.test(idle), 'the idle hint must mention breakpoints')
  assert.ok(/mode=full/.test(idle), 'the idle hint must still say how to stop everywhere')
  pass('an idle panel explains breakpoints as well as mode=full')

  // --- the trace tree --------------------------------------------------------------
  // Fixtures shaped like Simplifier_Trace.ML's output: parents thread through the
  // context, hints report a step's outcome, text of the chunks is newline-separated.
  const e = (serial, parent, kind, text, plain, extra) => Object.assign(
    { serial, parent, kind, text, plain, content: `<pre class="source">#${serial}</pre>` }, extra)
  const conditional = [
    e(10, 1, 'recurse', 'Simplifier invoked', 'f (g x) = y'),
    e(11, 10, 'step', 'Apply conditional rewrite rule?',
      'Instance of Foo.bar: P x ⟹ g x ≡ x\nTrying to rewrite: g x'),
    e(12, 11, 'recurse', 'Simplifier invoked', 'P x'),
    e(13, 12, 'step', 'Apply rewrite rule?', 'Instance of Foo.P_def: P x ≡ True\nTrying to rewrite: P x'),
    e(14, 13, 'hint', 'Successfully rewrote', 'P x ≡ True', { success: true }),
    e(15, 11, 'hint', 'Successfully rewrote', 'g x ≡ x', { success: true }),
    e(16, 10, 'step', 'Apply rewrite rule?',
      'Instance of ??.??.unknown: f x ≡ y\nTrying to rewrite: f x'),
  ]
  const roots = buildTraceTree(conditional)
  assert.deepStrictEqual(roots.map(n => n.entry.serial), [10],
    'the first invocation hangs under the prover context, which is not an item -- it is a root')
  const [top] = roots
  assert.deepStrictEqual(top.children.map(n => n.entry.serial), [11, 16])
  const [cond, unnamed] = top.children
  assert.deepStrictEqual(cond.children.map(n => n.entry.serial), [12],
    'a side-condition invocation belongs under the step it decides')
  assert.deepStrictEqual(cond.hints.map(h => h.serial), [15],
    'a step\'s outcome is folded into the step, not listed as a row of its own')
  pass('the tree follows parent links: invocation > step > side condition > its steps')

  assert.deepStrictEqual(
    buildTraceTree([...conditional].reverse()).map(n => n.entry.serial), [10],
    'emission order, not arrival order, decides the structure')
  pass('entries arriving out of order build the same tree')

  assert.strictEqual(outcome(cond), 'rewrote')
  assert.strictEqual(outcome(unnamed), 'none', 'no hint yet: nothing is claimed')
  assert.strictEqual(outcome(unnamed, 16), 'pending')
  pass('step outcomes: rewrote from its hint, pending when it is the open question, else none')

  assert.strictEqual(nodeView(top).label, 'Simplifier invoked')
  assert.strictEqual(nodeView(cond.children[0]).label, 'Side condition',
    'an invocation under a step is that step\'s side condition, and has to say so')
  const cv = nodeView(cond)
  assert.strictEqual(cv.label, 'Conditional rewrite')
  assert.strictEqual(cv.rule, 'Foo.bar')
  assert.strictEqual(cv.term, 'g x', 'the summary names the subterm being rewritten')
  assert.strictEqual(nodeView(unnamed).rule, 'unnamed rule',
    '"??.??.unknown" reads like a malfunction; it is a rule without a name')
  pass('node labels say what happened, to what, with which rule')

  assert.deepStrictEqual(traceStats(roots), { invocations: 2, steps: 3, rewrites: 2, failures: 0 })
  assert.strictEqual(statsLine(traceStats(roots)), '2 simplifier calls · 2 rewrites · 0 failed attempts')
  pass('the summary counts calls, rewrites and failures across the whole tree')

  // A failed step, then Redo: the prover replays the step, and the abandoned attempt goes.
  const failed = [
    e(20, 1, 'recurse', 'Simplifier invoked', 'g y'),
    e(21, 20, 'step', 'Apply conditional rewrite rule?',
      'Instance of Foo.bar: P y ⟹ g y ≡ y\nTrying to rewrite: g y'),
    e(22, 21, 'hint', 'Step failed',
      'In an instance of Foo.bar: P y ⟹ g y ≡ y\nWas trying to rewrite: g y', { success: false }),
  ]
  const [before] = buildTraceTree(failed)
  assert.strictEqual(outcome(before.children[0]), 'failed')
  assert.strictEqual(outcome(before.children[0], 22), 'pending',
    'a failure is itself a question (Redo/Exit), so the step is pending while it waits')
  const redone = buildTraceTree([...failed,
    e(23, 21, 'ignore', 'Ignore', ''),
    e(24, 20, 'step', 'Apply conditional rewrite rule?',
      'Instance of Foo.bar: P y ⟹ g y ≡ y\nTrying to rewrite: g y')])
  assert.deepStrictEqual(redone[0].children.map(n => n.entry.serial), [24],
    'the ignore names the step being redone; that attempt is dropped and the replay stays')
  pass('a failed step reads as failed, and Redo replaces the attempt instead of piling up')

  // Normal mode without breakpoints records no steps -- only invocations and hints. Those
  // hints are then the whole story and have to be rows, not folded into a missing step.
  const quiet = buildTraceTree([
    e(30, 1, 'recurse', 'Simplifier invoked', 'h (a + 0)'),
    e(31, 30, 'hint', 'Successfully rewrote', 'a + 0 ≡ a', { success: true }),
    e(32, 30, 'hint', 'Step failed',
      'In an instance of Foo.baz: Q x ⟹ h x ≡ x\nWas trying to rewrite: h a', { success: false }),
  ])
  const [ok, no] = quiet[0].children
  assert.strictEqual(nodeView(ok).label, 'Rewrote')
  assert.strictEqual(nodeView(ok).badge, '✓')
  assert.strictEqual(nodeView(no).label, 'Failed')
  assert.strictEqual(nodeView(no).rule, 'Foo.baz')
  assert.strictEqual(nodeView(no).term, 'h a')
  assert.deepStrictEqual(traceStats(quiet), { invocations: 1, steps: 0, rewrites: 1, failures: 1 })
  pass('untraced rewrites still show as rewrote/failed rows under their invocation')

  assert.deepStrictEqual(ruleApplication(
    'Instance of X.y: a ≡ b\nTrying to rewrite: a\nMatching terms:\n• a'),
    { rule: 'X.y', instance: 'a ≡ b', term: 'a' }, 'Matching terms are not part of the term')
  assert.deepStrictEqual(ruleApplication('P x'), {})
  pass('rule applications parse, including the breakpoint "Matching terms" tail')

  // Rendering: the pending path opens, plain text is escaped, server HTML is not.
  const html = renderTraceTree(roots, 16)
  const openOf = serial => new RegExp(`data-serial="${serial}"[^>]*><details open>`).test(html)
  assert.ok(openOf(10) && openOf(16), 'the path to the waiting step starts open')
  assert.ok(!openOf(11), 'unrelated steps start closed')
  assert.ok(html.includes('outcome-pending'))
  assert.ok(html.includes('<pre class="source">#16</pre>'), 'server HTML goes in as markup')
  const hostile = renderTraceTree(buildTraceTree([
    e(40, 1, 'recurse', 'Simplifier invoked', '<img src=x onerror=alert(1)> "q"')]))
  assert.ok(!hostile.includes('<img'), 'text derived from plain must be escaped')
  assert.ok(hostile.includes('data-search="simplifier invoked  &lt;img src=x onerror=alert(1)&gt; &quot;q&quot;"'),
    `search text is lowercase and attribute-escaped: ${hostile}`)
  assert.ok(/No trace recorded/.test(renderTraceTree([])))
  pass('rendering opens the pending path, escapes derived text and keeps server markup')

  console.log(passed + ' checks passed')
  console.log('SUITE27_OK')
}

module.exports = { run }

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1) })
}
