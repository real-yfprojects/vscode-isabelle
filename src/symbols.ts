/* The Isabelle symbol table, read from $ISABELLE_HOME/etc/symbols.
 *
 * The official extension loads this from inside the patched VSCodium
 * (ISABELLE_VSCODIUM_RESOURCES/.../symbols.json) and therefore has no symbols at all
 * in stock VS Code. Every Isabelle distribution ships etc/symbols as plain text, so
 * we parse that instead and stay independent of the fork.
 */

import * as fs from 'fs'
import * as path from 'path'

/** Matches an Isabelle symbol escape, ordinary `\<forall>` or control `\<^sub>`. */
export const SYMBOL_RE = /\\<\^?[A-Za-z][A-Za-z0-9_']*>/g

export interface SymbolEntry {
  name: string          // "\<forall>"
  glyph?: string        // "∀" (absent when etc/symbols gives no code:)
  code?: number
  abbrevs: string[]     // ["!", "ALL"]
  groups: string[]
  argument?: string
  isControl: boolean    // "\<^...>"
}

/** etc/symbols encodes a literal space inside a value as U+2423 OPEN BOX. */
function unescapeValue(v: string): string {
  return v.replace(/␣/g, ' ')
}

export class SymbolTable {
  readonly entries: SymbolEntry[]
  private readonly byName = new Map<string, SymbolEntry>()
  private readonly byGlyph = new Map<string, SymbolEntry>()
  private readonly byAbbrev = new Map<string, SymbolEntry[]>()
  private encodeRe: RegExp | undefined

  constructor(entries: SymbolEntry[]) {
    this.entries = entries
    for (const e of entries) {
      this.byName.set(e.name, e)
      if (e.glyph) this.byGlyph.set(e.glyph, e)
      for (const a of e.abbrevs) {
        const list = this.byAbbrev.get(a) ?? []
        list.push(e)
        this.byAbbrev.set(a, list)
      }
    }
    const glyphs = [...this.byGlyph.keys()].sort((a, b) => b.length - a.length)
    if (glyphs.length > 0) {
      const alt = glyphs.map(g => g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
      this.encodeRe = new RegExp(alt, 'gu')
    }
  }

  static parse(text: string): SymbolTable {
    const entries: SymbolEntry[] = []
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const m = /^(\S+)\s+(.*)$/.exec(line)
      if (!m) continue
      const name = m[1]

      const entry: SymbolEntry = {
        name, abbrevs: [], groups: [], isControl: name.startsWith('\\<^'),
      }
      const tokens = m[2].split(/\s+/).filter(Boolean)
      for (let i = 0; i < tokens.length - 1; i++) {
        const key = tokens[i]
        if (!key.endsWith(':')) continue
        const value = unescapeValue(tokens[i + 1])
        switch (key) {
          case 'code:': {
            const code = parseInt(value, 16)
            if (!Number.isNaN(code)) {
              entry.code = code
              entry.glyph = String.fromCodePoint(code)
            }
            break
          }
          case 'group:': entry.groups.push(value); break
          case 'abbrev:': entry.abbrevs.push(value); break
          case 'argument:': entry.argument = value; break
        }
        i++
      }
      entries.push(entry)
    }
    return new SymbolTable(entries)
  }

  static load(isabelleHome: string): SymbolTable {
    return SymbolTable.parse(fs.readFileSync(path.join(isabelleHome, 'etc', 'symbols'), 'utf8'))
  }

  get(name: string): SymbolEntry | undefined { return this.byName.get(name) }
  glyphOf(name: string): string | undefined { return this.byName.get(name)?.glyph }
  forAbbrev(abbrev: string): SymbolEntry[] { return this.byAbbrev.get(abbrev) ?? [] }
  has(name: string): boolean { return this.byName.has(name) }

  /**
   * The bare word a user types for a symbol: "\<forall>" -> "forall", "\<^sub>" -> "sub".
   * Ordinary and control symbols share this key space, which is what makes the
   * ambiguity check below correct for both at once.
   */
  static keyOf(name: string): string {
    return name.replace(/^\\<\^?/, '').replace(/>$/, '')
  }

  /** The symbol a typed word names exactly; ordinary symbols win over control ones. */
  lookupByKey(word: string): SymbolEntry | undefined {
    return this.byName.get(`\\<${word}>`) ?? this.byName.get(`\\<^${word}>`)
  }

  /**
   * Could the user still be typing a longer symbol name? "sub" must not expand to
   * \<^sub> while "subset", "subseteq", ... remain reachable.
   */
  canExtend(word: string): boolean {
    for (const name of this.byName.keys()) {
      const key = SymbolTable.keyOf(name)
      if (key.length > word.length && key.startsWith(word)) return true
    }
    return false
  }

  /** Unicode glyphs -> `\<name>` escapes. Idempotent: ASCII input is returned unchanged. */
  encode(text: string): string {
    if (!this.encodeRe) return text
    this.encodeRe.lastIndex = 0
    return text.replace(this.encodeRe, g => this.byGlyph.get(g)?.name ?? g)
  }

  /** `\<name>` escapes -> Unicode glyphs. Used for rendering only, never for file content. */
  decode(text: string): string {
    SYMBOL_RE.lastIndex = 0
    return text.replace(SYMBOL_RE, m => this.byName.get(m)?.glyph ?? m)
  }
}
