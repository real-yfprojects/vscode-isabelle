// Run several suites at once.
//
//   node test/runAll.js                    # the regression set
//   node test/runAll.js suite4 suite16     # just these
//   ISABELLE_TEST_JOBS=2 node test/runAll.js
//
// Each suite gets its own copy of test/workspace, because most of them write into it and
// concurrent editors over one directory race in ways that look like flaky assertions.
// runTest.js already gives every instance its own --user-data-dir.
//
// The concurrency default is deliberately low. A suite is a whole VS Code plus, for the
// integration ones, a JVM and a Poly/ML process; oversubscribing turns a timeout-based
// assertion into a coin flip. Suites that need a prover are the slow ones, and running
// four of those at once on a 12-thread machine is already past the point where the
// machine, not the code, decides whether they pass.

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// The set that is expected to be green at all times. The suites for the experimental
// panels and server features (15, 17, 30, 33, 36, 37, 45, 62, 65) run against the extended server
// when its jar is built, as in CI, and skip themselves otherwise (test/server_target.js).
// suite24 also needs a project workspace, so it is not listed.
const REGRESSION = ['suite', 'suite2', 'suite4', 'suite6', 'suite12', 'suite15', 'suite16',
                    'suite17', 'suite18', 'suite19', 'suite21', 'suite23', 'suite25',
                    'suite26', 'suite27', 'suite28', 'suite29', 'suite30', 'suite31',
                    'suite32', 'suite33', 'suite34', 'suite35', 'suite36', 'suite37',
                    'suite38', 'suite39', 'suite40', 'suite41', 'suite42', 'suite43',
                    'suite44', 'suite45', 'suite46', 'suite47', 'suite48', 'suite49', 'suite50',
                    'suite51', 'suite52', 'suite53', 'suite54', 'suite60', 'suite61', 'suite62',
                    'suite63', 'suite64', 'suite65', 'suite66', 'suite67',
                    'suite68', 'suite69', 'suite70']

/**
 * Suites that need the editor to have focus: they type through VS Code's `type` command,
 * which goes only to the focused editor, take ghost text, which VS Code shows only there, or
 * fold and undo (suite4), which act on the focused editor and did nothing beside another.
 * Two test windows at once take it from each other: on macOS only the frontmost window's
 * editor has focus at all, and suite35's keystrokes went nowhere there, refocusing included;
 * on Linux both windows can say they are focused while neither editor is, and the ghost text
 * of suite61 and suite62 never came -- their fallback for an unfocused window is not taken
 * when the window claims focus. These run after the others, one at a time.
 */
const ALONE = new Set(['suite4', 'suite35', 'suite37', 'suite61', 'suite62'])

/**
 * Seconds each suite took on the macOS CI runner (the slowest of the three), the longest of
 * three runs: to split the set into shards of about equal length, and to start the long
 * suites first. Only the proportions matter; a suite not listed counts as DEFAULT_SECONDS.
 */
const SECONDS = {
  suite36: 329, suite64: 216, suite68: 179, suite30: 94, suite53: 93, suite: 88, suite33: 87,
  suite52: 86, suite54: 79, suite15: 76, suite65: 72, suite12: 68, suite23: 65, suite39: 63,
  suite6: 55, suite47: 54, suite2: 52, suite21: 49, suite62: 49, suite4: 45, suite61: 45,
  suite17: 44, suite45: 43, suite51: 41, suite37: 34, suite18: 32, suite69: 28, suite16: 22,
  suite26: 22, suite19: 21, suite35: 20, suite50: 18, suite40: 16, suite63: 16, suite31: 12,
  suite43: 12,
}
const DEFAULT_SECONDS = 60
const seconds = name => PURE.has(name) ? 0 : SECONDS[name] ?? DEFAULT_SECONDS

/**
 * The suites of shard `index` (1-based) of `count`, for CI to run the set on several runners
 * at once: each suite on exactly one, each runner with its own editors and provers, so the
 * suites interact no more than they do on one. Every shard computes the same split: longest
 * suite first, into the shard that is estimated to finish soonest -- where a suite run alone
 * costs its whole length and the others share the runner `jobs` at a time.
 */
