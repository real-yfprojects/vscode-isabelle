/* What the Graph View draws, separated from the panel that hosts it.
 *
 * No vscode import, so the SVG and the empty-state wording are testable under plain node.
 * Worth separating: a node name is text out of a theory and lands inside markup, and the
 * escaping is the sort of thing that is silently wrong until someone names a theory
 * something hostile.
 */

import { Graph, Layout, NODE_HEIGHT } from './graphview_layout'

export interface GraphviewResponse { graph?: Graph; error?: string }

/** SVG for a laid-out graph. Pure, so the drawing can be checked without a webview. */
export function graphSvg(layout: Layout): string {
  if (layout.nodes.length === 0) return ''
  const at = new Map(layout.nodes.map(n => [n.ident, n]))

  const edges = layout.edges.map(e => {
    const from = at.get(e.from)
    const to = at.get(e.to)
    if (from === undefined || to === undefined) return ''
    const x1 = from.x + from.width / 2
    const y1 = from.y + NODE_HEIGHT
    const x2 = to.x + to.width / 2
    const y2 = to.y
    /* A cubic curve rather than a straight line: with several edges converging on one
       node, straight lines overlap into a single thick stroke near the target, and
       curves stay distinguishable. */
    const mid = (y1 + y2) / 2
    return `<path d="M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}" ` +
      `fill="none" stroke="var(--vscode-editorLineNumber-foreground)" stroke-width="1"/>`
  }).join('')

  const nodes = layout.nodes.map(n =>
    `<g class="node" data-ident="${escapeAttr(n.ident)}">` +
    `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${NODE_HEIGHT}" rx="3" ` +
    `fill="var(--vscode-editorWidget-background)" ` +
    `stroke="var(--vscode-editorWidget-border)"/>` +
    `<text x="${n.x + n.width / 2}" y="${n.y + NODE_HEIGHT / 2 + 4}" text-anchor="middle" ` +
    `fill="var(--vscode-editor-foreground)" font-size="11">${escapeHtml(n.name)}</text>` +
    `<title>${escapeHtml(n.name)}</title></g>`).join('')

  return `<svg width="${layout.width}" height="${layout.height}" ` +
    `viewBox="0 0 ${layout.width} ${layout.height}">${edges}${nodes}</svg>`
}

/** What the panel says when there is no graph. */
export function emptyMessage(state: GraphviewResponse | undefined): string {
  if (state === undefined) return 'Waiting for the prover.'
  if (state.error !== undefined) return `Could not display the graph: ${state.error}`
  return 'No graph in the command under the caret. Put the caret on a thy_deps, ' +
    'class_deps, locale_deps, thm_deps or code_deps command.'
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}
