/* Formatted prover output as HTML for the infoview, the way Isabelle2025-2's server made
 * it: a port of Browser_Info.Node_Context.make_html (src/Pure/Build/browser_info.scala,
 * Isabelle2026) with the stylesheet's class names, plus the links and buttons Isabelle2026's
 * own output view adds (Pretty_Text_Area in src/Tools/VSCode/extension).
 *
 * Classes: an element whose name has a text colour (Rendering.text_color and foreground)
 * gets that colour's name -- `free`, `keyword1`, `quoted` -- which isabelleCss() colours;
 * any other element its own name, so messages come out as `writeln_message` etc.
 *
 * What a click does is a `data-command` the panel scripts already route to the extension:
 *   entity with a definition   gotoSource {file, line, offset} | gotoCommand {id, offset}
 *   path, url                  gotoFile | openUrl
 *   sendback, dialog           markupAction (the element as YXML, base64)
 *
 * Text is escaped, never inserted as markup; symbols are shown as their glyphs, with
 * \<^sub>, \<^sup>, \<^bold> and \<^bsub>...\<^esub> as HTML.output renders them.
 *
 * No vscode import: suite70 checks this against Isabelle's own output.
 */

import { formatted, separate, symbols } from './pretty'
import { XmlBody, XmlElem, XmlTree, content, parseYxmlFailsafe, prop, unwrap, yxmlOfTree } from './yxml'

/** Rendering.text_color and Rendering.foreground (which wins), Isabelle2026. */
const TEXT_COLOR: Record<string, string> = {
  keyword1: 'keyword1', keyword2: 'keyword2', keyword3: 'keyword3',
  quasi_keyword: 'quasi_keyword', improper: 'improper', operator: 'operator',
  string: 'main', alt_string: 'main', cartouche: 'main', literal: 'keyword1', delimiter: 'main',
  tfree: 'tfree', tvar: 'tvar', free: 'free', skolem: 'skolem', bound: 'bound', var: 'var',
  inner_string: 'inner_quoted', inner_cartouche: 'inner_cartouche', dynamic_fact: 'dynamic',
  class_parameter: 'class_parameter', antiquote: 'antiquote', raw_text: 'raw_text',
  plain_text: 'plain_text',
  ML_keyword1: 'keyword1', ML_keyword2: 'keyword2', ML_keyword3: 'keyword3',
  ML_delimiter: 'main', ML_numeral: 'inner_numeral', ML_char: 'inner_quoted',
  ML_string: 'inner_quoted', ML_comment: 'comment1',
  comment: 'comment1', comment1: 'comment1', comment2: 'comment2', comment3: 'comment3',
}
const FOREGROUND: Record<string, string> = {
  string: 'quoted', alt_string: 'quoted', cartouche: 'quoted', antiquoted: 'antiquoted',
}

export const ACTIVE_ELEMENTS = new Set(['sendback', 'dialog'])

/** A symbol's glyph, or undefined to show the symbol as written. */
export type Glyphs = (symbol: string) => string | undefined

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, '&quot;')

/** What `data-arg` carries for markupAction: survives an attribute and the message. */
export function encodeActive(yxml: string): string {
  return Buffer.from(yxml, 'utf8').toString('base64')
}
export function decodeActive(arg: string): string {
  return Buffer.from(arg, 'base64').toString('utf8')
}

/* text: symbols, control symbols (HTML.traverse with hidden = false) */

const CONTROL: Record<string, string> = { '\\<^sub>': 'sub', '\\<^sup>': 'sup', '\\<^bold>': 'b' }
const BLOCK_BEGIN: Record<string, string> = { '\\<^bsub>': 'sub', '\\<^bsup>': 'sup' }
const BLOCK_END: Record<string, string> = { '\\<^esub>': 'sub', '\\<^esup>': 'sup' }

const isBlank = (s: string) => s === ' ' || s === '\t' || s === '\n' || s === '\x0b' || s === '\f' || s === '\r' || s === '\r\n'
const isControllable = (s: string) =>
  !isBlank(s) && !s.startsWith('\\<^') && s !== '\\<open>' && s !== '\\<close>' &&
  s !== '‹' && s !== '›' && s !== '"'

function checkControlBlocks(syms: string[]): boolean {
  const open: string[] = []
  for (const s of syms) {
    if (BLOCK_BEGIN[s]) open.push(s)
    else if (BLOCK_END[s]) {
      const bg = open.pop()
      if (bg === undefined || BLOCK_BEGIN[bg] !== BLOCK_END[s]) return false
    }
  }
  return open.length === 0
}