function shard(suites, index, count, jobs) {
  const load = Array.from({ length: count }, () => ({ together: 0, alone: 0, names: new Set() }))
  const length = l => l.together / jobs + l.alone
  const ordered = [...suites].sort((a, b) => seconds(b) - seconds(a) || a.localeCompare(b))
  for (const name of ordered) {
    const add = l => ALONE.has(name) ? { ...l, alone: l.alone + seconds(name) }
      : { ...l, together: l.together + seconds(name) }
    let best = 0
    for (let i = 1; i < count; i++) if (length(add(load[i])) < length(add(load[best]))) best = i
    load[best] = { ...add(load[best]), names: load[best].names.add(name) }
  }
  return { names: suites.filter(n => load[index - 1].names.has(n)), seconds: Math.round(length(load[index - 1])) }
}

/** Suites that need no editor at all, and so cost nothing to run. */
const PURE = new Set(['suite25', 'suite27', 'suite28', 'suite29', 'suite31', 'suite32',
                    'suite34', 'suite38', 'suite41', 'suite42', 'suite44', 'suite46',
                    'suite48', 'suite49', 'suite60', 'suite63', 'suite66', 'suite67',
                    'suite70'])

/**
 * Suites that assert nothing the prover produces.
 *
 * These still need a real editor -- they exercise decorations, motion, the outline and
 * the pick lists -- but activation used to block on startClient(), so each paid a full
 * heap load before its first assertion. Roughly 30 of their 37 seconds was spent waiting
 * for a session none of them looks at. isabelle.autoStart lets them decline it.
 *
 * A suite belongs here only if it never reads serverState, decorations from PIDE, or any
 * panel fed by the server. When in doubt leave it out: the cost of being wrong is a
 * confusing failure, and the cost of being conservative is half a minute.
 */
const NO_PROVER = new Set(['suite4', 'suite16', 'suite19', 'suite21', 'suite26', 'suite35',
                           'suite40', 'suite43', 'suite50', 'suite69'])

/**
 * Suites that must act before the extension activates: set the settings read at
 * activation (the extended server, the Theories panel), or check that nothing has
 * activated it yet. activationEvents has workspaceContains:**\/*.thy, so a workspace with a
 * theory in it activates the extension on startup, before the suite's first line. These
 * get a workspace without theories; each writes the one it needs, after activating.
 */
const NO_THY_AT_START = new Set(['suite17', 'suite50', 'suite54'])

function copyWorkspace(name) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), `isa-ws-${name}-`))
  fs.cpSync(path.join(__dirname, 'workspace'), dest, {
    recursive: true,
    filter: src => !(NO_THY_AT_START.has(name) && src.endsWith('.thy')),
  })
  if (NO_PROVER.has(name)) {
    // Workspace settings rather than an env var, so nothing in the extension has to know
    // it is under test -- this is the same switch a user would flip.
    fs.mkdirSync(path.join(dest, '.vscode'), { recursive: true })
    fs.writeFileSync(path.join(dest, '.vscode', 'settings.json'),
      JSON.stringify({ 'isabelle.autoStart': false }, null, 2))
  }
  return dest
}

function runOne(name) {
  return new Promise(resolve => {
    const started = Date.now()
    const pure = PURE.has(name)
    const workspace = pure ? undefined : copyWorkspace(name)
    const args = pure ? [path.join(__dirname, `${name}.js`)]
                      : [path.join(__dirname, 'runTest.js'), `${name}.js`]
    const env = { ...process.env }
    if (workspace) env.ISABELLE_TEST_WORKSPACE = workspace

    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    child.on('close', code => {
      const seconds = ((Date.now() - started) / 1000).toFixed(0)
      const checks = /(\d+) checks passed/.exec(out)
      /* A suite can exit 0 having printed nothing useful -- that is how suite14 once
         failed silently -- so require its own completion marker too. The marker is not
         uniformly named: the early suites print STEP1_OK/STEP2_OK and the later ones
         SUITEn_OK, so match the shape rather than the prefix. */
      const ok = code === 0 && /\b[A-Z0-9_]+_OK\b|checks passed/.test(out)
      /* Cleanup must never take the run down. On Windows the editor can still hold a
         handle to the copied workspace when the process exits, so rmSync throws EBUSY;
         a leftover temp directory is a far smaller problem than losing the results of
         a five-minute run to an exception in a close handler. */
      if (workspace) {
        try { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) }
        catch { /* the OS will reap it */ }
      }
      resolve({ name, ok, code, seconds, checks: checks ? Number(checks[1]) : undefined, out })
    })
  })
}

