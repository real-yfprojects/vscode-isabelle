/*
 * Text for and from the Isabelle tools for AI agents, without `vscode`: the goal an agent
 * states, literal Unicode in a theory, and the proofs in Sledgehammer's messages.
 */

/**
 * The goal as it follows `have` or `lemma`: a plain proposition goes into a cartouche, a
 * quoted or structured statement is passed on as it is.
 */
export function goalStatement(goal: string): string {
  const g = goal.trim()
  if (g === '') return ''
  if (/^("|\\<open>|‹)/.test(g) || /^(fixes|assumes|shows|obtains|includes)\b/.test(g)) return g
  return `\\<open>${g}\\<close>`
}

/** Lines that hold literal non-ASCII characters, which `isabelle build` rejects in terms. */
export function unicodeLines(text: string, table: { encode(s: string): string } | undefined): string[] {
  const out: string[] = []
  text.split(/\r?\n/).forEach((l, i) => {
    if (!/[^\x00-\x7f]/.test(l)) return
    const encoded = table ? table.encode(l) : l
    out.push(encoded !== l
      ? `line ${i + 1}: literal Unicode; write it as\n    ${encoded.trim()}`
      : `line ${i + 1}: non-ASCII characters`)
  })
  return out
}

/** The proofs in Sledgehammer's messages: `Try this: by (metis foo) (12 ms)`. */
export function proofsOf(message: string): string[] {
  const out: string[] = []
  for (const line of message.split('\n')) {
    const m = /Try this:\s*(.*)$/.exec(line.trim())
    if (!m) continue
    const proof = m[1].replace(/\s*\((?:[\d.]+\s*m?s|>\s*[\d.]+\s*m?s.*|timed out.*|failed.*)\)\s*\.?$/, '').trim()
    if (proof) out.push(proof)
  }
  return out
}
