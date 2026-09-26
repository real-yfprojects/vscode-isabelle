// Cuts a release: gives package.json the next version, commits that and tags the commit.
// It does not push. Pushing the tag is what publishes: .github/workflows/release.yml runs
// CI on the tagged commit and puts the .vsix CI built on the Marketplace and on a GitHub
// release.
//
//   npm run release                # e.g. v2026.9.0, and v2026.9.1 for the next one that month
//   npm run release -- --dry-run   # only say which version it would be
//   git push --atomic origin main v2026.9.0
//
// Versions are YYYY.M.N: year and month of the release, and a counter from 0 that starts
// over every month. Nothing else fits the Marketplace, which takes three plain numbers
// only -- no zero padding (2026.09.0 is not semver, and vsce refuses it) and no suffix
// (vsce publish refuses 2026.9.26-1 as a "prerelease version"). A pre-release is a flag on
// the upload, not a different kind of number.

const { spawnSync } = require('child_process')
const path = require('path')

const REPO = path.join(__dirname, '..')
const BRANCH = 'main'
const dryRun = process.argv.includes('--dry-run')

function run(cmd, args, { capture = true } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: REPO,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    // npm is npm.cmd on Windows, which Node refuses to spawn without a shell.
    shell: process.platform === 'win32' && cmd === 'npm',
  })
  if (r.status !== 0) {
    console.error(`release: ${cmd} ${args.join(' ')} failed`)
    process.exit(1)
  }
  return capture ? r.stdout.trim() : ''
}

function fail(message) {
  if (dryRun) { console.warn(`warning: ${message}`); return }
  console.error(`release: ${message}`)
  process.exit(1)
}

const parse = v => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v)
  return m && m.slice(1, 4).map(Number)
}
const newer = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

// A release is cut from main as it is on GitHub, plus whatever is about to be pushed with
// it -- never from a checkout that is missing commits already there.
if (run('git', ['branch', '--show-current']) !== BRANCH) fail(`not on ${BRANCH}`)
if (run('git', ['status', '--porcelain', '--untracked-files=no'])) {
  fail('uncommitted changes; commit or stash them first')
}
run('git', ['fetch', '--quiet', '--tags', 'origin', BRANCH])
const behind = spawnSync('git', ['merge-base', '--is-ancestor', `origin/${BRANCH}`, 'HEAD'],
  { cwd: REPO }).status !== 0
if (behind) fail(`origin/${BRANCH} has commits this checkout lacks; pull first`)

// The counter comes from the tags, not from package.json: package.json only learns the
// version in the release commit, and a tag is the one record of what was published.
const now = new Date()
const year = now.getFullYear(), month = now.getMonth() + 1
const tags = run('git', ['tag', '--list', 'v*']).split('\n').map(parse).filter(Boolean)
const counter = tags
  .filter(([y, m]) => y === year && m === month)
  .reduce((next, [, , n]) => Math.max(next, n + 1), 0)
const version = [year, month, counter]
const name = version.join('.')

// Every upload must carry a higher version than any before it. Only a wrong clock or a
// hand-made tag could break that here, but the Marketplace would refuse the upload only
// after CI has spent an hour on the tag.
const current = parse(require(path.join(REPO, 'package.json')).version)
for (const previous of [current, ...tags]) {
  if (previous && !newer(version, previous)) {
    fail(`${name} is not newer than ${previous.join('.')} -- is the clock right?`)
  }
}

if (dryRun) {
  console.log(`next release: v${name}`)
  process.exit(0)
}

// Updates package-lock.json too, and keeps both files' formatting.
run('npm', ['version', name, '--no-git-tag-version'])
run('git', ['add', 'package.json', 'package-lock.json'])
run('git', ['commit', '--quiet', '-m', `Release ${name}`], { capture: false })
run('git', ['tag', '-a', `v${name}`, '-m', `Release ${name}`])

console.log(`Tagged v${name}. To publish it:

  git push --atomic origin ${BRANCH} v${name}

To undo instead (nothing has left this machine yet):

  git tag -d v${name} && git reset --keep HEAD~1`)
