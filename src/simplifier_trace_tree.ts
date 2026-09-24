/* The simplifier trace as a tree, rebuilt from the flat list the server sends.
 *
 * No vscode import, so the structure and its wording can be tested under plain node.
 *
 * Every item the prover emits names the item it was emitted under (Simplifier_Trace.ML
 * threads `parent` through the context), and that is what turns a log into an
 * explanation:
 *
 *   recurse  "Simplifier invoked" on a term
 *     step   a rewrite rule tried on a subterm
 *       recurse  the simplifier re-invoked on that rule's side condition
 *         ...    the side condition's own rewrites
 *       hint     whether the step succeeded, and what it produced
 *
 * Read in emission order the same items are a wall of terms in which a side-condition
 * attempt looks exactly like a rewrite of the goal. This follows Simplifier_Trace_Window
 * (walk_trace) in how it assembles the tree, but folds each step's hint into the step
 * itself: the outcome is a property of the step, and a separate row for it would double
 * the length of every trace while saying less.
 */

import { TraceEntry } from './simplifier_trace_view'

export type Outcome = 'rewrote' | 'failed' | 'pending' | 'none'

export interface TraceNode {
  entry: TraceEntry
  children: TraceNode[]
  /** The step's own outcome hints, attached here rather than shown as rows. */
  hints: TraceEntry[]
  up?: TraceNode
}

const isStep = (e: TraceEntry): boolean => e.kind === 'step' || e.kind === 'log'

/**
 * Assemble the tree.
 *
 * An item whose parent is unknown becomes a root rather than being dropped: the first
 * invocation's parent is the prover's context, which is never itself an item, and a
 * trace cut off by a depth limit has the same shape. Losing entries there would hide
 * exactly the part of the trace someone is looking for.
 */
export function buildTraceTree(entries: TraceEntry[]): TraceNode[] {
  const roots: TraceNode[] = []
  const lookup = new Map<number, TraceNode>()
  for (const e of [...entries].sort((a, b) => a.serial - b.serial)) {
    const up = e.parent === undefined ? undefined : lookup.get(e.parent)
    if (e.kind === 'ignore') {
      /* "Redo" on a failed step: the prover replays it, and `parent` here is the step
         being replaced rather than where the ignore hangs. The replay arrives as a fresh
         step, so the abandoned attempt goes -- as in walk_trace. */
      if (up !== undefined) detach(up, roots)
      continue
    }
    if (e.kind === 'hint' && up !== undefined && isStep(up.entry)) {
      up.hints.push(e)
      continue
    }
    const node: TraceNode = { entry: e, children: [], hints: [], up }
    ;(up === undefined ? roots : up.children).push(node)
    lookup.set(e.serial, node)
  }
  return roots
}

function detach(node: TraceNode, roots: TraceNode[]): void {
  const siblings = node.up === undefined ? roots : node.up.children
  const i = siblings.indexOf(node)
  if (i >= 0) siblings.splice(i, 1)
}

/**
 * What became of a step.
 *
 * `none` is honest rather than a guess: a step with no hint was either skipped, or
 * answered with "Continue (without any trace)", which switches off the very output that
 * would have said. Both look the same from here.
 */
export function outcome(node: TraceNode, pending?: number): Outcome {
  const e = node.entry
  if (pending !== undefined &&
      (e.serial === pending || node.hints.some(h => h.serial === pending))) return 'pending'
  if (e.kind === 'hint') return e.success === false ? 'failed' : 'rewrote'
  if (node.hints.some(h => h.success === true)) return 'rewrote'
  if (node.hints.some(h => h.success === false)) return 'failed'
  return 'none'
}

export interface RuleApplication { rule?: string; instance?: string; term?: string }

/* Simplifier_Trace.ML words a step as "Instance of NAME: EQN" / "Trying to rewrite: T",
   optionally followed by "Matching terms:", and a failure as "In an instance of ..." /
   "Was trying to rewrite: ...". The chunks are separated by forced breaks, which
   XML.content turns into newlines -- so a newline, not a sentence, delimits each part. */
