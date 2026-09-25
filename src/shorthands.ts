/* Short `\` inputs beyond Isabelle's own symbol names, after vscode-lean4's abbreviations.
 *
 * Lean's table maps by glyph; this one maps by what the symbol means in Isabelle, and is
 * short on purpose. Isabelle's names always win: `\a` stays `\<a>` (𝖺), never Lean's α,
 * so a shorthand that is also a symbol name is dropped rather than shadowing it.
 * Expansions are ASCII escapes like everything else in the buffer; `$CURSOR` marks where
 * the caret goes for bracket pairs.
 */

import { SymbolTable, SYMBOL_RE } from './symbols'

const BUILTIN: [key: string, expansion: string][] = [
  // Greek, two letters as in Lean (mu, nu, xi, pi and chi are Isabelle names already)
  ['be', '\\<beta>'], ['ga', '\\<gamma>'], ['de', '\\<delta>'], ['ep', '\\<epsilon>'],
  ['ze', '\\<zeta>'], ['et', '\\<eta>'], ['th', '\\<theta>'], ['io', '\\<iota>'],
  ['ka', '\\<kappa>'], ['la', '\\<lambda>'], ['lam', '\\<lambda>'], ['fun', '\\<lambda>'],
  ['rh', '\\<rho>'], ['si', '\\<sigma>'], ['ta', '\\<tau>'], ['ph', '\\<phi>'],
  ['ps', '\\<psi>'], ['om', '\\<omega>'],

  // logic, by meaning in HOL: `to` is the function type, `imp` is implication
  ['all', '\\<forall>'], ['ex', '\\<exists>'], ['neg', '\\<not>'],
  ['iff', '\\<longleftrightarrow>'], ['<->', '\\<longleftrightarrow>'],
  ['imp', '\\<longrightarrow>'], ['-->', '\\<longrightarrow>'],
  ['to', '\\<Rightarrow>'], ['=>', '\\<Rightarrow>'], ['==>', '\\<Longrightarrow>'],
  ['->', '\\<rightarrow>'], ['<-', '\\<leftarrow>'], ['|->', '\\<mapsto>'],
  ['|-', '\\<turnstile>'], ['vdash', '\\<turnstile>'], ['entails', '\\<turnstile>'],
  ['|=', '\\<Turnstile>'],

  // relations and operators
  ['ne', '\\<noteq>'], ['neq', '\\<noteq>'], ['nin', '\\<notin>'],
  ['<=', '\\<le>'], ['>=', '\\<ge>'],
  ['sube', '\\<subseteq>'], ['subeq', '\\<subseteq>'], ['supe', '\\<supseteq>'],
  ['empty', '\\<emptyset>'], ['un', '\\<union>'], ['comp', '\\<circ>'], ['.', '\\<cdot>'],
  ['inf', '\\<sqinter>'], ['bot', '\\<bottom>'], ['sum', '\\<Sum>'], ['prod', '\\<Prod>'],

  // pairs, caret inside. Keyed by the opening half, unlike Lean's `[[]]`: VS Code closes
  // `[`, `{` and `(` itself, so `\[[` already reads `\[[]]` on screen
  ['[[', '\\<lbrakk>$CURSOR\\<rbrakk>'], ['<>', '\\<langle>$CURSOR\\<rangle>'],
  ['{{', '\\<lbrace>$CURSOR\\<rbrace>'], ['(|', '\\<lparr>$CURSOR\\<rparr>'],
  ['floor', '\\<lfloor>$CURSOR\\<rfloor>'], ['ceil', '\\<lceil>$CURSOR\\<rceil>'],
  ['f<<', '\\<guillemotleft>$CURSOR\\<guillemotright>'],
]

const CLOSER: Record<string, string> = { '[': ']', '{': '}', '(': ')' }

/** What auto-closing will have put after the caret while `key` was typed: `[[` -> `]]`. */
export function autoClosers(key: string): string {
  return [...key].reverse().map(c => CLOSER[c] ?? '').join('')
}

