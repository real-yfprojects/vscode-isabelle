// Download the test editor for CI, giving up on an attempt that hangs and trying once more.
// Prints the editor's path on stdout (for VSCODE_TEST_EXECUTABLE); progress goes to stderr.
//
// The download normally takes 8-20 s. On macOS it once ran past ten minutes with no log
// to say why: @vscode/test-electron abandons a download only after 15 s without a byte, so
// a CDN that trickles never trips it, and the `unzip` it spawns has no limit at all. So the
// download runs in a child of its own, killed with everything it started when time is up.
// The library clears the target directory before it starts, so a retry begins clean.
const cp = require('child_process')
const path = require('path')

const LIMIT_MS = 3 * 60_000
const ATTEMPTS = 2
const root = path.join(__dirname, '..')

const FETCH = `require('@vscode/test-electron').downloadAndUnzipVSCode()
  .then(p => console.log('EDITOR=' + p), e => { console.error(e); process.exit(1) })`

/** Kill the child and whatever it spawned: a process group on POSIX, a tree on Windows. */
function killTree(child) {
  try {
    if (process.platform === 'win32') {
      cp.spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    } else {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch { /* already gone */ }
}

function attempt() {
  return new Promise(resolve => {
    const child = cp.spawn(process.execPath, ['-e', FETCH], {
      cwd: root,
      detached: process.platform !== 'win32',   // its own process group, for killTree
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let out = ''
    child.stdout.on('data', d => { out += d; process.stderr.write(d) })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killTree(child) }, LIMIT_MS)
    child.on('close', code => {
      clearTimeout(timer)
      const m = /^EDITOR=(.*)$/m.exec(out)
      if (code === 0 && m) return resolve(m[1].trim())
      console.error(timedOut
        ? `::warning::the editor download took over ${LIMIT_MS / 60_000} minutes; abandoned`
        : `::warning::the editor download failed (exit ${code})`)
      resolve(undefined)
    })
  })
}

async function main() {
  for (let i = 1; i <= ATTEMPTS; i++) {
    const exe = await attempt()
    if (exe) { console.log(exe); return }
    if (i < ATTEMPTS) console.error(`retrying (${i + 1} of ${ATTEMPTS})`)
  }
  console.error(`::error::no test editor after ${ATTEMPTS} attempts`)
  process.exit(1)
}

main()
