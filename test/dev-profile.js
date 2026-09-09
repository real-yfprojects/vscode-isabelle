// Seeds an isolated VS Code profile for a dev run of this extension.
//
// The profile lives at <repo>/.dev-profile (git-ignored) and is passed to VS Code as
// --user-data-dir, so the dev run never touches your real settings, keybindings or
// installed extensions. Its settings.json points the extension at a PATCHED Isabelle
// and turns on the views that a released distribution cannot answer.
//
// Runnable on its own (`node test/dev-profile.js`) or required by test/dev.js and the
// F5 launch config's preLaunchTask.

const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.join(__dirname, '..')
const PROFILE = path.join(REPO, '.dev-profile')

const isDistribution = dir => {
  try {
    return fs.statSync(path.join(dir, 'bin', 'isabelle')).isFile() &&
      fs.statSync(path.join(dir, 'etc', 'symbols')).isFile()
  } catch { return false }
}

/** Newest `Isabelle*-{query,theories,patched}` sibling under ~/Isabelle, if any. */
function scanForPatched() {
  const parent = path.join(os.homedir(), 'Isabelle')
  let entries
  try { entries = fs.readdirSync(parent) } catch { return undefined }
  return entries
    .filter(n => /^Isabelle\d{4}(-\d+)?-(query|theories|patched)$/.test(n))
    .map(n => path.join(parent, n))
    .filter(isDistribution)
    .sort()
    .pop()
}

/**
 * A PATCHED build whose language server answers PIDE/theories_request (and
 * PIDE/query_*). Same resolution order as the suites: an explicit env var wins,
 * otherwise guess from the naming convention -- see GAPS.md "Reproducing the build".
 */
function resolveHome() {
  const explicit =
    process.env.ISABELLE_PATCHED_HOME || process.env.ISABELLE_QUERY_HOME
  if (explicit) {
    if (!isDistribution(explicit)) {
      throw new Error(
        `ISABELLE_PATCHED_HOME is "${explicit}", which is not an Isabelle ` +
        `distribution (expected bin/isabelle and etc/symbols beneath it).`)
    }
    return { home: explicit, source: 'ISABELLE_PATCHED_HOME' }
  }
  const scanned = scanForPatched()
  if (scanned) return { home: scanned, source: `guessed from ~/Isabelle` }
  throw new Error(
    'No patched Isabelle found. Set ISABELLE_PATCHED_HOME to a build whose ' +
    'language server answers PIDE/theories_request, or place it at ' +
    '~/Isabelle/Isabelle<year>-<n>-theories -- see GAPS.md "Reproducing the build".')
}

function seed() {
  const { home, source } = resolveHome()
  const userDir = path.join(PROFILE, 'User')
  fs.mkdirSync(userDir, { recursive: true })

  const settings = {
    'isabelle.home': home,
    // The views that need a patched server; harmless to leave on. Without these the
    // panels never register, and their palette commands report "command not found".
    'isabelle.theoriesPanel': true,
    'isabelle.queryPanel': true,
    'isabelle.simplifierTrace': true,
    'isabelle.graphview': true,
    // Keep every command that took at least a millisecond, so a small theory still
    // fills the Timing view.
    'isabelle.timingThreshold': 0,
    'isabelle.verbose': true,
    // README: the symbols above U+FFFF need Isabelle's own font, installed system-wide.
    'editor.fontFamily': "'Isabelle DejaVu Sans Mono', monospace",
    'workbench.startupEditor': 'none',
    'window.title': 'DEV EXT HOST -- ${activeEditorShort}',
  }
  fs.writeFileSync(
    path.join(userDir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n')

  console.log(`dev profile: ${PROFILE}`)
  console.log(`isabelle.home: ${home}  (${source})`)
  return { profile: PROFILE, home }
}

module.exports = { seed, PROFILE, REPO }

if (require.main === module) {
  try { seed() }
  catch (err) { console.error(String(err.message || err)); process.exit(1) }
}
