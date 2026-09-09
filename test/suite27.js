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

  console.log(passed + ' checks passed')
  console.log('SUITE27_OK')
}

module.exports = { run }

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1) })
}
