/* Which lines an editor can actually display.
 *
 * `editor.visibleRanges` is not the whole answer: the sticky-scroll widget also paints
 * enclosing lines from *above* the scroll position, and those are decorated like any
 * other line. Viewport-scoped decorations that ignore them leave the sticky header
 * partly uncoloured -- near enclosing lines fall inside the margin and get decorated,
 * far ones do not, so the header looks inconsistently styled.
 *
 * VS Code exposes no API for "which lines are currently sticky", so they are
 * reconstructed. With no outline or folding provider registered for Isabelle, sticky
 * scroll falls back to its indentation model, whose enclosing lines are exactly the
 * ones above with strictly decreasing indentation.
 */

import * as vscode from 'vscode'

function stickyScrollEnabled(): boolean {
  return vscode.workspace.getConfiguration('editor.stickyScroll').get<boolean>('enabled') ?? true
}

function stickyMaxLines(): number {
  return vscode.workspace.getConfiguration('editor.stickyScroll').get<number>('maxLineCount') ?? 5
}

/** Lines the sticky header is likely showing above `firstVisible`, outermost first. */
export function stickyLines(doc: vscode.TextDocument, firstVisible: number): number[] {
  if (!stickyScrollEnabled() || firstVisible <= 0) return []
  const max = stickyMaxLines()
  if (max <= 0) return []

  const out: number[] = []
  let indent = Number.MAX_SAFE_INTEGER
  for (let line = firstVisible - 1; line >= 0 && out.length < max; line--) {
    const text = doc.lineAt(line).text
    if (text.trim().length === 0) continue
    const width = text.length - text.trimStart().length
    if (width < indent) {
      out.push(line)
      indent = width
      if (indent === 0) break
    }
  }
  return out.reverse()
}

/** Does `line` fall inside the viewport span or the sticky header? */
export function isDisplayable(
  line: number,
  span: { first: number; last: number },
  sticky: readonly number[],
): boolean {
  return (line >= span.first && line <= span.last) || sticky.includes(line)
}
