// Pure checks for the Theories/Timing rendering helpers -- no prover involved.
//
// These are the parts the end-to-end suite cannot pin down: it can prove that a status
// arrives, but not that a 47%-processed theory renders as something a reader can scan.
const assert = require('assert')
const path = require('path')

const { progressBar, statusIcon, statusDescription } =
  require(path.join(__dirname, '..', 'out', 'theories_panel.js'))
const { documentBody } = require(path.join(__dirname, '..', 'out', 'webview.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

function node(over) {
  return Object.assign({
    uri: 'file:///t/T.thy', theory: 'T', overall: 'pending',
    cumulated_time: 0, max_time: 0, ok: true, total: 100,
    unprocessed: 0, running: 0, warned: 0, failed: 0, finished: 100,
    canceled: false, consolidated: true, percentage: 100,
  }, over)
}

async function run() {
  // Bar: the ends must be unambiguous, since "almost done" and "done" look alike otherwise.
  assert.strictEqual(progressBar(0), '▱▱▱▱▱▱▱▱▱▱')
  assert.strictEqual(progressBar(100), '▰▰▰▰▰▰▰▰▰▰')
  assert.strictEqual(progressBar(50).length, 10)
  assert.strictEqual(progressBar(47), '▰▰▰▰▰▱▱▱▱▱')
  // Out-of-range input must not produce a ragged row.
  assert.strictEqual(progressBar(-10).length, 10)
  assert.strictEqual(progressBar(999), '▰▰▰▰▰▰▰▰▰▰')
  pass('progress bar is fixed width and saturates at both ends')

  // Icon precedence: a failure outranks anything else that is also true of the node.
  assert.strictEqual(statusIcon(node({ failed: 1, running: 3, warned: 2 })).id, 'error')
  assert.strictEqual(statusIcon(node({ canceled: true, running: 3 })).id, 'circle-slash')
  assert.strictEqual(statusIcon(node({ running: 1, warned: 1 })).id, 'sync~spin')
  assert.strictEqual(statusIcon(node({ warned: 1 })).id, 'warning')
  assert.strictEqual(statusIcon(node({})).id, 'pass-filled')
  assert.strictEqual(
    statusIcon(node({ consolidated: false, unprocessed: 5, finished: 95, percentage: 95 })).id,
    'circle-large-outline')
  pass('status icon follows jEdit precedence: failed > canceled > running > warned > ok')

  // Description must name every non-finished bucket, and stay quiet when there is nothing
  // to say -- a row that always ends in ", 0 failed" is noise.
  const busy = statusDescription(node(
    { failed: 2, warned: 1, running: 3, unprocessed: 4, finished: 90, percentage: 90 }))
  for (const part of ['2 failed', '1 warned', '3 running', '4 unprocessed', '90%']) {
    assert.ok(busy.includes(part), `description should mention ${part}: ${busy}`)
  }
  const done = statusDescription(node({}))
  assert.ok(done.endsWith('100%'), `a finished theory needs no tail: ${done}`)
  assert.ok(!done.includes('failed'), done)
  pass('status description reports only the buckets that are non-empty')

  // Preview: the server returns a whole Browser_Info document, and its inlined
  // isabelle.css hardcodes a white page. Embedded as-is it lands after our stylesheet
  // and wins, so a dark theme showed a white preview.
  const doc = [
    '<!DOCTYPE HTML PUBLIC>',
    '<html>',
    '<head><meta charset="utf-8"/>',
    '<style media="all" type="text/css">',
    'body { color: #000000; background-color: #FFFFFF; }',
    '.free { color: #0000FF; }',
    '</style>',
    '<link rel="stylesheet" type="text/css" href="isabelle.css"/>',
    '<title>Theory T</title></head>',
    '<body><div class="head"><h1>Theory T</h1></div>',
    '<pre class="source"><span class="keyword1">lemma</span> x</pre>',
    '</body>',
    '</html>',
  ].join('\n')
  const inner = documentBody(doc)
  assert.ok(!/background-color:\s*#FFFFFF/i.test(inner), 'the white page rule must be gone')
  assert.ok(!/<style/i.test(inner), 'no stylesheet may survive: ' + inner)
  assert.ok(!/<link/i.test(inner), 'no stylesheet link may survive')
  assert.ok(!/<html|<head|<title/i.test(inner), 'document scaffolding must be gone')
  // ...but the markup our own CSS colours has to survive intact.
  assert.ok(inner.includes('class="keyword1"'), 'Isabelle markup classes must be kept')
  assert.ok(inner.includes('<h1>Theory T</h1>'), 'the rendered body must be kept')
  pass('preview strips the document scaffolding and Isabelle stylesheet, keeps the markup')

  // A fragment (or anything unparsable) must pass through rather than vanish.
  assert.strictEqual(documentBody('<p class="free">x</p>'), '<p class="free">x</p>')
  pass('preview leaves a plain fragment alone')

  console.log(`${passed} checks passed`)
  console.log('SUITE16_OK')
}

module.exports.run = () => run().catch(err => {
  console.error('FAIL: ' + (err && err.stack || err))
  process.exit(1)
})
