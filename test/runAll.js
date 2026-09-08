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
// (15, 17) or a project workspace (24) skip themselves, so they are not listed here.
const REGRESSION = ['suite', 'suite2', 'suite4', 'suite6', 'suite12', 'suite16',
                    'suite18', 'suite19', 'suite21', 'suite23', 'suite26']

/** Suites that need no editor at all, and so cost nothing to run. */
const PURE = new Set(['suite25'])

function copyWorkspace(name) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), `isa-ws-${name}-`))
  fs.cpSync(path.join(__dirname, 'workspace'), dest, { recursive: true })
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
      // A suite can exit 0 having printed nothing useful, so require its own marker too.
      const ok = code === 0 && /SUITE\w*_OK|checks passed/.test(out)
      if (workspace) fs.rmSync(workspace, { recursive: true, force: true })
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
