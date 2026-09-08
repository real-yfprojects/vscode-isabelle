// Pure checks for the server restart policy -- no prover, no editor.
//
// This suite exists because of a real, expensive failure. viper-roots' MainResults could
// not build its requirements image (a `sorry` in an imported theory, with quick_and_dirty
// off), and each attempt took about twenty minutes. The language client's default error
// handler gives up only when five closes land inside three minutes, so with nineteen
// minutes between them the window never closed: the extension rebuilt, failed, and
// restarted for hours. Two of those builds then overlapped and collided on
//
//   [SQLITE_CONSTRAINT_PRIMARYKEY] ... UNIQUE constraint failed:
//   isabelle_sources.session_name, isabelle_sources.name
//
// because Store.write_session_info inserts a session's rows outright and trusts the
// clean_session_info that Store.clean_output ran at session init to have cleared them --
// which holds for one builder and not for two. A wall-clock rule cannot express any of
// that, which is why the policy keys on whether the server ever ran instead.
const assert = require('assert')
const path = require('path')

const { closeVerdict, MAX_RESTARTS } =
  require(path.join(__dirname, '..', 'out', 'restart_policy.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

async function run() {
  // --- the loop that prompted this -------------------------------------------------
  // A start that never reached Running must not come back on its own, however long ago
  // the previous attempt was: nothing has changed, so the same build fails the same way.
  for (const restarts of [0, 1, 5, 99]) {
    const v = closeVerdict({ everRunning: false, restarts })
    assert.strictEqual(v.restart, false,
      `a failed start must not restart (after ${restarts} closes)`)
    assert.ok(/will not be restarted/.test(v.message), 'the refusal must say so')
  }
  pass('a server that never started is never restarted automatically')

  // The message has to point somewhere useful: the build error is in the output channel,
  // and the way back is the command, not a reload.
  const failed = closeVerdict({ everRunning: false, restarts: 0, logic: 'MainResults (requirements)' })
  assert.ok(failed.message.includes('MainResults (requirements)'),
    'the message should name the session whose build failed')
  assert.ok(failed.message.includes('Isabelle: Restart Server'),
    'the message should name the command that retries')
  assert.ok(/output channel/i.test(failed.message),
    'the message should point at the build error')
  pass('the refusal names the session, the log and the way to retry')

  // --- what restarts are actually for ----------------------------------------------
  // A prover that died after a healthy start should come back: its heap exists, so a
  // restart is cheap and usually right.
  for (let i = 0; i < MAX_RESTARTS; i++) {
    assert.strictEqual(closeVerdict({ everRunning: true, restarts: i }).restart, true,
      `a crash after a good start should restart (attempt ${i + 1})`)
  }
  pass(`a server that had been running restarts up to ${MAX_RESTARTS} times`)

  // Bounded by count alone. The elapsed-time reset is what made the default unbounded, so
  // there is deliberately no clock here to run out.
  const spent = closeVerdict({ everRunning: true, restarts: MAX_RESTARTS })
  assert.strictEqual(spent.restart, false, 'restarts must be capped')
  assert.ok(/will not be restarted/.test(spent.message), 'the cap must explain itself')
  assert.strictEqual(closeVerdict({ everRunning: true, restarts: MAX_RESTARTS + 50 }).restart, false,
    'past the cap it stays refused')
  pass('restarts are capped by count, with no time window to reset it')

  // The cap is configurable so the policy can be asserted without hard-coding the default.
  assert.strictEqual(closeVerdict({ everRunning: true, restarts: 0, maxRestarts: 0 }).restart, false,
    'maxRestarts 0 should refuse immediately')
  assert.strictEqual(closeVerdict({ everRunning: true, restarts: 1, maxRestarts: 2 }).restart, true,
    'maxRestarts should be honoured')
  pass('the restart budget is a parameter, not a constant baked into the rule')

  console.log(passed + ' checks passed')
  console.log('SUITE28_OK')
}

module.exports = { run }

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1) })
}
