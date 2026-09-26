/* Which workspace files the running server's heap image was built from, and which of
 * them no longer match it.
 *
 * The server never runs on an outdated image: Language_Server.build_session does a
 * no_build check first and rebuilds when the sources digest differs. So the image is
 * current when the server comes up, and can only go stale *afterwards* -- when a theory
 * inside it changes, by an edit here, a save, a git checkout, another editor. Nothing
 * reports that: heap theories are nodeless, the server never re-reads them, and
 * everything checked on top of them silently keeps the old text.
 *
 * Hence a baseline of content digests taken as the server starts, compared against the
 * current content of the same files. Content rather than mtime, so a checkout that
 * rewrites a file unchanged, or an edit that is undone, does not count as stale.
 *
 * Pure (fs and crypto only), so suite42 runs it under plain node.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { Session, heapSessions } from './sessions'

/** Sources a session's heap depends on that one edits by hand: theories and ML. */
const SOURCE = /\.(thy|ML|sml)$/

/** Path identity as the file system sees it: Windows paths are case-insensitive. */
export function fileKey(file: string, platform: string = process.platform): string {
  const resolved = path.resolve(file)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Source files of every workspace session inside the image.
 *
 * Directory listing, not recursive: a theory must sit in one of its session's declared
 * directories (Isabelle rejects "implicit use of directory"), which is also the rule
 * sessionForFile uses. Distribution sessions are not in `sessions` and so not listed --
 * nobody edits HOL by accident.
 */
export function heapSourceFiles(
  sessions: Session[], logic: string, requirements: boolean,
): string[] {
  const inHeap = heapSessions(sessions, logic, requirements)
  const files: string[] = []
  const seen = new Set<string>()
  for (const s of sessions) {
    if (!inHeap.has(s.name)) continue
    for (const dir of s.dirs) {
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (!e.isFile() || !SOURCE.test(e.name)) continue
        const file = path.join(dir, e.name)
        const key = fileKey(file)
        if (seen.has(key)) continue
        seen.add(key)
        files.push(file)
      }
    }
  }
  return files
}

export function digest(content: string | Buffer): string {
  return crypto.createHash('sha1').update(content).digest('hex')
}

/** Digest of a file on disk, or undefined when it is gone. */
export async function digestFile(file: string): Promise<string | undefined> {
  try { return digest(await fs.promises.readFile(file)) } catch { return undefined }
}

export interface Baseline {
  /** Keyed by fileKey; the value keeps the original spelling for display. */
  files: Map<string, { file: string; digest: string }>
}

export async function takeBaseline(files: string[]): Promise<Baseline> {
  const entries = await Promise.all(files.map(async file => {
    const d = await digestFile(file)
    return d === undefined ? undefined : [fileKey(file), { file, digest: d }] as const
  }))
  return { files: new Map(entries.filter(e => e !== undefined)) }
}

export type Change = 'modified' | 'deleted' | 'unsaved'

/**
 * How `file` now differs from the image, or undefined if it does not.
 *
 * `current` is the content digest, undefined for a deleted file; `unsaved` says it came
 * from an editor buffer rather than from disk. A file outside the baseline is never
 * stale: a new theory is not in the image until something in the image imports it, and
 * that takes an edit to a file that *is* in the baseline.
 */
export function compare(
  baseline: Baseline, file: string, current: string | undefined, unsaved: boolean,
): Change | undefined {
  const base = baseline.files.get(fileKey(file))
  if (base === undefined) return undefined
  if (current === undefined) return 'deleted'
  if (current === base.digest) return undefined
  return unsaved ? 'unsaved' : 'modified'
}
