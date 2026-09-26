// Seeds an isolated VS Code profile for a dev run of this extension.
//
// The profile lives at <repo>/.dev-profile (git-ignored) and is passed to VS Code as
// --user-data-dir, so the dev run never touches your real settings, keybindings or
// installed extensions. Its settings.json points the extension at an Isabelle whose
// language server answers the experimental panels -- the stock one with the extended
// server, or a patched build -- and turns those views on.
//
// Runnable on its own (`node test/dev-profile.js`) or required by test/dev.js and the
// F5 launch config's preLaunchTask.

const fs = require('fs')
const path = require('path')
const { REPO, isDistribution, findStockHome, ensureJar } = require('../scripts/server-jar')

const PROFILE = path.join(REPO, '.dev-profile')

/**
 * The Isabelle the dev run talks to, with a language server that answers the messages of
 * the experimental panels. Same order as the suites (test/server_target.js): an explicit
 * patched build wins; otherwise the stock distribution with the extended server, whose jar
 * is rebuilt first if its source has changed (scripts/server-jar.js).
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
    return { home: explicit, extended: false, source: 'ISABELLE_PATCHED_HOME' }
  }

  const stock = findStockHome()
  if (!stock) {
    throw new Error('No Isabelle found. Set ISABELLE_HOME, or install one under ~/Isabelle.')
  }
  const from = ensureJar(stock)
  return { home: stock, extended: true, source: `stock, with the extended server from ${from}` }
}

function seed() {
  const { home, extended, source } = resolveHome()
  const userDir = path.join(PROFILE, 'User')
  fs.mkdirSync(userDir, { recursive: true })

  const settings = {
    'isabelle.home': home,
    'isabelle.extendedServer': extended,
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
