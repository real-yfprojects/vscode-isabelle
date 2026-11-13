/* Isabelle's pretty printer: line breaking of prover output to a margin.
 *
 * A port of Pretty.formatted (src/Pure/General/pretty.scala, Isabelle2026). Prover output
 * arrives as XML with `block` and `break` elements; formatting decides which breaks become
 * newlines and replaces both with text, keeping every other element around its text.
 * Isabelle2025-2's server did this before sending a panel its HTML; Isabelle2026's sends
 * the unformatted output and leaves this to the client, as its own Scala.js output view
 * does, so the infoview needs it to show a 2026 server's goals at all.
 *
 * The structure follows the Scala closely, including its persistent buffers: a block with
 * markup formats its body on a reset copy of the text and restores the outer one after,
 * which only works if the outer one is not mutated meanwhile. The loop over a tree list is
 * iterative, so long output does not exhaust the stack; recursion is only into nested
 * blocks.
 *
 * No vscode import: suite70 checks this against Isabelle's own output.
 */

import { XmlBody, XmlElem, XmlTree, prop, unwrap, wrap } from './yxml'

/* Isabelle symbols as Symbol.iterator sees them, else single codepoints. */
const SYMBOL_ITER = /\\<\^?[A-Za-z][A-Za-z0-9_']*>|[\s\S]/gu

export function symbols(text: string): string[] {
  return text.match(SYMBOL_ITER) ?? []
}

/** Symbol.Metric: the width of a text in spaces, as the server measured it for 2025-2. */
export function symbolMetric(text: string): number {
  let width = 0
  for (const sym of symbols(text)) {
    if (sym.startsWith('\\<^')) continue
    if (sym.startsWith('\\<longlonglong')) width += 4
    else if (sym.startsWith('\\<longlong')) width += 3
    else if (sym.startsWith('\\<long') || sym.startsWith('\\<Long')) width += 2
    else if (sym.length === 1 && sym.charCodeAt(0) < 0x80) {
      const c = sym.charCodeAt(0)
      if ((c >= 0x20 && c < 0x7f) || c === 0x09 || c === 0x0b || c === 0x0c || c === 0x0d) width += 1
    } else width += 1
  }
  return width
}

/* XML constructors */

export const SEPARATOR: XmlBody = [{ name: 'separator', props: [], body: [' '] }, '\n']

/** Pretty.separate: messages one below the other, with a separator between. */
export function separate(ts: XmlBody, sep: XmlBody = SEPARATOR): XmlBody {
  const out: XmlBody = []
  ts.forEach((t, i) => { if (i > 0) out.push(...sep); out.push(t) })
  return out
}

/* markup trees with physical blocks and breaks */

type MarkupBody = { name: string; props: [string, string][]; wrapped?: XmlBody } | null

type Tree =
  | { k: 'end'; length: number }
  | { k: 'block'; markup: MarkupBody; open: boolean; consistent: boolean; indent: number; body: Tree[]; length: number }
  | { k: 'break'; force: boolean; width: number; indent: number; length: number }
  | { k: 'str'; s: string; length: number }

const END: Tree = { k: 'end', length: 0 }
const mkBreak = (force: boolean, width: number, indent: number): Tree =>
  ({ k: 'break', force, width, indent, length: width })
const FBREAK = mkBreak(true, 1, 0)
const ITEM_MARKUP: MarkupBody = { name: 'expression', props: [['kind', 'item']] }
const BULLET: XmlBody = [{ name: 'bullet', props: [], body: [' '] }, ' ']

const nat = (i: number) => Math.max(0, i)

function intProp(e: XmlElem, name: string): number {
  const v = prop(e, name)
  if (v === undefined) return 0
  const n = Number.parseInt(v, 10)
  return Number.isNaN(n) ? 0 : n
}

function makeBlock(body: Tree[], markup: MarkupBody, open: boolean, consistent: boolean, indent: number): Tree {
  const indent1 = nat(indent)
  // body_length: the widest line, a forced break starting the next at indent + its own.
  let len = 0
  let line = 0
  for (const t of body) {
    if (t.k === 'break' && t.force) {
      len = Math.max(len, line)
      line = indent1 + t.indent
    } else line += t.length
  }
  len = Math.max(len, line)
  return { k: 'block', markup, open, consistent, indent: indent1, body, length: len }
}

/* Text being built: a stack of result buffers, as persistent lists. */

type List<T> = { h: T; t: List<T> } | null
const cons = <T>(h: T, t: List<T>): List<T> => ({ h, t })

type TreeBuffer =
  | { k: 'text'; parts: List<string> }      // reversed
  | { k: 'elem'; markup: NonNullable<MarkupBody>; body: XmlBody }

interface ResultBuffer { markup: MarkupBody; buffer: List<TreeBuffer> }   // reversed

interface Text { main: List<ResultBuffer>; pos: number; nl: number }

const INIT_STATE: List<ResultBuffer> = cons({ markup: null, buffer: null }, null)

function elemResult(e: { markup: NonNullable<MarkupBody>; body: XmlBody }): XmlElem {
  const m = e.markup
  return m.wrapped === undefined
    ? { name: m.name, props: m.props, body: e.body }
    : wrap(m.name, m.props, m.wrapped, e.body)
}

function resultBody(res: ResultBuffer): XmlBody {
  const out: XmlBody = []
  for (let b = res.buffer; b; b = b.t) {
    const tb = b.h
    if (tb.k === 'elem') out.push(elemResult(tb))
    else {
      const parts: string[] = []
      for (let p = tb.parts; p; p = p.t) parts.push(p.h)
      out.push(parts.reverse().join(''))
    }
  }
  return out.reverse()
}

function resAdd(res: ResultBuffer, elem: TreeBuffer): ResultBuffer {
  return { markup: res.markup, buffer: cons(elem, res.buffer) }
}

function resString(res: ResultBuffer, s: string): ResultBuffer {
  if (s === '') return res
  const head = res.buffer?.h
  if (head && head.k === 'text') {
    return { markup: res.markup, buffer: cons<TreeBuffer>({ k: 'text', parts: cons(s, head.parts) }, res.buffer!.t) }
  }
  return { markup: res.markup, buffer: cons<TreeBuffer>({ k: 'text', parts: cons(s, null) }, res.buffer) }
}

function textAdd(text: Text, elem: TreeBuffer): Text {
  const main = text.main!
  return { ...text, main: cons(resAdd(main.h, elem), main.t) }
}

function textPush(text: Text, m: MarkupBody): Text {
  return { ...text, main: cons({ markup: m, buffer: null }, text.main) }
}

function textPop(text: Text): Text {
  const res1 = text.main!.h
  const res2 = text.main!.t!.h
  const rest = text.main!.t!.t
  const elem: TreeBuffer = { k: 'elem', markup: res1.markup!, body: resultBody(res1) }
  return { ...text, main: cons(resAdd(res2, elem), rest) }
}

function textResult(text: Text): XmlBody {
  return resultBody(text.main!.h)
}

function textString(text: Text, s: string, len: number): Text {
  const main = text.main!
  return { main: cons(resString(main.h, s), main.t), pos: text.pos + len, nl: text.nl }
}

const textBlanks = (text: Text, wd: number) => textString(text, ' '.repeat(wd), wd)

function textNewline(text: Text): Text {
  const t = textString(text, '\n', 0)
  return { main: t.main, pos: 0, nl: text.nl + 1 }
}

/* formatting */

function breakDist(trees: List<Tree>, after: number): number {
  let d = 0
  for (let l = trees; l; l = l.t) {
    if (l.h.k === 'break') return d
    d += l.h.length
  }
  return d + after
}

const forceBreak = (t: Tree): Tree => t.k === 'break' && !t.force ? mkBreak(true, t.width, t.indent) : t

function forceNext(trees: List<Tree>): List<Tree> {
  const prefix: Tree[] = []
  let l = trees
  for (; l; l = l.t) {
    if (l.h.k === 'break') { l = cons(forceBreak(l.h), l.t); break }
    prefix.push(l.h)
  }
  for (let i = prefix.length - 1; i >= 0; i--) l = cons(prefix[i], l)
  return l
}

function fromArray(ts: Tree[], tail: List<Tree> = null): List<Tree> {
  let l = tail
  for (let i = ts.length - 1; i >= 0; i--) l = cons(ts[i], l)
  return l
}

export const DEFAULT_MARGIN = 76
export const DEFAULT_BREAKGAIN = DEFAULT_MARGIN / 20

export interface FormatOptions {
  margin?: number
  breakgain?: number
  metric?: (s: string) => number
}

/** Pretty.formatted. */
export function formatted(input: XmlBody, opts: FormatOptions = {}): XmlBody {
  const margin = opts.margin ?? DEFAULT_MARGIN
  const breakgain = opts.breakgain ?? DEFAULT_BREAKGAIN
  const metric = opts.metric ?? symbolMetric
  const marginDefined = margin > 0
  const margin1 = marginDefined ? margin : DEFAULT_MARGIN
  const emergencypos = Math.round(Math.max(margin1 / 2, 1))

  const makeTree = (inp: XmlBody): Tree[] => {
    const out: Tree[] = []
    for (const t of inp) {
      if (typeof t === 'string') {
        t.split('\n').forEach((s, i) => {
          if (i > 0) out.push(FBREAK)
          out.push({ k: 'str', s, length: metric(s) })
        })
        continue
      }
      const w = unwrap(t)
      if (w) {
        out.push(makeBlock(makeTree(w.body), { name: w.name, props: w.props, wrapped: w.wrapped }, true, false, 0))
      } else if (t.name === 'block') {
        out.push(makeBlock(makeTree(t.body), null, false, prop(t, 'consistent') === 'true', intProp(t, 'indent')))
      } else if (t.name === 'break') {
        out.push(mkBreak(false, nat(intProp(t, 'width')), nat(intProp(t, 'indent'))))
      } else if (t.name === 'item') {
        out.push(makeBlock(makeTree([...BULLET, ...t.body]), ITEM_MARKUP, false, false, 2))
      } else {
        out.push(makeBlock(makeTree(t.body), { name: t.name, props: t.props }, true, false, 0))
      }
    }
    return out
  }

  const format = (trees: List<Tree>, before: number, after: number, text0: Text): Text => {
    let text = text0
    let ts = trees
    while (ts) {
      const t = ts.h
      ts = ts.t
      switch (t.k) {
        case 'end':
          text = textPop(text)
          break
        case 'str':
          text = textString(text, t.s, t.length)
          break
        case 'break':
          if (!t.force &&
              (!marginDefined ||
                text.pos + t.width <= Math.max(margin - breakDist(ts, after), before + breakgain))) {
            text = textBlanks(text, t.width)
          } else {
            text = textBlanks(textNewline(text), Math.ceil(before + t.indent))
          }
          break
        case 'block': {
          if (t.open) {
            ts = fromArray(t.body, cons(END, ts))
            text = textPush(text, t.markup)
            break
          }
          const pos1 = text.pos + t.indent
          const pos2 = Math.round(pos1) % emergencypos
          const before1 = !marginDefined || pos1 < emergencypos ? pos1 : pos2
          const after1 = breakDist(ts, after)
          const body1 =
            marginDefined && t.consistent && text.pos + t.length > margin - after1
              ? t.body.map(forceBreak)
              : t.body
          let btext1: Text
          if (t.markup === null) btext1 = format(fromArray(body1), before1, after1, text)
          else {
            const btext = format(fromArray(body1), before1, after1, { ...text, main: INIT_STATE })
            const elem: TreeBuffer = { k: 'elem', markup: t.markup, body: textResult(btext) }
            btext1 = { ...btext, main: textAdd(text, elem).main }
          }
          if (text.nl < btext1.nl) ts = forceNext(ts)
          text = btext1
          break
        }
      }
    }
    return text
  }

  return textResult(format(fromArray(makeTree(input)), 0, 0, { main: INIT_STATE, pos: 0, nl: 0 }))
}

export type { XmlTree }
