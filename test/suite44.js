// Pure checks for the infoview's page body (infoview_view.ts) -- no prover, no editor.
//
// What the view says in each state is text, so it is pinned down here: that goals and
// messages get their own blocks, that an empty section says *why* it is empty, that
// pausing shows, and that theory text in a header cannot turn into markup.
const assert = require('assert')
const path = require('path')

const { infoviewBody, locationLabel, fileLabel } =
  require(path.join(__dirname, '..', 'out', 'infoview_view.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

function model(over) {
  return Object.assign({ mode: 'extended', pins: [], paused: false, pending: false }, over)
}

const live = {
  uri: 'file:///c%3A/work/Foo.thy', line: 11, command: 'apply', source: 'apply (rule impI)',
  status: 'finished', goals: '<pre class="source">goal (1 subgoal)</pre>',
  messages: '<pre class="source">a warning</pre>',
}

async function run() {
  // --- labels ---------------------------------------------------------------------
  assert.strictEqual(fileLabel('file:///c%3A/work/Foo.thy'), 'Foo.thy')
  assert.strictEqual(fileLabel('file:///home/u/A%20B.thy'), 'A B.thy')
  assert.strictEqual(locationLabel({ uri: live.uri, line: 11 }), 'Foo.thy:12',
    'lines are shown 1-based, as the editor numbers them')
  assert.strictEqual(locationLabel({}), '')
  pass('locations read file:line, 1-based')

  // --- the live section -----------------------------------------------------------
  let html = infoviewBody(model({ live }))
  assert.ok(html.includes('data-key="live:goals"') && html.includes('data-key="live:messages"'),
    'goals and messages are separate blocks')
  assert.ok(html.indexOf('live:goals') < html.indexOf('live:messages'), 'goals come first')
  assert.ok(html.includes('goal (1 subgoal)'), 'server HTML goes in as markup')
  assert.ok(html.includes('At cursor') && html.includes('Foo.thy:12'))
  assert.ok(!html.includes('class="status'), 'a finished command needs no status badge')
  pass('the live section shows goals, then messages, under its location')

  html = infoviewBody(model({ live: Object.assign({}, live, { goals: '' }) }))
  assert.ok(!html.includes('live:goals'), 'no Goals block when there are none')
  assert.ok(html.includes('live:messages'))
  pass('a command without a proof state shows only its messages')

  const empty = s => infoviewBody(model({ live: { uri: live.uri, line: 0, status: s, goals: '', messages: '' } }))
  assert.ok(empty('unprocessed').includes('Not checked yet.'))
  assert.ok(empty('running').includes('Running…'))
  assert.ok(empty('finished').includes('No output.'))
  assert.ok(empty('running').includes('class="status running"'))
  pass('an empty section says why it is empty')

  assert.ok(infoviewBody(model({ mode: 'waiting' })).includes('Waiting for Isabelle'))
  assert.ok(infoviewBody(model({})).includes('No command at the cursor.'))
  pass('no live section: waiting for the server, or nothing at the cursor')

  // --- pausing --------------------------------------------------------------------
  html = infoviewBody(model({ live, paused: true }))
  assert.ok(html.includes('>Paused<') && html.includes('>Resume<'))
  assert.ok(infoviewBody(model({ live, paused: true, pending: true })).includes('Paused (changed)'))
  assert.ok(infoviewBody(model({ live })).includes('>Pause<'))
  pass('pausing shows, and so does a change it is holding back')

  // --- pins -----------------------------------------------------------------------
  const pin = Object.assign({}, live, { id: 3, line: 4 })
  html = infoviewBody(model({ live, pins: [pin] }))
  assert.ok(html.indexOf('At cursor') < html.indexOf('Pinned'), 'the live section stays on top')
  assert.ok(html.includes('data-key="pin3:goals"'), 'a pin keys its blocks by id')
  assert.ok(html.includes('data-command="unpin" data-arg="3"'))
  assert.ok(html.includes('data-command="reveal" data-arg="3"'))
  assert.ok(!html.includes('unpinAll'), 'one pin needs no Unpin all')
  assert.ok(infoviewBody(model({ pins: [pin, Object.assign({}, pin, { id: 4 })] })).includes('unpinAll'))
  pass('pins follow the live section, each with its own controls')

  html = infoviewBody(model({ pins: [Object.assign({}, pin, { stale: true })] }))
  assert.ok(html.includes('class="pin stale"') && html.includes('>stale<'))
  pass('a stale pin says so')

  // A stock pin knows only its goals; it must not claim to have no output.
  html = infoviewBody(model({ mode: 'stock', pins: [{ id: -2, uri: live.uri, line: 4, goals: 'G' }] }))
  assert.ok(html.includes('pin-2:goals') && !html.includes('No output.'))
  pass('a pin with goals only shows its goals')

  // --- enclosing goals ------------------------------------------------------------
  const inShow = Object.assign({}, live, {
    goals: '<pre>goal (1 subgoal): 1. B</pre>',
    outer: [{ line: 6, command: 'proof', source: 'proof', goals: '<pre>goal (2 subgoals)</pre>' },
            { line: 2, command: 'proof', source: 'proof -', goals: '<pre>goal (1 subgoal): 1. C</pre>' }],
  })
  html = infoviewBody(model({ live: inShow }))
  const goalsBlock = html.slice(html.indexOf('live:goals'), html.indexOf('live:messages'))
  assert.ok(goalsBlock.indexOf('1. B') < goalsBlock.indexOf('2 subgoals') &&
            goalsBlock.indexOf('2 subgoals') < goalsBlock.indexOf('1. C'),
    'the current goal on top, then each enclosing level, innermost first, in the Goals block')
  assert.ok(html.includes('data-command="revealLine" data-arg="file:///c%3A/work/Foo.thy#6"'))
  assert.ok(html.includes('line 7'), 'enclosing lines are 1-based too')
  html = infoviewBody(model({ live: Object.assign({}, inShow, { goals: '' }) }))
  assert.ok(html.includes('live:goals'), 'enclosing goals alone still make a Goals block')
  pass('enclosing goals follow the current one, each going to where it was printed')

  // A diag command prints no goal, a chaining one only its facts: the goal comes from the
  // command before, between the command's own state and the enclosing levels.
  const chained = Object.assign({}, inShow, {
    goals: '<pre>proof (chain) picking this: A</pre>',
    current: { line: 8, command: 'by', source: 'have A by simp', goals: '<pre>goal (1 subgoal): 1. B</pre>' },
  })
  html = infoviewBody(model({ live: chained }))
  const chainBlock = html.slice(html.indexOf('live:goals'), html.indexOf('live:messages'))
  assert.ok(chainBlock.indexOf('picking') < chainBlock.indexOf('1. B') &&
            chainBlock.indexOf('1. B') < chainBlock.indexOf('2 subgoals'),
    'own state, then the goal it left unchanged, then the enclosing levels')
  assert.ok(chainBlock.includes('Unchanged since') && chainBlock.includes('line 9') &&
            chainBlock.includes('have A by simp'), 'it says which command printed the goal')
  assert.ok(html.includes('data-arg="file:///c%3A/work/Foo.thy#8"'), 'and goes there')
  html = infoviewBody(model({ live: Object.assign({}, chained, { goals: '', outer: [] }) }))
  assert.ok(html.includes('live:goals') && !html.includes('No output.'),
    'a diag command with nothing of its own still shows the goal')
  pass('a command that printed no goal shows the one it left unchanged')

  // --- escaping -------------------------------------------------------------------
  const hostile = {
    uri: 'file:///t/%3Cimg%20src%3Dx%3E.thy', line: 0,
    source: 'lemma "<script>alert(1)</script>"', command: 'lemma', goals: '', messages: '',
  }
  html = infoviewBody(model({ live: hostile }))
  assert.ok(!html.includes('<script>') && !html.includes('<img'), 'header text is escaped')
  assert.ok(html.includes('&lt;script&gt;'))
  pass('file names and command text are escaped')

  console.log(`\n${passed} checks passed`)
  console.log('SUITE44_OK')
}

module.exports = { run }

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1) })
}