async function main() {
  const names = process.argv.slice(2)
  let suites = names.length > 0 ? names.map(n => n.replace(/\.js$/, '')) : REGRESSION
  const jobs = Math.max(1, Number(process.env.ISABELLE_TEST_JOBS) || 3)

  // ISABELLE_TEST_SHARD=i/n runs the i-th of n shards of the set (CI: one per runner).
  const spec = process.env.ISABELLE_TEST_SHARD
  if (spec) {
    const m = /^(\d+)\/(\d+)$/.exec(spec)
    if (!m || +m[1] < 1 || +m[1] > +m[2]) throw new Error(`ISABELLE_TEST_SHARD=${spec}: expected i/n with 1 <= i <= n`)
    const part = shard(suites, +m[1], +m[2], jobs)
    console.log(`shard ${spec}: ${part.names.length} of ${suites.length} suites, about ${part.seconds}s on macOS`)
    suites = part.names
  }

  const solo = suites.filter(n => ALONE.has(n))
  console.log(`running ${suites.length} suite(s), ${jobs} at a time` +
    (solo.length && jobs > 1 ? `, then ${solo.join(', ')} alone` : '') + '\n')
  const started = Date.now()
  // Longest first: a long suite started last would run on alone after all the others.
  const queue = suites.filter(n => !ALONE.has(n)).sort((a, b) => seconds(b) - seconds(a))
  const results = []

  const runAndReport = async name => {
    const r = await runOne(name)
    results.push(r)
    const detail = r.checks !== undefined ? `${r.checks} checks` : `exit ${r.code}`
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${name.padEnd(10)} ${detail}, ${r.seconds}s`)
  }
  const worker = async () => {
    while (queue.length > 0) await runAndReport(queue.shift())
  }
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker))
  for (const name of solo) await runAndReport(name)

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed in ` +
              `${((Date.now() - started) / 1000).toFixed(0)}s`)

  for (const f of failed) {
    console.log(`\n--- ${f.name} ---`)
    // Enough to identify the failure without reprinting a whole editor startup log: from the
    // first error on, so that an assertion keeps the actual/expected lines under it.
    const lines = f.out.split(/\r?\n/)
    // VS Code's own "Error: Error mutex already exists" opens every log and says nothing; so
    // does test-electron's version lookup timing out ("Error retrieving VS Code versions ...
    // TimeoutError: ... request timeout"), which then uses the editor it already has -- taken
    // for the failure, it hid suite68's on a Windows run.
    const first = lines.findIndex(l => /FAIL|AssertionError|Error:|expected|actual|timed out/.test(l) &&
      !/mutex already exists|Error retrieving VS Code versions|TimeoutError: @vscode\/test-electron/.test(l))
    // And the suite's own PASS and progress lines before it: what it printed just before the
    // assertion (a status, a message) is often the whole diagnosis, and a CI log has no more.
    const own = lines.slice(0, first >= 0 ? first : 0).filter(l => /^\s*(PASS|\.\.\.|[a-z][\w ]*: )/.test(l))
    if (own.length) console.log('before it:\n' + own.slice(-12).join('\n') + '\n')
    console.log(first >= 0 ? lines.slice(first, first + 15).join('\n') : f.out.slice(-1500))
  }

  process.exit(failed.length > 0 ? 1 : 0)
}

main()
