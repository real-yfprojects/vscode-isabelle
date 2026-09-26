// Pure checks for the status bar item (status_items.ts) -- no prover, no editor.
//
// The item is read at a glance, so what matters is that each state looks different from
// the others and that it never claims work the prover is not doing. Both are properties
// of the text alone, which is why they are pinned down here rather than in the editor.
const assert = require('assert')
const path = require('path')

const { statusView, summarize, busy, settling, escapeMarkdown, TOOLTIP_COMMANDS,
        caretPerspective, checkingExtent } =
  require(path.join(__dirname, '..', 'out', 'status_items.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

function node(over) {
  return Object.assign({
    uri: 'file:///t/T.thy', theory: 'T', overall: 'ok',
    cumulated_time: 0, max_time: 0, ok: true, total: 100,
    unprocessed: 0, running: 0, warned: 0, failed: 0, finished: 100,
    canceled: false, consolidated: true, initialized: true, percentage: 100,
  }, over)
}

function view(over) {
  return statusView(Object.assign({
    logic: 'MainResults', requirements: true, server: 'running',
    wholeTheory: false, perspective: 50, controls: true,
  }, over))
}

async function run() {
  // --- server phases ---------------------------------------------------------------
  assert.strictEqual(view({ server: 'off' }).text, '$(debug-disconnect) MainResults')
  assert.strictEqual(view({ server: 'starting' }).text, '$(sync~spin) MainResults')
  assert.strictEqual(view({ server: 'building' }).text, '$(sync~spin) MainResults · building')
  assert.strictEqual(view({ server: 'running' }).text, '$(library) MainResults',
    'running with no progress data looks like the item always did')
  assert.strictEqual(view({ server: 'failed' }).text, '$(error) MainResults')
  pass('each server phase has its own look')

  assert.strictEqual(view({ server: 'failed' }).background, 'error')
  for (const server of ['off', 'starting', 'building', 'running']) {
    assert.strictEqual(view({ server }).background, undefined, server)
  }
  // A failed proof is normal while editing; only the server failing earns the colour.
  const oneFailed = summarize([node({ failed: 1 })], false)
  assert.strictEqual(view({ progress: oneFailed }).background, undefined)
  pass('only a failed server gets the error background')

  assert.strictEqual(view({ server: 'off', logic: 'HOL', requirements: false }).text,
    '$(debug-disconnect) HOL (uncached)')
  assert.strictEqual(view({ logic: 'HOL', requirements: false }).text, '$(library) HOL (uncached)')
  pass('the uncached suffix survives every icon')

  // --- summarize --------------------------------------------------------------------
  const unresolved = node({ initialized: false, failed: 1, percentage: 3 })
  assert.strictEqual(settling(unresolved, true), true)
  let p = summarize([unresolved, node()], true)
  assert.deepStrictEqual(p, { theories: 2, done: 1, running: 1, failed: 0, loading: true })
  p = summarize([unresolved, node()], false)
  assert.deepStrictEqual(p, { theories: 2, done: 1, running: 0, failed: 1, loading: false })
  pass('a theory waiting for its imports counts as running, not failed, while loading')

  // Running and failed at once: both counts, spinner wins the icon.
  p = summarize([node({ running: 2, failed: 1, percentage: 60 })], false)
  assert.deepStrictEqual(p, { theories: 1, done: 0, running: 1, failed: 1, loading: false })
  assert.strictEqual(view({ progress: p }).text, '$(sync~spin) MainResults · 0/1 · 1 failed')
  pass('a theory can be running and failed at once')

  // --- the spinner only means work ---------------------------------------------------
  /* Unless the whole theory is checked, PIDE stops 50 lines below the caret, so theories sit
     below 100% while the prover does nothing. That must not spin. */
  const idle = summarize([node({ percentage: 40, unprocessed: 60, finished: 40 }), node()], false)
  assert.strictEqual(busy(idle), false)
  assert.strictEqual(view({ progress: idle }).text, '$(library) MainResults · 1/2')

  const working = summarize([node({ percentage: 40, running: 1 }), node()], false)
  assert.strictEqual(busy(working), true)
  assert.strictEqual(view({ progress: working }).text, '$(sync~spin) MainResults · 1/2')

  const finished = summarize([node(), node()], false)
  assert.strictEqual(view({ progress: finished }).text, '$(library) MainResults')
  assert.strictEqual(view({ progress: summarize([node({ failed: 2 })], false) }).text,
    '$(error) MainResults · 1 failed', 'a consolidated theory with failures is at 100%')

  // Loading with nothing reported yet is work too.
  assert.strictEqual(view({ progress: summarize([], true) }).text, '$(sync~spin) MainResults')
  assert.strictEqual(view({ progress: summarize([], false) }).text, '$(library) MainResults')
  pass('the spinner appears only while something runs or imports resolve')

  // Progress from a server that is no longer up is not shown.
  assert.strictEqual(view({ server: 'starting', progress: working }).text, '$(sync~spin) MainResults')
  assert.ok(!/Theories:/.test(view({ server: 'off', progress: working }).tooltip))
  pass('progress only shows while the server is running')

  // --- tooltip ---------------------------------------------------------------------
  let t = view({ progress: working, prover: 'ready' }).tooltip
  assert.ok(t.includes('**Isabelle session: MainResults**'))
  assert.ok(/not re-checked/.test(t))
  assert.ok(t.includes('Server: running · prover ready'))
  assert.ok(t.includes('Theories: 1/2 checked · 1 running'))
  assert.ok(t.includes('Checking: down to 50 lines below the cursor'))
  assert.ok(t.includes('(command:isabelle-theories.focus)'))
  assert.ok(t.includes('[Check the whole theory]'))
  assert.ok(view({ wholeTheory: true, perspective: 0 }).tooltip.includes('Checking: the whole theory'))
  assert.ok(view({ wholeTheory: true, perspective: 0 }).tooltip.includes('[Check near the cursor only]'))
  assert.ok(!view({}).tooltip.includes('isabelle-theories.focus'),
    'no Theories link without theories data: a stock server has no such view')
  pass('the tooltip spells the state out')

  assert.ok(view({ progress: summarize([unresolved], true) }).tooltip.includes('resolving imports'))
  assert.ok(view({ server: 'off' }).tooltip.includes('[Start server]'))
  assert.ok(view({ server: 'running' }).tooltip.includes('[Restart server]'))
  pass('link and progress wording follow the state')

  t = view({ server: 'failed', detail: 'Isabelle home not found: C:\\x\n\nmore detail' }).tooltip
  assert.ok(t.includes('Server: stopped -- Isabelle home not found: C:\\\\x'), t)
  assert.ok(!t.includes('more detail'), 'only the first line of the reason')
  t = view({ server: 'building', detail: 'building MainResults_requirements(ViperAbstract)' }).tooltip
  assert.ok(t.includes('building MainResults\\_requirements\\(ViperAbstract\\)'), t)
  pass('failure and build details are shown, first line only, escaped')

  // --- how far checking goes -------------------------------------------------------------
  // Read off the server command line: the last -o wins, as in Isabelle.
  assert.strictEqual(caretPerspective(['vscode_server', '-l', 'HOL']), 50, 'Isabelle\'s default')
  assert.strictEqual(caretPerspective(['-o', 'vscode_caret_perspective=10']), 10)
  assert.strictEqual(caretPerspective(['-ovscode_caret_perspective=7']), 7)
  assert.strictEqual(caretPerspective(
    ['-o', 'vscode_caret_perspective=10', '-o', 'vscode_caret_perspective=0']), 0,
    'checkWholeTheory\'s -o comes after serverOptions and wins')
  assert.strictEqual(caretPerspective(['-o', 'vscode_caret_perspective=-3']), 0,
    'the server takes max 0')
  assert.strictEqual(caretPerspective(['-o', 'editor_tracing_messages=10', '-d', 'x']), 50)
  assert.strictEqual(caretPerspective(['-o']), 50, 'a dangling -o is ignored')
  pass('the checked extent is read from the server arguments')

  assert.strictEqual(checkingExtent(0), 'the whole theory')
  assert.strictEqual(checkingExtent(1), 'down to 1 line below the cursor')
  assert.strictEqual(checkingExtent(20), 'down to 20 lines below the cursor')
  assert.ok(view({ perspective: 20 }).tooltip.includes('Checking: down to 20 lines below the cursor'))
  // Settings apply on restart, so a running server can disagree with them.
  t = view({ perspective: 50, nextPerspective: 0 }).tooltip
  assert.ok(t.includes('Checking: down to 50 lines below the cursor (the whole theory after a restart)'), t)
  assert.ok(!view({ perspective: 50, nextPerspective: 50 }).tooltip.includes('after a restart'))
  pass('the tooltip names the extent in use, and a different one waiting for a restart')

  // --- a stale heap image --------------------------------------------------------------
  const staleFile = (label, change = 'modified') =>
    ({ file: `/p/${label}`, label, change })
  const two = [staleFile('common/Binop.thy'), staleFile('common/Sep (old).thy', 'unsaved')]
  let v = view({ stale: two, progress: finished })
  assert.strictEqual(v.text, '$(library) MainResults · 2 stale')
  assert.strictEqual(v.background, 'warning')
  assert.ok(v.tooltip.includes('**Heap image out of date.** 2 files built into MainResults'))
  assert.ok(v.tooltip.includes('(unsaved)'))
  assert.ok(v.tooltip.includes('[Rebuild: restart the server](command:isabelle.restartServer)'))
  assert.ok(v.tooltip.includes('it builds from the saved files'),
    'an unsaved change needs saving before a rebuild can pick it up')
  pass('a stale image is counted, coloured and explained')

  // Each file links to itself; parentheses in a path must not end the link.
  const links = [...v.tooltip.matchAll(/\]\(command:isabelle\.showStaleFiles\?([^)]*)\)/g)]
  assert.strictEqual(links.length, 2)
  assert.deepStrictEqual(JSON.parse(decodeURIComponent(links[1][1])), ['/p/common/Sep (old).thy'])
  pass('stale files link to themselves, whatever their names')

  assert.strictEqual(view({ server: 'failed', stale: two }).background, 'error',
    'a failed server outranks a stale image')
  assert.ok(!view({ server: 'starting', stale: two }).text.includes('stale'),
    'no server, no image to be stale against')
  assert.strictEqual(view({ stale: [] }).background, undefined)
  const many = Array.from({ length: 11 }, (_, i) => staleFile(`T${i}.thy`))
  v = view({ stale: many })
  assert.ok(v.tooltip.includes('T7.thy') && !v.tooltip.includes('T8.thy'))
  assert.ok(v.tooltip.includes('3 more…](command:isabelle.showStaleFiles?%5B%5D)'))
  pass('a long list is cut short with a link to all of it')

  // Every command a link names must be one the item trusts, or the link is dead.
  for (const server of ['off', 'starting', 'building', 'running', 'failed']) {
    const tip = view({ server, progress: working, stale: two }).tooltip
    const cmds = [...tip.matchAll(/\(command:([\w.-]+)(\?[^)]*)?\)/g)].map(m => m[1])
    assert.ok(cmds.length > 0)
    for (const cmd of cmds) assert.ok(TOOLTIP_COMMANDS.includes(cmd), `${cmd} is not trusted`)
  }
  pass('every tooltip link is a trusted command')

  // Before activation gets far enough to register the session and server commands.
  t = view({ server: 'failed', controls: false }).tooltip
  assert.deepStrictEqual([...t.matchAll(/\(command:([\w.-]+)\)/g)].map(m => m[1]),
    ['isabelle.showOutput'])
  pass('without controls the tooltip offers only the output')

  assert.strictEqual(escapeMarkdown('a_b*[c](d)'), 'a\\_b\\*\\[c\\]\\(d\\)')
  assert.ok(view({ logic: 'My_Session' }).tooltip.includes('**Isabelle session: My\\_Session**'))
  pass('names and messages cannot inject markdown')

  console.log(passed + ' checks passed')
  console.log('SUITE41_OK')
}

module.exports = { run }

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1) })
}