export function textHtml(text: string, glyphs: Glyphs): string {
  const syms = symbols(text)
  const blocks = checkControlBlocks(syms)
  let out = ''
  const symbol = (s: string): void => {
    if (s === '') return
    if (blocks && BLOCK_BEGIN[s]) out += `<${BLOCK_BEGIN[s]}>`
    else if (blocks && BLOCK_END[s]) out += `</${BLOCK_END[s]}>`
    else out += escapeHtml(glyphs(s) ?? s)
  }
  let ctrl = ''
  for (const s of syms) {
    if (CONTROL[s]) { symbol(ctrl); ctrl = s; continue }
    const op = CONTROL[ctrl]
    if (op && isControllable(s)) {
      out += `<${op}>`
      symbol(s)
      out += `</${op}>`
    } else {
      symbol(ctrl)
      symbol(s)
    }
    ctrl = ''
  }
  symbol(ctrl)
  return out
}

/* elements */

interface Fragment { html: string; div: boolean }

const DIV_TAGS = new Set(['div', 'pre', 'p', 'ul', 'ol', 'dl'])

function htmlClass(c: string, f: Fragment): Fragment {
  if (c === '') return f
  return f.div
    ? { html: `<div class="${escapeAttr(c)}">${f.html}</div>`, div: true }
    : { html: `<span class="${escapeAttr(c)}">${f.html}</span>`, div: false }
}

function tag(name: string, f: Fragment, attrs = ''): Fragment {
  return { html: `<${name}${attrs}>${f.html}</${name}>`, div: f.div || DIV_TAGS.has(name) }
}

function command(cmd: string, arg: string, f: Fragment, element = 'a', cls = ''): Fragment {
  const c = cls ? ` class="${cls}"` : ''
  return {
    html: `<${element}${c} data-command="${cmd}" data-arg="${escapeAttr(arg)}">${f.html}</${element}>`,
    div: f.div,
  }
}

/** Where an entity is defined, as Position.Item_Def_File / Item_Def_Id read it. */
function entityLink(e: XmlElem, f: Fragment): Fragment {
  const offset = Number(prop(e, 'def_offset') ?? 0) || 0
  const file = prop(e, 'def_file')
  const line = prop(e, 'def_line')
  if (file !== undefined && line !== undefined) {
    return command('gotoSource', JSON.stringify({ file, line: Number(line) || 0, offset }), f)
  }
  const id = prop(e, 'def_id')
  if (id !== undefined) return command('gotoCommand', JSON.stringify({ id: Number(id), offset }), f)
  return f
}

export function makeHtml(body: XmlBody, glyphs: Glyphs): string {
  const tree = (t: XmlTree): Fragment => {
    if (typeof t === 'string') return { html: textHtml(t, glyphs), div: false }

    const w = unwrap(t)
    if (w) {
      const inner = bodyOf(w.body)
      /* The type of an atom, or the sort of a type variable, that printing wraps around
         it: Browser_Info drops it, and the extended server makes it a title, as jEdit's
         tooltip shows it. */
      if (w.name === 'typing' || w.name === 'sorting') {
        const title = ':: ' + content(w.wrapped).replace(/\s+/g, ' ').trim()
        const glyphTitle = symbols(title).map(s => glyphs(s) ?? s).join('')
        return { html: `<span class="typing" title="${escapeAttr(glyphTitle)}">${inner.html}</span>`, div: inner.div }
      }
      return element({ name: w.name, props: w.props, body: w.body }, inner)
    }
    return element(t, bodyOf(t.body))
  }

  const bodyOf = (b: XmlBody): Fragment => {
    let html = ''
    let div = false
    for (const t of b) { const f = tree(t); html += f.html; div = div || f.div }
    return { html, div }
  }

  const element = (e: XmlElem, inner: Fragment): Fragment => {
    const kind = prop(e, 'kind')
    switch (e.name) {
      case 'entity':
        if (kind !== undefined) return entityLink(e, inner)
        break
      case 'path': {
        const file = prop(e, 'name')
        if (file !== undefined) return command('gotoFile', file, inner)
        break
      }
      case 'url': {
        const href = prop(e, 'name')
        if (href !== undefined) return command('openUrl', href, inner)
        break
      }
      case 'language':
        return htmlClass(prop(e, 'name') === 'document' ? 'document' : '', inner)
      case 'markdown_paragraph': return tag('p', inner)
      case 'markdown_item': return tag('li', inner)
      case 'markdown_bullet': return { html: '', div: false }
      case 'markdown_list': return tag(prop(e, 'kind') === 'enumerate' ? 'ol' : 'ul', inner)
    }
    if (ACTIVE_ELEMENTS.has(e.name)) {
      return command('markupAction', encodeActive(yxmlOfTree(e)), inner, 'span', 'active')
    }
    const html = kind === 'command' || kind === 'keyword' ? htmlClass(kind, inner) : inner
    const c = prop(e, 'syntax') === 'true' ? '' : FOREGROUND[e.name] ?? TEXT_COLOR[e.name] ?? e.name
    return htmlClass(c, html)
  }

  return bodyOf(body).html
}

/** A 2026 server's Output or State content, formatted to `margin` and made HTML. */
export function renderPideOutput(yxml: string, margin: number | undefined, glyphs: Glyphs): string {
  const messages = parseYxmlFailsafe(yxml)
  return makeHtml(formatted(separate(messages), { margin: margin ?? undefined }), glyphs)
}