export interface Expansion {
  before: string        // inserted before the caret
  after: string         // inserted after it; empty unless the expansion is a pair
}

export const CURSOR = '$CURSOR'

/** `\_i` gives `\<^sub>i`; superscripts only for digits, so `\^sub` still means \<^sub>. */
const SUB_RE = /^_([A-Za-z0-9])$/
const SUP_RE = /^\^([0-9])$/

export class Shorthands {
  private builtin = new Map<string, Expansion>()
  private custom = new Map<string, Expansion>()
  private rejected: string[] = []

  constructor(private readonly table: SymbolTable, custom: Record<string, string> = {}) {
    for (const [key, text] of BUILTIN) {
      const exp = this.parse(text)
      if (exp && !table.lookupByKey(key)) this.builtin.set(key, exp)
    }
    this.setCustom(custom)
  }

  /** Custom entries may be written with glyphs; the buffer gets escapes all the same. */
  setCustom(custom: Record<string, string>): void {
    this.custom.clear()
    this.rejected = []
    for (const [key, text] of Object.entries(custom ?? {})) {
      const exp = typeof text === 'string' && /^\S+$/.test(key) && !key.includes('\\')
        ? this.parse(this.table.encode(text)) : undefined
      if (exp) this.custom.set(key, exp)
      else this.rejected.push(key)
    }
  }

  /** Custom keys that could not be used: bad key, or a `\<name>` the table lacks. */
  get invalidCustom(): string[] { return this.rejected }

  private parse(text: string): Expansion | undefined {
    const i = text.indexOf(CURSOR)
    const before = i < 0 ? text : text.slice(0, i)
    const after = i < 0 ? '' : text.slice(i + CURSOR.length)
    for (const m of (before + after).matchAll(SYMBOL_RE)) {
      if (!this.table.has(m[0])) return undefined
    }
    return before ? { before, after } : undefined
  }

  /** Every shorthand, custom first: custom keys may override built-in ones. */
  entries(): [string, Expansion][] {
    const out = new Map(this.builtin)
    for (const [k, v] of this.custom) out.set(k, v)
    return [...out]
  }

  /** What `\key` expands to: a custom or built-in shorthand, a symbol name, or a sub/sup. */
  lookup(key: string): Expansion | undefined {
    const own = this.custom.get(key)
    if (own) return own
    const sym = this.table.lookupByKey(key)
    if (sym) return { before: sym.name, after: '' }
    const exp = this.builtin.get(key)
    if (exp) return exp
    const sub = SUB_RE.exec(key)
    if (sub) return { before: `\\<^sub>${sub[1]}`, after: '' }
    const sup = SUP_RE.exec(key)
    if (sup) return { before: `\\<^sup>${sup[1]}`, after: '' }
    return undefined
  }

  /** Is some longer key still reachable from this one? */
  canExtend(key: string): boolean {
    if (key === '_' || key === '^') return true
    if (this.table.canExtend(key)) return true
    for (const k of this.builtin.keys()) if (k.length > key.length && k.startsWith(key)) return true
    for (const k of this.custom.keys()) if (k.length > key.length && k.startsWith(key)) return true
    return false
  }

  /** Is this the start (or the whole) of some key? */
  isKeyPrefix(key: string): boolean {
    return this.lookup(key) !== undefined || this.canExtend(key)
  }

  /** The shorthand keys that produce exactly this symbol, for the hover. */
  keysFor(name: string): string[] {
    return this.entries()
      .filter(([, e]) => e.after === '' && e.before === name)
      .map(([k]) => k)
  }
}

/** The key being typed after a `\`, or undefined when the text is a raw `\<name>` escape. */
export function typedKey(linePrefix: string): string | undefined {
  const m = /\\([^\s\\]{1,24})$/.exec(linePrefix)
  if (!m) return undefined
  if (/^<\^?[A-Za-z]/.test(m[1])) return undefined
  return m[1]
}
