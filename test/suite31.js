// Pure checks for killing the server's process tree.
//
// The failure being held down: a `isabelle vscode_server` that does not end takes a JVM
// and a Poly/ML process with it. Released Isabelle answers stdin EOF with a log line and
// returns without stopping the session (the mirror-isabelle fix changes that, but a stock
// distribution never will), and a prover wedged inside `session.stop()` is beyond any
// server-side fix at all. Every extension host that went away without a clean shutdown
// left the whole stack running; two such stacks, four and eight hours old, were holding
// about 3 GB when a new launch finally failed because Cygwin could no longer build the
// process tree.
//
// Checked against real processes rather than mocks, because the bug this replaces was
// about what the operating system does, not what our code believes it does: killing a
// parent does not kill its children.
const assert = require('assert')
const path = require('path')
const { spawn } = require('child_process')

const { killTreeCommand, isRunning, killTree } =
  require(path.join(__dirname, '..', 'out', 'process_tree.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

const POSIX = process.platform !== 'win32'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A two-level process tree standing in for bash -> bash -> JVM: what matters is only that
 * the process we hold a pid for is not the one that has to die.
 *
 * Spawned the way the server is -- its own process group on POSIX, plain on Windows -- so
 * the kill path under test is the one the extension actually uses.
 */
function spawnTree() {
  const grandchild = 'setInterval(() => {}, 1000)'
  const source =
    `const { spawn } = require('child_process');` +
    `const c = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], ` +
    `  { stdio: 'ignore' });` +
    `console.log(c.pid);` +
    `setInterval(() => {}, 1000);`
  const parent = spawn(process.execPath, ['-e', source],
    { stdio: ['ignore', 'pipe', 'ignore'], detached: POSIX })
  return new Promise((resolve, reject) => {
    let out = ''
    parent.stdout.on('data', d => {
      out += d.toString()
      const line = out.split('\n')[0].trim()
      if (line) resolve({ parentPid: parent.pid, childPid: Number(line) })
    })
    parent.on('error', reject)
    setTimeout(() => reject(new Error('child tree did not report its grandchild')), 10000)
  })
}

/** Poll until both pids are gone, or give up and report what survived. */
async function awaitGone(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const alive = pids.filter(isRunning)
    if (alive.length === 0) return []
    if (Date.now() > deadline) return alive
    await sleep(100)
  }
}

async function run() {
  // --- the kill recipe follows the platform, not the host --------------------------
  // Windows needs /T explicitly: without it taskkill ends the Cygwin bash we spawned and
  // re-parents the JVM, which is the orphan this whole file exists to prevent.
  const win = killTreeCommand(4321, 'win32')
  assert.deepStrictEqual(win, ['taskkill', '/PID', '4321', '/T', '/F'])
  assert.ok(win.includes('/T'), 'the tree flag is the point of the Windows branch')
  assert.strictEqual(killTreeCommand(4321, 'linux'), undefined)
  assert.strictEqual(killTreeCommand(4321, 'darwin'), undefined,
    'POSIX signals the process group instead of shelling out')
  pass('the tree-kill recipe is chosen by platform and always walks descendants')

  // --- liveness ---------------------------------------------------------------------
  assert.strictEqual(isRunning(process.pid), true)
  assert.strictEqual(isRunning(0), false, 'pid 0 is a signal-to-my-group trap, not a process')
  assert.strictEqual(isRunning(-1), false, 'a negative pid addresses a group, never a process')
  assert.strictEqual(isRunning(NaN), false)
  // A pid that cannot exist. Chosen far above the default pid_max so it is free.
  assert.strictEqual(isRunning(0x7ffffff0), false)
  pass('isRunning answers for this process and rejects the pids that are not processes')

  // --- killing a tree, for real -----------------------------------------------------
  {
    const { parentPid, childPid } = await spawnTree()
    assert.ok(isRunning(parentPid) && isRunning(childPid), 'the fixture tree should be up')

    // What the old code did: end our own child and nothing else. The grandchild survives,
    // which is exactly the shape of the orphaned JVMs found on the machine.
    process.kill(parentPid, POSIX ? 'SIGKILL' : undefined)
    await awaitGone([parentPid], 5000)
    assert.strictEqual(isRunning(childPid), true,
      'killing only the spawned process must leave the grandchild orphaned -- ' +
      'if this ever fails the regression it guards has changed shape')
    pass('killing the spawned process alone orphans everything below it')

    // The grandchild is now parentless, so nothing can reach it by tree any more; clean
    // it up directly rather than leaving the test's own orphan behind.
    await killTree(childPid, {})
    assert.deepStrictEqual(await awaitGone([childPid], 5000), [])
  }

  {
    const { parentPid, childPid } = await spawnTree()
    await killTree(parentPid, { ownGroup: POSIX })
    assert.deepStrictEqual(await awaitGone([parentPid, childPid], 10000), [],
      'killTree must take the whole tree, not just the process it was given')
    pass('killTree ends the process and every descendant')
  }

  // Cleaning up something already gone is the common case, and must not throw.
  await killTree(0x7ffffff0, {})
  pass('killing a process that is already gone is not an error')

  console.log(passed + ' checks passed')
  console.log('SUITE31_OK')
}

module.exports = { run }

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1) })
}
