/* Finding an Isabelle distribution on disk.
 *
 * Kept free of `vscode` so that test/suite72 can check it without an editor, on every
 * platform, against fake installations laid out as the real installers lay them out.
 * findIsabelleHome in isabelle.ts is the wrapper that reads the setting.
 *
 * What the installers produce (Isabelle's own Admin/build_release.scala):
 *
 *   - Linux: a tarball of Isabelle2026/, unpacked wherever the user likes, usually ~.
 *   - macOS: a tarball of Isabelle2026.app, moved to /Applications. Up to Isabelle2025-2
 *     the .app *is* the distribution (bin/, etc/ directly inside); from Isabelle2026 the
 *     distribution is .app/Contents/Resources and the .app root has a symlink to each of
 *     its entries, so .app/bin/isabelle exists in both layouts.
 *   - Windows: a self-extracting 7z, Isabelle2026.exe, whose InstallPath defaults to
 *     %UserDesktop% -- the Desktop, not the home folder.
 *
 * The scan used to accept only names like Isabelle2026, so it never found a macOS
 * installation, and it never looked at the Desktop, so it never found a Windows one
 * installed where the installer suggests. CI did not notice: it handed every suite
 * ISABELLE_HOME, and the scan never ran.
 */

import * as fs from 'fs'
import * as path from 'path'

export class IsabelleNotFound extends Error {}

export function isDistribution(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'bin', 'isabelle')).isFile() &&
      fs.statSync(path.join(dir, 'etc', 'symbols')).isFile()
  } catch { return false }
}

/** Isabelle2026, Isabelle2025-2, Isabelle2026.app, ...: what a release unpacks to. */
const RELEASE = /^Isabelle\d{4}(-\d+)?(\.app)?$/

/**
 * The distribution `dir` holds, if any: an Isabelle2026-style .app's Contents/Resources,
 * where the real files are, in preference to the symlinks at its root -- the server
 * reports theory paths below the real directory, and so does `find` in CI.
 */
export function distributionIn(dir: string): string | undefined {
  if (/\.app[\\/]?$/.test(dir)) {
    const resources = path.join(dir, 'Contents', 'Resources')
    if (isDistribution(resources)) return resources
  }
  return isDistribution(dir) ? dir : undefined
}

/**
 * The newest release-named distribution directly inside `parent`, if any.
 *
 * Ordered by name without ".app": Isabelle2026-1.app sorts before Isabelle2026.app as it
 * stands, because "-" comes before "." -- the older release would win.
 */
export function scanForDistribution(parent: string): string | undefined {
  let entries: string[]
  try { entries = fs.readdirSync(parent) } catch { return undefined }
  const found = entries
    .filter(name => RELEASE.test(name))
    .map(name => ({ key: name.replace(/\.app$/, ''), home: distributionIn(path.join(parent, name)) }))
    .filter((c): c is { key: string, home: string } => c.home !== undefined)
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  return found.pop()?.home
}

/**
 * Where a release is looked for when nothing names one, in order; the first folder that
 * holds one wins. Each platform's installer's own default is among them.
 */
export function searchRoots(
  platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv = {},
): string[] {
  if (platform === 'win32') {
    const p = path.win32
    const roots = [p.join(home, 'Isabelle'), home, p.join(home, 'Desktop')]
    /* With OneDrive's folder backup on, as Windows sets it up by default, the Desktop the
       installer means is OneDrive's -- and that folder's name varies ("OneDrive - ETH
       Zurich"), which the variable knows. */
    if (env.OneDrive) roots.push(p.join(env.OneDrive, 'Desktop'))
    roots.push(p.join(home, 'OneDrive', 'Desktop'), 'C:\\')
    return [...new Set(roots)]
  }
  if (platform === 'darwin') return ['/Applications', path.posix.join(home, 'Applications'), home]
  return [home, '/opt', '/usr/local']
}

export interface Lookup {
  /** isabelle.home */
  configured?: string
  /** $ISABELLE_HOME */
  env?: string
  roots: string[]
}

/** The distribution to run: the setting, then $ISABELLE_HOME, then the first root with one. */
export function discoverIsabelleHome(lookup: Lookup): string {
  const configured = lookup.configured?.trim()
  if (configured) {
    const home = distributionIn(configured)
    if (home) return home
    throw new IsabelleNotFound(
      `isabelle.home is set to "${configured}", but that is not an Isabelle distribution ` +
      `(expected bin/isabelle and etc/symbols beneath it; on macOS, name the app itself, ` +
      `such as /Applications/Isabelle2026.app).`)
  }

  const env = lookup.env?.trim()
  if (env) {
    const home = distributionIn(env)
    if (home) return home
  }

  for (const root of lookup.roots) {
    const found = scanForDistribution(root)
    if (found) return found
  }

  throw new IsabelleNotFound(
    `No Isabelle distribution found in ${lookup.roots.join(', ')}. ` +
    'Set "isabelle.home" to the Isabelle folder (the one containing bin/isabelle; ' +
    'on macOS, the Isabelle app, such as /Applications/Isabelle2026.app).')
}
