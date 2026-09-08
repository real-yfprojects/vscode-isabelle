/* Discovering Isabelle sessions from ROOT files, for the session picker.
 *
 * Why parse ROOT here rather than ask Isabelle: `isabelle sessions` prints only names,
 * and the picker needs each session's directories and parent. Everything that would
 * supply those (`isabelle sessions -D`, a dry-run build) costs a fresh JVM plus a full
 * session-structure load -- measured at ~20s per invocation on this machine. No picker
 * can spend that, so the small subset of the ROOT grammar we need is parsed directly.
 *
 * The grammar followed is Sessions.session_entry in src/Pure/Build/sessions.scala:
 *
 *   session NAME (GROUPS) in PATH = PARENT +
 *     description ... options ... sessions ... directories ... theories ...
 *
 * The clause order there is fixed, which is what makes a scan this simple sound.
 *
 * A theory belongs to whichever session owns its *parent directory* -- that is exactly
 * how Resources.find_theory resolves a file, via sessions_structure.session_directories,
 * and a directory belongs to at most one session globally (Isabelle rejects overlap with
 * "Duplicate use of directory"). So directory ownership is the whole file->session map.
 */

import * as fs from 'fs'
import * as path from 'path'

export interface Session {
  name: string
  /** Absent for a session whose parent is outside the scanned ROOTs, e.g. "HOL". */
  parent?: string
  /** Sessions named in the `sessions` clause: imports beyond the parent chain. */
  imports: string[]
  /** Absolute, canonical-cased directories this session owns; `dirs[0]` is its own. */
  dirs: string[]
  /** The ROOT file this came from, for diagnostics. */
  root: string
}

interface Token { value: string; quoted: boolean }

/* Clause keywords. A quoted occurrence is a name, not a keyword, which is why tokens
   carry `quoted` -- `directories "theories"` must not end the directory list. */
const CLAUSE = new Set([
  'description', 'options', 'sessions', 'directories', 'theories', 'document_theories',
  'document_files', 'export_files', 'export_classpath',
])
const ENTRY = new Set(['session', 'chapter', 'chapter_definition'])

/** ML-style comments nest, so a regex cannot do this. */
export function stripComments(text: string): string {
  let out = ''
  let depth = 0
  let i = 0
  while (i < text.length) {
    if (text.startsWith('(*', i)) { depth++; i += 2 }
    else if (depth > 0 && text.startsWith('*)', i)) { depth--; i += 2 }
    else if (depth > 0) { i++ }
    // A quoted string outside a comment may legitimately contain "(*".
    else if (text[i] === '"') {
      const start = i++
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
      out += text.slice(start, Math.min(i + 1, text.length))
      i++
    }
    else { out += text[i]; i++ }
  }
  return out
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const src = stripComments(text)
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === '"') {
      let value = ''
      i++
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) { value += src[i + 1]; i += 2 }
        else { value += src[i]; i++ }
      }
      i++
      tokens.push({ value, quoted: true })
      continue
    }
    if (c === '(' || c === ')' || c === '=' || c === '+') {
      tokens.push({ value: c, quoted: false })
      i++
      continue
    }
    let j = i
    while (j < src.length && !/[\s()"]/.test(src[j]) && src[j] !== '=' && src[j] !== '+') j++
    // A lone token of punctuation we do not model: consume one char so we cannot loop.
    if (j === i) j++
    tokens.push({ value: src.slice(i, j), quoted: false })
    i = j
  }
  return tokens
}

function keyword(t: Token | undefined, word: string): boolean {
  return t !== undefined && !t.quoted && t.value === word
}

function startsEntry(t: Token | undefined): boolean {
  return t !== undefined && !t.quoted && ENTRY.has(t.value)
}

function endsClause(t: Token | undefined): boolean {
  return t === undefined || (!t.quoted && (CLAUSE.has(t.value) || ENTRY.has(t.value)))
}

/**
 * Parse one ROOT file. `rootPath` is the file itself; session directories resolve
 * against the directory holding it.
 */
