/* Prover output for the Query and Sledgehammer panels, which receive it as XML, rebuilt
 * as DOM nodes in their webviews. Pure, so suite49 can check it with stand-in nodes.
 *
 * These functions run *in the webview*: each panel embeds their source in its script
 * (`${markupText}`), so they may use nothing but their parameters and each other -- no
 * imports, no module state.
 *
 * Built with createElement/createTextNode, never innerHTML: the text can echo a theory
 * file, and this way none of it is ever read as markup.
 */

/** As much of a parsed XML node as the rendering reads. */
export interface MarkupNode {
  nodeType: number
  nodeName: string
  nodeValue: string | null
  childNodes: ArrayLike<MarkupNode>
  getAttribute?(name: string): string | null
}

/** As much of a DOM element or text node as the rendering writes. */
export interface OutputNode {
  className?: string
  title?: string
  textContent?: string | null
  appendChild(child: OutputNode): unknown
  addEventListener?(type: string, listener: () => void): void
}

export interface OutputDocument {
  createElement(tag: string): OutputNode
  createTextNode(text: string): OutputNode
}

/**
 * The text a reader sees in `node`. A wrapped element (`xml_elem`, from XML.wrap_elem)
 * carries a second body, `xml_body`: data for the front end, like the sort of a type
 * variable that jEdit shows on hover. It is never part of the text -- shown, it put a
 * `type` before every `'a` of a Find Theorems result.
 */
export function markupText(node: MarkupNode): string {
  if (node.nodeType === 3) return node.nodeValue ?? ''
  if (node.nodeType !== 1 || node.nodeName === 'xml_body') return ''
  let text = ''
  for (const child of Array.from(node.childNodes)) text += markupText(child)
  return text
}

/**
 * Append what `node` holds to `into`: text as text, each element as a span classed by
 * its markup name, which isabelleCss() colours, and no `xml_body` (see markupText) --
 * except that the type or sort a wrapped typing or sorting carries becomes the title of
 * its span, which shows on hover as it does in jEdit.
 * Given `sendback`, a <sendback> element -- a proof Sledgehammer suggests -- becomes a
 * button that passes its text on when clicked.
 */
export function renderMarkup(
  node: MarkupNode, into: OutputNode, doc: OutputDocument, sendback?: (text: string) => void,
): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      into.appendChild(doc.createTextNode(child.nodeValue ?? ''))
    } else if (child.nodeType !== 1 || child.nodeName === 'xml_body') {
      continue
    } else if (child.nodeName === 'sendback' && sendback) {
      const text = markupText(child).trim()
      const button = doc.createElement('button')
      button.className = 'sendback'
      button.textContent = text
      button.addEventListener?.('click', () => sendback(text))
      into.appendChild(button)
    } else {
      const span = doc.createElement('span')
      span.className = child.nodeName
      const wrapped = child.getAttribute?.('xml_name')
      if (child.nodeName === 'xml_elem' && (wrapped === 'typing' || wrapped === 'sorting')) {
        const body = Array.from(child.childNodes)
          .find(c => c.nodeType === 1 && c.nodeName === 'xml_body')
        if (body) {
          span.title = ':: ' +
            Array.from(body.childNodes).map(markupText).join('').replace(/\s+/g, ' ').trim()
        }
      }
      renderMarkup(child, span, doc, sendback)
      into.appendChild(span)
    }
  }
}
