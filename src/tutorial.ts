/* Where the walkthrough's "Show me" buttons put the cursor in media/walkthrough/Tutorial.thy.
 *
 * Kept apart from walkthrough.ts, which needs vscode, so that the pure tests can check that
 * every anchor still occurs in the theory exactly once: an edit to the theory that drops
 * one would otherwise leave its button opening the file at the top, which looks like it
 * worked.
 */

export const TUTORIAL_FILE = 'Tutorial.thy'

export interface Anchor {
  /** Text that occurs once in the theory. */
  needle: string
  /** Column of the cursor within the needle. */
  offset: number
}

export const ANCHORS: Record<string, Anchor> = {
  // Strictly inside the escape, so revealSymbolAtCursor shows what the file stores.
  symbols: { needle: '\\<forall>x::nat', offset: 3 },
  // The Infoview shows the Cons case's goal with its induction hypothesis.
  goals: { needle: 'case (Cons x xs)', offset: 0 },
  // On the lemma declaration, Sledgehammer sees the proof context before sorry.
  sledgehammer: { needle: 'lemma "distinct xs \\<Longrightarrow> card (set xs) = length xs"', offset: 0 },
  facts: { needle: 'find_theorems', offset: 0 },
}

/** Line and character of a section's anchor, or undefined if it is not in `text`. */
export function anchorPosition(text: string, section: string): { line: number, character: number } | undefined {
  const anchor = ANCHORS[section]
  if (!anchor) return undefined
  const at = text.indexOf(anchor.needle)
  if (at < 0) return undefined
  const before = text.slice(0, at)
  const line = before.split('\n').length - 1
  const character = at - (before.lastIndexOf('\n') + 1) + anchor.offset
  return { line, character }
}