export function parseRoot(text: string, rootPath: string): Session[] {
  const tokens = tokenize(text)
  const base = path.dirname(rootPath)
  const sessions: Session[] = []

  let i = 0
  while (i < tokens.length) {
    if (!keyword(tokens[i], 'session')) { i++; continue }
    i++
    const name = tokens[i]
    if (name === undefined) break
    i++

    // Optional (groups).
    if (keyword(tokens[i], '(')) {
      let depth = 1
      i++
      while (i < tokens.length && depth > 0) {
        if (keyword(tokens[i], '(')) depth++
        else if (keyword(tokens[i], ')')) depth--
        i++
      }
    }

    // Optional `in PATH`, defaulting to the ROOT's own directory.
    let inPath = '.'
    if (keyword(tokens[i], 'in') && tokens[i + 1] !== undefined) {
      inPath = tokens[i + 1].value
      i += 2
    }

    if (!keyword(tokens[i], '=')) continue
    i++

    /* `opt(session_name ~ "+")`: the parent is present only when a "+" follows it.
       `session A = B` with no body has no "+" and no parent clause to confuse us. */
    let parent: string | undefined
    if (tokens[i] !== undefined && keyword(tokens[i + 1], '+')) {
      parent = tokens[i].value
      i += 2
    }

    const dir = path.resolve(base, inPath)
    const dirs = [dir]
    const imports: string[] = []

    /* Scan the body for `directories` and `sessions`; stop at the next entry. Both are
       needed: directories decide which files belong here, imports decide what a heap
       built from here contains. */
    while (i < tokens.length && !startsEntry(tokens[i])) {
      if (keyword(tokens[i], 'directories')) {
        i++
        while (i < tokens.length && !endsClause(tokens[i])) {
          dirs.push(path.resolve(dir, tokens[i].value))
          i++
        }
        continue
      }
      if (keyword(tokens[i], 'sessions')) {
        i++
        while (i < tokens.length && !endsClause(tokens[i])) {
          imports.push(tokens[i].value)
          i++
        }
        continue
      }
      i++
    }

    sessions.push({ name: name.value, parent, imports, dirs, root: rootPath })
  }

  return sessions
}

const SKIP = new Set([
  'node_modules', '.git', '.svn', '.hg', 'out', 'output', 'target', 'build',
  '.vscode', '.idea', 'browser_info', 'contrib', 'heaps',
])

/**
 * Find ROOT files under `roots`. Depth-limited: an Isabelle project keeps its ROOTs
 * near the top, and an unbounded walk of a large workspace is exactly the kind of
 * stall a picker must not have.
 */
export function findRootFiles(roots: string[], maxDepth = 4): string[] {
  const found: string[] = []
  const seen = new Set<string>()

  const walk = (dir: string, depth: number): void => {
    const key = dir.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)

    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }

    for (const e of entries) {
      if (e.isFile() && e.name === 'ROOT') found.push(path.join(dir, e.name))
    }
    if (depth >= maxDepth) return
    for (const e of entries) {
      if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) {
        walk(path.join(dir, e.name), depth + 1)
      }
    }
  }

  for (const r of roots) walk(r, 0)
  return found
}

export function readSessions(roots: string[], maxDepth = 4): Session[] {
  const sessions: Session[] = []
  for (const root of findRootFiles(roots, maxDepth)) {
    try { sessions.push(...parseRoot(fs.readFileSync(root, 'utf8'), root)) }
    catch { /* An unreadable or malformed ROOT must not take the picker down. */ }
  }
  return sessions
}

/** Session owning `file`, by the directory rule Resources.find_theory uses. */
export function sessionForFile(sessions: Session[], file: string): Session | undefined {
  const dir = path.resolve(path.dirname(file)).toLowerCase()
  return sessions.find(s => s.dirs.some(d => d.toLowerCase() === dir))
}

/**
 * Number of ancestors within the scanned set. Parents outside it (HOL) stop the walk,
 * so depth is "how far above the distribution this sits", which is the axis the picker
 * orders on.
 */
export function depth(sessions: Session[], name: string): number {
  const byName = new Map(sessions.map(s => [s.name, s]))
  let n = 0
  let cur = byName.get(name)
  const seen = new Set<string>()
  while (cur?.parent !== undefined && byName.has(cur.parent) && !seen.has(cur.name)) {
    seen.add(cur.name)
    cur = byName.get(cur.parent)
    n++
  }
  return n
}

/** Parents before children; ties broken by name so the list is stable between runs. */
export function orderSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    const d = depth(sessions, a.name) - depth(sessions, b.name)
    return d !== 0 ? d : a.name.localeCompare(b.name)
  })
}

/**
 * True when `ancestor` is at or below `name` in the parent chain.
 *
 * This is what makes a frontier safe: with `-R S` every session at or below S is baked
 * into an immutable heap, so editing one of those leaves everything above it stale.
 */
