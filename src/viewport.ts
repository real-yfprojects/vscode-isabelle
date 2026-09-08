/* Which lines an editor can actually display.
 *
 * `editor.visibleRanges` is not the whole answer: the sticky-scroll widget also paints
 * enclosing lines from *above* the scroll position, and those are decorated like any
 * other line. Viewport-scoped decorations that ignore them leave the sticky header
 * partly uncoloured -- near enclosing lines fall inside the margin and get decorated,
 * far ones do not, so the header looks inconsistently styled.
 *
 * VS Code exposes no API for "which lines are currently sticky", so they are
 * reconstructed -- from whichever model sticky scroll is itself using.
 *
 * That model is not fixed. `editor.stickyScroll.defaultModel` prefers the outline, falls
 * back to a folding provider, and only then to indentation. Registering the theory
 * outline therefore *changed* which lines are sticky, so predicting them from indentation
 * -- correct before the outline existed -- would have quietly reintroduced the
 * partly-coloured sticky header. The outline is consulted first here for the same reason.
 */

import * as vscode from 'vscode'
import { enclosing, outlineFor } from './outline'

function stickyScrollEnabled(): boolean {
  return vscode.workspace.getConfiguration('editor.stickyScroll').get<boolean>('enabled') ?? true
}

function stickyMaxLines(): number {
  return vscode.workspace.getConfiguration('editor.stickyScroll').get<number>('maxLineCount') ?? 5
}

/** Enclosing lines from the indentation model: those above with decreasing indent. */
function byIndentation(doc: vscode.TextDocument, firstVisible: number, max: number): number[] {
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

/** Lines the sticky header is likely showing above `firstVisible`, outermost first. */
export function stickyLines(doc: vscode.TextDocument, firstVisible: number): number[] {
  if (!stickyScrollEnabled() || firstVisible <= 0) return []
  const max = stickyMaxLines()
  if (max <= 0) return []

  if (doc.languageId === 'isabelle') {
    // Sticky scroll shows the enclosing outline nodes that began above the viewport.
    const lines = enclosing(outlineFor(doc), firstVisible)
      .map(node => node.line)
      .filter(line => line < firstVisible)
    // A theory with no structure at all still gets a header, from indentation.
    if (lines.length > 0) return lines.slice(-max)
  }
  return byIndentation(doc, firstVisible, max)
}

/** Does `line` fall inside the viewport span or the sticky header? */
export function isDisplayable(
  line: number,
  span: { first: number; last: number },
  sticky: readonly number[],
): boolean {
  return (line >= span.first && line <= span.last) || sticky.includes(line)
}