const RULE_RE =
  /^(?:In an i|I)nstance of (.*?):\s+([\s\S]*?)\n(?:Was t|T)rying to rewrite:\s+([\s\S]*?)(?:\nMatching terms:[\s\S]*)?$/

export function ruleApplication(plain: string | undefined): RuleApplication {
  const m = plain === undefined ? null : RULE_RE.exec(plain)
  return m ? { rule: m[1], instance: m[2], term: m[3] } : {}
}

/**
 * A rule name as a reader should see it.
 *
 * Rules without a name of their own -- a premise the simplifier was given, an equation
 * it derived -- print as "??.??.unknown", which reads like a malfunction rather than an
 * absence.
 */
export function ruleLabel(rule: string | undefined): string | undefined {
  if (rule === undefined) return undefined
  return /^(\?\?\.)*unknown$/.test(rule) ? 'unnamed rule' : rule
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

export interface NodeView {
  outcome: Outcome | 'invocation'
  badge: string
  label: string
  rule?: string
  term: string
  tip: string
}

const BADGE: Record<Outcome, string> = { rewrote: '✓', failed: '✗', pending: '⏸', none: '·' }

export function nodeView(node: TraceNode, pending?: number): NodeView {
  const e = node.entry
  const plain = e.plain ?? ''

  if (e.kind === 'recurse') {
    const under = node.up?.entry
    const [label, tip] =
      under === undefined
        ? ['Simplifier invoked', 'The simplifier called on this term.']
        : isStep(under)
          ? ['Side condition', 'The simplifier re-invoked to prove a condition of the rule above; ' +
                               'the rule applies only if this simplifies to True.']
          : ['Nested simplification', 'A recursive simplifier call, typically the side condition ' +
                                      'of a conditional rule that was not traced as a step.']
    return { outcome: 'invocation', badge: '', label, term: oneLine(plain || e.text), tip }
  }

  const o = outcome(node, pending)
  if (isStep(e)) {
    const app = ruleApplication(plain)
    const conditional = /conditional/i.test(e.text)
    return {
      outcome: o, badge: BADGE[o],
      label: conditional ? 'Conditional rewrite' : 'Rewrite',
      rule: ruleLabel(app.rule),
      term: oneLine(app.term ?? plain),
      tip: e.kind === 'log' ? 'Recorded without asking.' : OUTCOME_TIP[o],
    }
  }

  if (e.kind === 'hint') {
    if (e.success === false) {
      const app = ruleApplication(plain)
      return { outcome: o, badge: BADGE[o], label: 'Failed', rule: ruleLabel(app.rule),
               term: oneLine(app.term ?? plain), tip: OUTCOME_TIP.failed }
    }
    return { outcome: o, badge: BADGE[o], label: 'Rewrote', term: oneLine(plain), tip: OUTCOME_TIP.rewrote }
  }

  return { outcome: o, badge: '', label: e.text, term: oneLine(plain), tip: '' }
}

const OUTCOME_TIP: Record<Outcome, string> = {
  rewrote: 'The rule applied.',
  failed: 'The rule matched but did not apply -- for a conditional rule, a side condition ' +
          'was not proved.',
  pending: 'The simplifier is suspended here, waiting for your answer in the Simplifier Trace panel.',
  none: 'No outcome recorded: the step was skipped, or tracing was switched off below it.',
}

export interface TraceStats { invocations: number; steps: number; rewrites: number; failures: number }

export function traceStats(nodes: TraceNode[]): TraceStats {
  const s: TraceStats = { invocations: 0, steps: 0, rewrites: 0, failures: 0 }
  const walk = (n: TraceNode): void => {
    const e = n.entry
    if (e.kind === 'recurse') s.invocations++
    else if (isStep(e)) s.steps++
    const o = e.kind === 'recurse' ? undefined : outcome(n)
    if (o === 'rewrote') s.rewrites++
    else if (o === 'failed') s.failures++
    n.children.forEach(walk)
  }
  nodes.forEach(walk)
  return s
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function statsLine(s: TraceStats): string {
  return [plural(s.invocations, 'simplifier call'), plural(s.rewrites, 'rewrite'),
          plural(s.failures, 'failed attempt')].join(' · ')
}

/** The serials from a root down to the pending question, opened by default. */
function pathTo(nodes: TraceNode[], pending: number | undefined): Set<number> {
  const path = new Set<number>()
  if (pending === undefined) return path
  const find = (n: TraceNode): boolean => {
    if (n.entry.serial === pending || n.hints.some(h => h.serial === pending) ||
        n.children.some(find)) {
      path.add(n.entry.serial)
      return true
    }
    return false
  }
  nodes.forEach(find)
  return path
}

/**
 * The tree as HTML.
 *
 * Each node is one <details> whose summary is a single line -- outcome, what happened,
 * which rule, on what -- so the shape of the whole run can be read collapsed, and a
 * node's full rendering (rule instance, result, side conditions) is one click away.
 *
 * `content` is the server's rendered HTML and goes in as markup, as everywhere else in
 * these panels; the page's CSP is what keeps that safe. Everything derived from `plain`
 * is text and is escaped.
 */
export function renderTraceTree(roots: TraceNode[], pending?: number): string {
  if (roots.length === 0) {
    return '<p class="empty">No trace recorded for the command under the caret. ' +
      'Put the caret in a proof traced with <code>simp_trace_new</code> -- the Simplifier ' +
      'Trace panel says how -- and refresh.</p>'
  }
  const open = pathTo(roots, pending)
  const render = (n: TraceNode, depth: number): string => {
    const e = n.entry
    const v = nodeView(n, pending)
    const isOpen = open.has(e.serial) || (depth === 0 && e.kind === 'recurse')
    const cls = `node kind-${e.kind ?? 'other'} outcome-${v.outcome}`
    const search = [v.label, v.rule ?? '', e.plain ?? e.text].join(' ').toLowerCase()

    const badge = v.badge ? `<span class="badge">${v.badge}</span>` : ''
    const rule = v.rule ? `<span class="rule">${escapeHtml(v.rule)}</span>` : ''
    const stats = e.kind === 'recurse' && n.children.length > 0
      ? `<span class="stats">${escapeHtml(subtreeLine(n))}</span>` : ''
    const summary =
      `<summary title="${escapeAttr(v.tip)}">${badge}<span class="label">${escapeHtml(v.label)}</span>` +
      `${rule}<span class="term" title="${escapeAttr(v.term.slice(0, 2000))}">${escapeHtml(v.term)}</span>` +
      `${stats}</summary>`

    const result = n.hints.filter(h => h.success === true)
      .map(h => `<div class="outcome rewrote"><span class="caption">Result</span>${h.content}</div>`)
    const failure = n.hints.filter(h => h.success === false)
      .map(h => `<div class="outcome failed"><span class="caption">Failed</span>${h.content}</div>`)
    const children = n.children.length > 0
      ? `<ul>${n.children.map(c => render(c, depth + 1)).join('')}</ul>` : ''

    return `<li class="${cls}" data-serial="${e.serial}" data-search="${escapeAttr(search)}">` +
      `<details${isOpen ? ' open' : ''}>${summary}<div class="detail">${e.content}</div>` +
      `${result.join('')}${failure.join('')}${children}</details></li>`
  }
  return `<ul class="trace-tree">${roots.map(r => render(r, 0)).join('')}</ul>`
}

function subtreeLine(n: TraceNode): string {
  const s = traceStats(n.children)
  const parts = [plural(s.rewrites, 'rewrite')]
  if (s.failures > 0) parts.push(`${s.failures} failed`)
  return parts.join(', ')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}
