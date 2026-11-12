/* YXML: Isabelle's compact text form of XML (src/Pure/PIDE/yxml.scala).
 *
 *   element   X Y name (Y attr=value)* X  body  X Y X
 *   text      as is
 *
 * where X = \x05 and Y = \x06, characters no Isabelle text contains. Isabelle2026's
 * language server sends prover output this way where Isabelle2025-2 sent HTML or XML text
 * (the Output and State panels with vscode_html_output, and Sledgehammer), so a message
 * is told apart by whether it contains them at all.
 *
 * No vscode import: suite70 checks this under plain node.
 */

export const X = '\x05'
export const Y = '\x06'

export interface XmlElem { name: string; props: [string, string][]; body: XmlBody }
export type XmlTree = XmlElem | string
export type XmlBody = XmlTree[]

/** As YXML.detect: any X or Y at all. */
export function isYxml(s: string): boolean {
  return s.includes(X) || s.includes(Y)
}

export function isElem(t: XmlTree): t is XmlElem {
  return typeof t !== 'string'
}

export function prop(e: XmlElem, name: string): string | undefined {
  for (const [a, b] of e.props) if (a === name) return b
  return undefined
}

export class YxmlError extends Error {}

/** YXML.parse_body. Throws YxmlError on malformed input; see parseYxmlFailsafe. */
export function parseYxml(source: string): XmlBody {
  const root: XmlBody = []
  const stack: { elem?: XmlElem; body: XmlBody }[] = [{ body: root }]
  for (const chunk of source.split(X)) {
    if (chunk === '') continue
    if (chunk === Y) {
      if (stack.length === 1) throw new YxmlError('unbalanced element')
      const top = stack.pop()!
      stack[stack.length - 1].body.push(top.elem!)
      continue
    }
    const fields = chunk.split(Y)
    if (fields.length === 1) {
      stack[stack.length - 1].body.push(chunk)
    } else if (fields[0] === '') {
      const name = fields[1]
      if (!name) throw new YxmlError('bad element')
      const props: [string, string][] = fields.slice(2).map(f => {
        const eq = f.indexOf('=')
        if (eq <= 0) throw new YxmlError(`bad attribute: ${JSON.stringify(f)}`)
        return [f.slice(0, eq), f.slice(eq + 1)]
      })
      const elem: XmlElem = { name, props, body: [] }
      stack.push({ elem, body: elem.body })
    } else {
      throw new YxmlError('malformed chunk')
    }
  }
  if (stack.length !== 1) throw new YxmlError('unbalanced element')
  return root
}

/** Malformed output is shown as its text rather than not at all. */
export function parseYxmlFailsafe(source: string): XmlBody {
  try { return parseYxml(source) }
  catch { return [source.replace(/[\x05\x06]/g, '')] }
}

export function yxmlOfBody(body: XmlBody): string {
  let s = ''
  const out = (t: XmlTree): void => {
    if (typeof t === 'string') { s += t; return }
    s += X + Y + t.name
    for (const [a, b] of t.props) s += Y + a + '=' + b
    s += X
    for (const c of t.body) out(c)
    s += X + Y + X
  }
  for (const t of body) out(t)
  return s
}

export function yxmlOfTree(tree: XmlTree): string {
  return yxmlOfBody([tree])
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** XML text, as XML.string_of_body: what Isabelle2025-2 sent the Sledgehammer panel. */
export function xmlOfBody(body: XmlBody): string {
  let s = ''
  const out = (t: XmlTree): void => {
    if (typeof t === 'string') { s += escapeXml(t); return }
    s += '<' + t.name
    for (const [a, b] of t.props) s += ` ${a}="${escapeXml(b)}"`
    if (t.body.length === 0) { s += '/>'; return }
    s += '>'
    for (const c of t.body) out(c)
    s += `</${t.name}>`
  }
  for (const t of body) out(t)
  return s
}

/** The text a reader sees: everything but the `xml_body` data of wrapped elements. */
export function content(body: XmlBody): string {
  let s = ''
  const out = (t: XmlTree): void => {
    if (typeof t === 'string') s += t
    else if (t.name !== 'xml_body') for (const c of t.body) out(c)
  }
  for (const t of body) out(t)
  return s
}

/** XML.Wrapped_Elem: an element that carries a second body as data (`xml_body`). */
export function unwrap(t: XmlElem): { name: string; props: [string, string][]; wrapped: XmlBody; body: XmlBody } | undefined {
  if (t.name !== 'xml_elem' || t.props.length === 0 || t.props[0][0] !== 'xml_name') return undefined
  const first = t.body[0]
  if (first === undefined || typeof first === 'string' || first.name !== 'xml_body' || first.props.length) return undefined
  return { name: t.props[0][1], props: t.props.slice(1), wrapped: first.body, body: t.body.slice(1) }
}

export function wrap(name: string, props: [string, string][], wrapped: XmlBody, body: XmlBody): XmlElem {
  return {
    name: 'xml_elem',
    props: [['xml_name', name], ...props],
    body: [{ name: 'xml_body', props: [], body: wrapped }, ...body],
  }
}
