/* The words of theory text outside every comment, string and cartouche, by a scan of the
 * text alone -- no prover, no vscode import, so that plain node can test what is built on
 * it (suite67). The outline reads the commands among them, Sledgehammer the `sorry`s.
 */

export interface Word {
  offset: number
  line: number
  word: string
  /** Nothing but blanks before it on its line. */
  atLineStart: boolean
}

/**
 * The words outside every comment, string and cartouche: the commands of `scanCommands`,
 * and also those that do not start a line, like the `sorry` of `have "P" sorry`.
 */
export function scanWords(text: string): Word[] {
  const out: Word[] = []
  let comment = 0
  let cartouche = 0
  let verbatim = false
  let quote: '"' | '`' | undefined
  let line = 0
  let atLineStart = true

  const at = (s: string, i: number) => text.startsWith(s, i)

  for (let i = 0; i < text.length;) {
    const c = text[i]

    if (c === '\n') { line++; i++; atLineStart = true; continue }

    if (quote) {
      if (c === '\\') { i += 2; continue }
      if (c === quote) quote = undefined
      i++
      continue
    }
    if (verbatim) {
      if (at('*}', i)) { verbatim = false; i += 2; continue }
      i++
      continue
    }
    if (comment > 0) {
      if (at('(*', i)) { comment++; i += 2; continue }
      if (at('*)', i)) { comment--; i += 2; continue }
      i++
      continue
    }
    if (cartouche > 0) {
      // Nested cartouches are legal and common in document text.
      if (at('\\<open>', i)) { cartouche++; i += 7; continue }
      if (at('\\<close>', i)) { cartouche--; i += 8; continue }
      if (c === '‹') { cartouche++; i++; continue }
      if (c === '›') { cartouche--; i++; continue }
      i++
      continue
    }

    if (at('(*', i)) { comment = 1; i += 2; atLineStart = false; continue }
    if (at('{*', i)) { verbatim = true; i += 2; atLineStart = false; continue }
    if (at('\\<open>', i)) { cartouche = 1; i += 7; atLineStart = false; continue }
    if (c === '‹') { cartouche = 1; i++; atLineStart = false; continue }
    if (c === '"' || c === '`') { quote = c as '"' | '`'; i++; atLineStart = false; continue }

    if (c === ' ' || c === '\t' || c === '\r') { i++; continue }

    // A symbol is one unit: the name in `\<alpha>` is not a word.
    if (at('\\<', i)) {
      const close = text.indexOf('>', i)
      i = close < 0 ? text.length : close + 1
      atLineStart = false
      continue
    }
    const m = /^[A-Za-z_][A-Za-z0-9_'.]*/.exec(text.slice(i, i + 256))
    if (m) {
      // Only the leading identifier is a command, as before: `ML_file`, not `foo.bar`.
      const word = atLineStart ? /^[A-Za-z_][A-Za-z0-9_']*/.exec(m[0])![0] : m[0]
      out.push({ offset: i, line, word, atLineStart })
      i += m[0].length
      atLineStart = false
      continue
    }
    atLineStart = false
    i++
  }
  return out
}
