/* Code skeletons from the server's sendback code actions. No vscode import, so the
 * suites can load it without an editor; skeleton_provider.ts does the wiring.
 *
 * The server turns every <sendback> in a command's results into one code action, titled
 * with the sendback's text (language_server.scala, code_action_request). Two kinds reach
 * it in practice:
 *
 *   - the proof outline that `proof (induct xs)` and the like print themselves
 *     (Proof_Context.print_cases_proof): "  case Nil\n  then show ?case sorry\nnext\n...qed"
 *   - proofs found by try0, Sledgehammer and metis: "by simp", or a whole Isar proof
 *
 * The title is the snippet verbatim, so a three-case outline is a seven-line menu entry.
 * Both kinds come as one edit that rewrites the command to itself, a newline and the
 * snippet indented like the command's line.
 */

export type SendbackKind = 'outline' | 'proof'

export interface Sendback {
  kind: SendbackKind
  title: string
}

/* print_cases_proof indents each top-level case by two spaces and only nested ones by
   more, so the outline's own first line is always "  case". */
const OUTLINE_RE = /^ {2}case\b/

export function isOutline(snippet: string): boolean {
  return OUTLINE_RE.test(snippet) && /(^|\n)qed\s*$/.test(snippet)
}

/** Kind and menu title for a sendback snippet. */
export function classifySendback(snippet: string): Sendback {
  if (isOutline(snippet)) {
    const cases = snippet.split('\n').filter(l => OUTLINE_RE.test(l)).length
    return { kind: 'outline', title: `Insert proof outline (${cases} case${cases === 1 ? '' : 's'})` }
  }
  const lines = snippet.split('\n').map(l => l.trim()).filter(l => l)
  return {
    kind: 'proof',
    title: lines.length <= 1 ? `Insert proof: ${lines[0] ?? snippet}`
      : `Insert proof: ${lines[0]} … (${lines.length} lines)`,
  }
}

/* The kinds the extended server gives its code actions (lsp.scala, CodeActionKind). A
   stock server sends none. */
export const KIND_OUTLINE = 'refactor.rewrite.isabelle.outline'
export const KIND_SKELETON = 'refactor.rewrite.isabelle.skeleton'
export const KIND_SUGGESTION = 'refactor.rewrite.isabelle.suggestion'

/**
 * Whether an action from the server may become ghost text: what the text already written
 * determines -- the outline of `proof (induct xs)`, the rest of an instantiation -- but not
 * a suggestion such as an Isar sketch, which is one choice among others.
 */
export function isGhostCandidate(kind: string | undefined, title: string): boolean {
  return kind === KIND_OUTLINE || kind === KIND_SKELETON || (!kind && isOutline(title))
}

/**
 * The text an edit adds after a command, without the command's indentation.
 *
 * Both kinds of edit put the skeleton on the lines after the command, indented like the
 * command's line: a sendback rewrites the command to itself and the skeleton, a skeleton
 * of the extended server is inserted at the command's end. `rangeText` is what the edit
 * replaces, so nothing for the latter.
 */
export function addedLines(rangeText: string, newText: string, commandIndent: string)
  : string | undefined {
  if (!newText.startsWith(rangeText + '\n')) return undefined
  return newText.slice(rangeText.length + 1).split('\n')
    .map(l => l.startsWith(commandIndent) ? l.slice(commandIndent.length) : l.trimStart())
    .join('\n')
}

const indentOf = (line: string) => /^[ \t]*/.exec(line)![0]

/**
 * Ghost text for a skeleton at a caret on a blank line below its command.
 *
 * `commandIndent` is the indentation of the command's line, which the server's own edit
 * uses as the skeleton's base. `caretIndent` is what the caret's line holds so far: the
 * ghost text has to start with it, since VS Code shows only a suggestion that extends what
 * is already in its range. So the base is the command's, unless the caret is indented
 * further -- after ENTER the editor indents once more after `proof` -- in which case the
 * skeleton moves right to start at the caret.
 */
export function ghostText(snippet: string, commandIndent: string, caretIndent: string): string {
  const lines = snippet.replace(/\s+$/, '').split('\n')
  const first = indentOf(lines[0]).length
  const base = ' '.repeat(Math.max(commandIndent.length, caretIndent.length - first))
  return lines.map(l => l.trim() ? base + l : '').join('\n')
}

/** Whether a line is blank, i.e. could hold the skeleton. */
export function isBlank(line: string): boolean {
  return line.trim() === ''
}

/**
 * The previous command looks like one whose skeleton may still come from the prover: a
 * `proof` with its method, or an instantiation (whose `begin` is often a line of its own).
 */
export function mayCarrySkeleton(commandLine: string): boolean {
  // An Isabelle name may continue with ' and ., so \b would take `proof'` for the keyword.
  return /(^|[^\w'.])(proof|instantiation|begin)(?![\w'.])/.test(commandLine)
}

/** The line after the caret already starts an outline, so offering one would duplicate it. */
export function startsOutline(line: string): boolean {
  return /^\s*(case|next|qed)\b/.test(line)
}
