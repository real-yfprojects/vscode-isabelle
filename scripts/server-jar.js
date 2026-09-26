// Brings server/<IDENTIFIER>.jar up to date for the Isabelle you use: rebuilds it only if
// its source has changed since the last build (scripts/build-server-jar.sh --if-stale),
// so it costs a second when nothing did and a full Isabelle/Scala compile when something
// did. `npm run build` runs it after compiling the extension, and so does the dev
// launcher before every start.
//
//   node scripts/server-jar.js
//
// The Isabelle is ISABELLE_HOME, else the newest ~/Isabelle/Isabelle<year>-<n> -- the one
// the extension finds by default. The source is ISABELLE_SERVER_SOURCE, else the
// vscode-2025-2 worktree beside this repository (../mirror-2025-2), else the commit
// pinned in server/<IDENTIFIER>.ref.

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.join(__dirname, '..')

const isDistribution = dir => {
  try {
    return fs.statSync(path.join(dir, 'bin', 'isabelle')).isFile() &&
      fs.statSync(path.join(dir, 'etc', 'symbols')).isFile()
  } catch { return false }
}

/** The stock Isabelle, found as the extension would find it. */
function findStockHome() {
  if (process.env.ISABELLE_HOME && isDistribution(process.env.ISABELLE_HOME)) {
    return process.env.ISABELLE_HOME
  }
  const parent = path.join(os.homedir(), 'Isabelle')
  let entries
  try { entries = fs.readdirSync(parent) } catch { return undefined }
  return entries
    .filter(n => /^Isabelle\d{4}(-\d+)?$/.test(n))
    .map(n => path.join(parent, n))
    .filter(isDistribution)
    .sort()
    .pop()
}

/** The checkout to build from, if any; without one, the pinned commit is fetched. */
function serverSource() {
  if (process.env.ISABELLE_SERVER_SOURCE) return path.resolve(process.env.ISABELLE_SERVER_SOURCE)
  const sibling = path.join(REPO, '..', 'mirror-2025-2')
  return fs.existsSync(path.join(sibling, '.git')) ? sibling : undefined
}

/** Git's bash: on Windows, the first `bash` on PATH can be WSL's. */
function gitBash() {
  if (process.platform !== 'win32') return 'bash'
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim()
  for (const candidate of ['../../../bin/bash.exe', '../../../usr/bin/bash.exe']) {
    const bash = path.resolve(exec, candidate)
    if (fs.existsSync(bash)) return bash
  }
  throw new Error('Git Bash not found; the extended server is built by a bash script.')
}

/** Rebuild the jar for `home` unless it is current; returns where it was built from. */
function ensureJar(home) {
  const source = serverSource()
  const slashes = p => p.replace(/\\/g, '/')  // bash takes C:/..., not C:\...
  const args = [slashes(path.join(REPO, 'scripts', 'build-server-jar.sh')), '--if-stale',
    slashes(home)]
  if (source) args.push(slashes(source))
  const r = spawnSync(gitBash(), args, { cwd: REPO, stdio: 'inherit' })
  if (r.status !== 0) throw new Error('Building the extended server failed (see above).')
  return source ?? 'the commit in server/*.ref'
}

module.exports = { REPO, isDistribution, findStockHome, ensureJar }

if (require.main === module) {
  try {
    const home = findStockHome()
    if (!home) throw new Error('No Isabelle found. Set ISABELLE_HOME, or install one under ~/Isabelle.')
    console.log(`extended server for ${home}, from ${ensureJar(home)}`)
  } catch (err) {
    console.error(String(err.message || err))
    process.exit(1)
  }
}