export function isAncestor(sessions: Session[], ancestor: string, name: string): boolean {
  const byName = new Map(sessions.map(s => [s.name, s]))
  let cur = byName.get(name)
  const seen = new Set<string>()
  while (cur !== undefined && !seen.has(cur.name)) {
    if (cur.name === ancestor) return true
    seen.add(cur.name)
    cur = cur.parent !== undefined ? byName.get(cur.parent) : undefined
  }
  return false
}

/**
 * The frontier to recommend for a set of sessions being edited: the lowest of them.
 *
 * `-R S` caches S's import closure and leaves S's own theories live. Anything cached is
 * a heap snapshot compiled against the *old* text of whatever you then change, and heaps
 * do not update, so the frontier has to sit below every session you touch. The lowest
 * one is that boundary; picking anything higher silently staleness-poisons the rest.
 */
export function recommendedSession(
  sessions: Session[], editing: string[],
): string | undefined {
  const known = editing.filter(n => sessions.some(s => s.name === n))
  if (known.length === 0) return undefined
  return orderSessions(sessions).find(s => known.includes(s.name))?.name
}

/**
 * Every session baked into the heap image the server booted with.
 *
 * This follows both edges Sessions.background follows: the parent chain and the
 * `sessions` clause. With `-R L` the image is L's whole import closure *minus* L's own
 * theories, which is what leaves L editable; with `-l L` the image is L itself as well,
 * so nothing in the closure is live.
 */
export function heapSessions(
  sessions: Session[], logic: string, requirements: boolean,
): Set<string> {
  const byName = new Map(sessions.map(s => [s.name, s]))
  const closure = new Set<string>()
  const pending = [logic]
  while (pending.length > 0) {
    const name = pending.pop() as string
    if (closure.has(name)) continue
    closure.add(name)
    const s = byName.get(name)
    if (s === undefined) continue
    if (s.parent !== undefined) pending.push(s.parent)
    for (const imp of s.imports) pending.push(imp)
  }
  // Under -R the named session stays live; under -l it is in the image too.
  if (requirements) closure.delete(logic)
  return closure
}

export interface Staleness {
  /** Session owning the edited file, which is inside the current heap image. */
  session: string
  /** Frontier to move to so the edit is actually checked. */
  suggested: string
  message: string
}

/**
 * Whether editing `file` is silently pointless under the current image.
 *
 * A theory inside the heap is still opened as a live, file-backed node -- find_theory
 * resolves a path without consulting loaded_theory, so it looks perfectly normal and is
 * re-checked as you type. What does *not* happen is anything downstream noticing: every
 * other theory in the image was compiled against the old text and heaps are immutable.
 * So the edit appears to work and the results above it are quietly stale, which is the
 * one failure here that gives the reader no signal at all.
 *
 * `alsoOpen` are the other sessions with theories open, so the suggested frontier clears
 * all of them at once rather than warning again on the next file.
 */
export function stalenessWarning(
  sessions: Session[], file: string, logic: string, requirements: boolean,
  alsoOpen: string[] = [],
): Staleness | undefined {
  const owner = sessionForFile(sessions, file)
  if (owner === undefined) return undefined
  if (!heapSessions(sessions, logic, requirements).has(owner.name)) return undefined

  const suggested =
    recommendedSession(sessions, [owner.name, ...alsoOpen]) ?? owner.name
  return {
    session: owner.name,
    suggested,
    message:
      `${owner.name} is inside the ${logic} heap image, so this edit is checked on its ` +
      `own but nothing that imports it will see the change. Switch the session to ` +
      `${suggested} to check it for real.`,
  }
}

/**
 * `isabelle.sessionDirs` needed for `name` to resolve, given what is already configured.
 *
 * A ROOT under the workspace is not necessarily visible to Isabelle: it is found only if
 * its directory is a registered component, is named by a ROOTS catalogue, or is passed
 * with -d. Two of viper-roots' own sessions are invisible for exactly this reason -- their
 * ROOTs sit in subdirectories of a component rather than in the component itself -- so
 * offering them without this would hand the user a choice that fails at startup.
 *
 * Passing -d for a directory Isabelle already knows is harmless: load_root_files keys
 * seen_roots by canonical file and drops the repeat.
 */
export function sessionDirsFor(
  sessions: Session[], name: string, existing: string[],
): string[] {
  const session = sessions.find(s => s.name === name)
  if (session === undefined) return existing
  const dir = path.dirname(session.root)
  const known = new Set(existing.map(d => path.resolve(d).toLowerCase()))
  if (known.has(path.resolve(dir).toLowerCase())) return existing
  return [...existing, dir]
}
