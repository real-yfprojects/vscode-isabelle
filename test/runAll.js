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

// The set that is expected to be green at all times. Suites needing a patched Isabelle
// (15, 17, 30) or a project workspace (24) skip themselves, so they are not listed here.
const REGRESSION = ['suite', 'suite2', 'suite4', 'suite6', 'suite12', 'suite16',
                    'suite18', 'suite19', 'suite21', 'suite23', 'suite25', 'suite26',
                    'suite27', 'suite28', 'suite29']

/** Suites that need no editor at all, and so cost nothing to run. */
const PURE = new Set(['suite25', 'suite27', 'suite28', 'suite29'])

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
const NO_PROVER = new Set(['suite4', 'suite16', 'suite19', 'suite21', 'suite26'])

function copyWorkspace(name) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), `isa-ws-${name}-`))
  fs.cpSync(path.join(__dirname, 'workspace'), dest, { recursive: true })
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
  const suites = names.length > 0 ? names.map(n => n.replace(/\.js$/, '')) : REGRESSION
  const jobs = Math.max(1, Number(process.env.ISABELLE_TEST_JOBS) || 3)

  console.log(`running ${suites.length} suite(s), ${jobs} at a time\n`)
  const started = Date.now()
  const queue = [...suites]
  const results = []

  const worker = async () => {
    while (queue.length > 0) {
      const name = queue.shift()
      const r = await runOne(name)
      results.push(r)
      const detail = r.checks !== undefined ? `${r.checks} checks` : `exit ${r.code}`
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${name.padEnd(10)} ${detail}, ${r.seconds}s`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, suites.length) }, worker))

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed in ` +
              `${((Date.now() - started) / 1000).toFixed(0)}s`)

  for (const f of failed) {
    console.log(`\n--- ${f.name} ---`)
    // Enough to identify the failure without reprinting a whole editor startup log.
    const lines = f.out.split(/\r?\n/)
      .filter(l => /FAIL|AssertionError|Error:|expected|actual|timed out/.test(l))
    console.log(lines.slice(0, 15).join('\n') || f.out.slice(-1500))
  }

  process.exit(failed.length > 0 ? 1 : 0)
}

main()
