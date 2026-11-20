// Pure checks for finding an Isabelle distribution (discovery.ts) -- no prover, no editor.
//
// The scan is what a new user meets first, and for a long time nothing ran it: CI handed
// every suite ISABELLE_HOME, and the setting or the variable wins before any folder is
// looked at. So it could not find a macOS installation at all -- the release unpacks to
// Isabelle2026.app, a name the scan did not accept -- and it never looked at the Desktop,
// where the Windows installer puts Isabelle unless told otherwise.
//
// The fake installations below are laid out as Isabelle's own build_release.scala lays
// out the real ones. suite74 checks a real installation, in CI.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { IsabelleNotFound, discoverIsabelleHome, distributionIn, isDistribution,
  scanForDistribution, searchRoots } = require(path.join(__dirname, '..', 'out', 'discovery.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'isa-discovery-'))
const dir = (...parts) => {
  const d = path.join(tmp, ...parts)
  fs.mkdirSync(d, { recursive: true })
  return d
}

/** bin/isabelle and etc/symbols: what isDistribution, and so the extension, looks for. */
function distribution(home) {
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(home, 'etc'), { recursive: true })
  fs.writeFileSync(path.join(home, 'bin', 'isabelle'), '#!/usr/bin/env bash\n')
  fs.writeFileSync(path.join(home, 'etc', 'symbols'), '')
  return home
}

/** Up to Isabelle2025-2 the .app is the distribution, with Contents/ beside bin/ and etc/. */
function app2025(parent, name) {
  const app = distribution(path.join(parent, `${name}.app`))
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
  return app
}

/**
 * From Isabelle2026, the distribution is .app/Contents/Resources and the .app root holds a
 * symlink to each of its entries. Directory junctions on Windows, which need no privilege;
 * the relative links of the real bundle elsewhere.
 */
function app2026(parent, name) {
  const app = path.join(parent, `${name}.app`)
  const resources = distribution(path.join(app, 'Contents', 'Resources'))
  for (const entry of fs.readdirSync(resources)) {
    const target = path.join(resources, entry)
    const link = path.join(app, entry)
    if (process.platform === 'win32') fs.symlinkSync(target, link, 'junction')
    else fs.symlinkSync(path.join('Contents', 'Resources', entry), link)
  }
  return { app, resources }
}

async function run() {
  try {
    // --- the layouts, one at a time --------------------------------------------------
    const plain = distribution(path.join(dir('plain'), 'Isabelle2026'))
    assert.strictEqual(scanForDistribution(path.join(tmp, 'plain')), plain)
    pass('a plain Isabelle2026 folder (Linux, Windows) is found')

    const old = app2025(dir('mac2025'), 'Isabelle2025-2')
    assert.strictEqual(scanForDistribution(path.join(tmp, 'mac2025')), old)
    pass('an Isabelle2025-2.app, which is the distribution itself, is found')

    const mac = app2026(dir('mac2026'), 'Isabelle2026')
    assert.ok(isDistribution(mac.app), 'the fixture: bin/isabelle resolves through the .app root')
    assert.strictEqual(scanForDistribution(path.join(tmp, 'mac2026')), mac.resources)
    pass('an Isabelle2026.app is found, as its Contents/Resources')

    // --- which one wins ---------------------------------------------------------------
    const both = dir('both')
    app2025(both, 'Isabelle2025-2')
    const newer = app2026(both, 'Isabelle2026')
    assert.strictEqual(scanForDistribution(both), newer.resources)
    pass('the newest release in a folder wins')

    const point = dir('point')
    app2026(point, 'Isabelle2026')
    const fix = app2026(point, 'Isabelle2026-1')
    assert.strictEqual(scanForDistribution(point), fix.resources,
      'compared as names, Isabelle2026-1.app comes before Isabelle2026.app')
    pass('Isabelle2026-1.app is newer than Isabelle2026.app')

    const broken = dir('broken')
    const older = distribution(path.join(broken, 'Isabelle2025-2'))
    dir('broken', 'Isabelle2026')                 // half-deleted: no bin/isabelle
    dir('broken', 'Isabelle2027.app', 'Contents') // not unpacked yet
    distribution(path.join(broken, 'Isabelle2028.app.bak'))
    distribution(path.join(broken, 'Isabelle-dev'))
    assert.strictEqual(scanForDistribution(broken), older)
    pass('folders that are not a release, or not a distribution, are passed over')

    assert.strictEqual(scanForDistribution(path.join(tmp, 'missing')), undefined)
    pass('a root that does not exist is no error')

    // --- the order of the lookup -----------------------------------------------------
    const roots = [path.join(tmp, 'missing'), path.join(tmp, 'plain'), path.join(tmp, 'mac2026')]
    assert.strictEqual(discoverIsabelleHome({ roots }), plain)
    pass('the first root holding a release wins, as the roots are ordered by preference')

    assert.strictEqual(discoverIsabelleHome({ env: old, roots }), old)
    assert.strictEqual(discoverIsabelleHome({ configured: plain, env: old, roots }), plain)
    assert.strictEqual(discoverIsabelleHome({ configured: `  ${plain}  `, roots: [] }), plain)
    pass('isabelle.home wins over ISABELLE_HOME, which wins over the scan')

    assert.strictEqual(discoverIsabelleHome({ configured: mac.app, roots: [] }), mac.resources)
    assert.strictEqual(distributionIn(mac.app + path.sep), mac.resources)
    assert.strictEqual(discoverIsabelleHome({ configured: old, roots: [] }), old)
    pass('isabelle.home may name the .app itself, in either layout')

    assert.strictEqual(discoverIsabelleHome({ env: path.join(tmp, 'nothing'), roots }), plain)
    pass('an ISABELLE_HOME that is no distribution is passed over')

    const wrong = path.join(mac.resources, 'Isabelle2026')
    assert.throws(() => discoverIsabelleHome({ configured: wrong, roots }),
      err => err instanceof IsabelleNotFound && err.message.includes(wrong) &&
        /Isabelle2026\.app/.test(err.message))
    pass('a wrong isabelle.home is an error naming it, with the macOS form to use')

    assert.throws(() => discoverIsabelleHome({ roots: [path.join(tmp, 'missing'), broken + 'x'] }),
      err => err instanceof IsabelleNotFound && err.message.includes(path.join(tmp, 'missing')))
    pass('finding nothing is an error that says where it looked')

    // --- where each platform looks ---------------------------------------------------
    const mine = searchRoots('darwin', '/Users/u')
    assert.deepStrictEqual(mine, ['/Applications', '/Users/u/Applications', '/Users/u', '/Users/u/Downloads'])
    assert.deepStrictEqual(searchRoots('linux', '/home/u'),
      ['/home/u', '/home/u/Downloads', '/opt', '/usr/local'])
    const win = searchRoots('win32', 'C:\\Users\\u', { OneDrive: 'C:\\Users\\u\\OneDrive - ETH Zurich' })
    assert.deepStrictEqual(win, ['C:\\Users\\u\\Isabelle', 'C:\\Users\\u', 'C:\\Users\\u\\Desktop',
      'C:\\Users\\u\\OneDrive - ETH Zurich\\Desktop', 'C:\\Users\\u\\OneDrive\\Desktop',
      'C:\\Users\\u\\Downloads', 'C:\\'])
    assert.strictEqual(new Set(searchRoots('win32', 'C:\\Users\\u', { OneDrive: 'C:\\Users\\u\\OneDrive' })).size,
      searchRoots('win32', 'C:\\Users\\u', { OneDrive: 'C:\\Users\\u\\OneDrive' }).length)
    pass('each installer\'s default location is searched: /Applications, the Desktop, Downloads, ~')

    if (process.platform === 'win32') {
      // The installers' own defaults, through the real path module: Isabelle2025-2's puts
      // Isabelle on the Desktop, Isabelle2026's (plain 7-Zip) beside the downloaded .exe.
      const home = dir('winhome')
      const desktop = distribution(path.join(dir('winhome', 'Desktop'), 'Isabelle2025-2'))
      assert.strictEqual(discoverIsabelleHome({ roots: searchRoots('win32', home, {}) }), desktop)
      fs.rmSync(path.join(home, 'Desktop'), { recursive: true })
      const downloads = distribution(path.join(dir('winhome', 'Downloads'), 'Isabelle2026'))
      assert.strictEqual(discoverIsabelleHome({ roots: searchRoots('win32', home, {}) }), downloads)
      pass('an Isabelle the Windows installers put on the Desktop or in Downloads is found')
    }

    console.log(passed + ' checks passed')
    console.log('SUITE72_OK')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

module.exports = { run }

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1) })
}
