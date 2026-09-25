/* Word motion over a line in which a rendered symbol counts as one character.
 *
 * VS Code's word commands classify single characters against editor.wordSeparators, and
 * no such set says what Isabelle needs: `\<alpha>` belongs inside an identifier while
 * `\<open>` is a token of its own, yet both are spelled with the same characters. Taking
 * `\`, `<` and `>` out of the separators made `\<forall>` one word, and with it every
 * cartouche -- `\<open>foo\<close>` had no separator left in it at all.
 *
 * The algorithms below are VS Code's own (WordOperations, cursorWordOperations.ts), run
 * over units rather than characters. A unit is either a rendered symbol or one character,
 * so a symbol behaves the way the one-character glyph it is drawn as would. With symbols
 * taken care of, `\`, `<` and `>` separate again, as they do by default -- which also
 * makes `-->` one word rather than `--` and `>`. No `vscode` import: this is checked by
 * a pure suite.
 */

export enum CharClass { Regular = 0, Whitespace = 1, Separator = 2 }

export interface Unit { start: number; end: number; cls: CharClass }

/**
 * VS Code's classifier: space and tab are whitespace, the configured characters separate.
 * So do the three the Isabelle default leaves out only to keep symbols whole.
 */
export function separatorClassifier(separators: string): (ch: string) => CharClass {
  const all = separators + '\\<>'
  return ch => ch === ' ' || ch === '\t' ? CharClass.Whitespace
    : all.includes(ch) ? CharClass.Separator : CharClass.Regular
}

/* Isabelle's letters beyond ASCII (Symbol.symbols.letters in symbol.scala): single and
   doubled Latin letters, and Greek without \<lambda>, which is the binder. */
const GREEK = new Set([
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa',
  'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega',
  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
])
/* Modifiers of the character after them, drawn as sub/superscript or bold: `x\<^sub>1`
   reads as one name, and Isabelle's own identifier syntax admits `\<^sub>`. */
const JOINERS = new Set(['\\<^sub>', '\\<^sup>', '\\<^bold>'])

/** Letter symbols and modifiers join words; every other symbol stands on its own. */
export function symbolClass(name: string): CharClass {
  const m = /^\\<([A-Za-z]+)>$/.exec(name)
  const letter = m !== null &&
    (/^([A-Za-z])\1?$/.test(m[1]) || GREEK.has(m[1]))
  return letter || JOINERS.has(name) ? CharClass.Regular : CharClass.Separator
}

/** The line as units: each atom (sorted, non-overlapping) is one, any other character is one. */
export function toUnits(
  text: string, atoms: readonly Unit[], classOf: (ch: string) => CharClass,
): Unit[] {
  const out: Unit[] = []
  let i = 0
  for (const a of atoms) {
    for (; i < a.start; i++) out.push({ start: i, end: i + 1, cls: classOf(text[i]) })
    out.push(a)
    i = a.end
  }
  for (; i < text.length; i++) out.push({ start: i, end: i + 1, cls: classOf(text[i]) })
  return out
}

/* Word types as VS Code numbers them; start/end are unit indices, end exclusive. */
const NONE = 0, REGULAR = 1, SEPARATOR = 2
interface Word { start: number; end: number; type: number; nextClass: CharClass }

/** Does a unit of class `cls` end a word of type `type`? */
function breaks(type: number, cls: CharClass): boolean {
  return cls === CharClass.Whitespace ||
    (type === REGULAR && cls === CharClass.Separator) ||
    (type === SEPARATOR && cls === CharClass.Regular)
}

function endOfWord(u: readonly Unit[], type: number, from: number): number {
  for (let k = from; k < u.length; k++) if (breaks(type, u[k].cls)) return k
  return u.length
}

function startOfWord(u: readonly Unit[], type: number, from: number): number {
  for (let k = from; k >= 0; k--) if (breaks(type, u[k].cls)) return k + 1
  return 0
}

function typeOf(cls: CharClass): number {
  return cls === CharClass.Regular ? REGULAR : SEPARATOR
}

/** The word ending at or before unit index `at`; `nextClass` is the class just before it. */
function previousWord(u: readonly Unit[], at: number): Word | undefined {
  let type = NONE
  for (let k = at - 1; k >= 0; k--) {
    const cls = u[k].cls
    if (type !== NONE && breaks(type, cls)) {
      return { start: k + 1, end: endOfWord(u, type, k + 1), type, nextClass: cls }
    }
    if (cls !== CharClass.Whitespace) type = typeOf(cls)
  }
  return type !== NONE
    ? { start: 0, end: endOfWord(u, type, 0), type, nextClass: CharClass.Whitespace }
    : undefined
}

/** The word starting at or after unit index `at`; `nextClass` is the class just after it. */
function nextWord(u: readonly Unit[], at: number): Word | undefined {
  let type = NONE
  for (let k = at; k < u.length; k++) {
    const cls = u[k].cls
    if (type !== NONE && breaks(type, cls)) {
      return { start: startOfWord(u, type, k - 1), end: k, type, nextClass: cls }
    }
    if (cls !== CharClass.Whitespace) type = typeOf(cls)
  }
  return type !== NONE
    ? { start: startOfWord(u, type, u.length - 1), end: u.length, type, nextClass: CharClass.Whitespace }
    : undefined
}

/** A lone separator right against a word, like the `(` of `(x`, is skipped over. */
function isLoneSeparator(w: Word): boolean {
  return w.type === SEPARATOR && w.end - w.start === 1 && w.nextClass === CharClass.Regular
}

/** Unit index of a character offset; offsets inside an atom round down to its start. */
function unitAt(u: readonly Unit[], offset: number): number {
  let k = 0
  while (k < u.length && u[k].end <= offset) k++
  return k
}

/** Character offset of unit index `k`, which may be one past the last unit. */
function offsetOf(u: readonly Unit[], k: number): number {
  return k < u.length ? u[k].start : u.length > 0 ? u[u.length - 1].end : 0
}

/** `cursorWordLeft` (Ctrl+Left) within one line: the offset to move to. */
export function wordLeft(u: readonly Unit[], offset: number): number {
  let w = previousWord(u, unitAt(u, offset))
  if (w && isLoneSeparator(w)) w = previousWord(u, w.start)
  return w ? offsetOf(u, w.start) : 0
}

/** `cursorWordEndRight` (Ctrl+Right) within one line: the offset to move to. */
export function wordEndRight(u: readonly Unit[], offset: number): number {
  let w = nextWord(u, unitAt(u, offset))
  if (w && isLoneSeparator(w)) w = nextWord(u, w.end)
  return w ? offsetOf(u, w.end) : offsetOf(u, u.length)
}

/** `deleteWordLeft` (Ctrl+Backspace) within one line, past its whitespace rule. */
export function deleteWordLeftFrom(u: readonly Unit[], offset: number): number {
  const w = previousWord(u, unitAt(u, offset))
  return w ? offsetOf(u, w.start) : 0
}

/** `deleteWordRight` (Ctrl+Delete) within one line, past its whitespace rule. */
export function deleteWordRightTo(u: readonly Unit[], offset: number): number {
  const w = nextWord(u, unitAt(u, offset))
  return w ? offsetOf(u, w.end) : offsetOf(u, u.length)
}
