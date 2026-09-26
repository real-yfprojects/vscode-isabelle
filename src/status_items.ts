/* Presentation for the Isabelle status bar item: session, server, checking progress.
 *
 * Pure, like session_items.ts: the `vscode` and theories_panel imports are type-only and
 * erased at compile time, so this runs under plain node (suite39). status_bar.ts turns
 * the result into a real StatusBarItem.
 *
 * The item is the session picker's, grown. Which session the server boots is only half
 * of what you want to know from a glance at the corner of the window; the other half is
 * whether that server is up, still building its heap, or checking -- which otherwise
 * lives in a progress notification that is gone once dismissed, and in the Theories view.
 */

import type { NodeStatus } from './theories_panel'
import { sessionSummary, statusText } from './session_items'

export type ServerPhase = 'off' | 'starting' | 'building' | 'running' | 'failed'

/** The whole of PIDE/theories_response that fits in a status bar. */
export interface Progress {
  theories: number
  /** At 100%, failed or not: Node_Status caps an unconsolidated theory at 99. */
  done: number
  /** Running a command, or waiting for its imports to resolve. */
  running: number
  failed: number
  loading: boolean
}

export interface StatusInput {
  logic: string
  requirements: boolean
  server: ServerPhase
  /** Building: the latest build line. Failed: why. */
  detail?: string
  /** Undefined when no theories_response has arrived: a stock server never sends one. */
  progress?: Progress
  /** Session.Phase as the server prints it, e.g. `ready`. */
  prover?: string
  /** isabelle.checkWholeTheory, which decides what the toggle link offers. */
  wholeTheory: boolean
  /** The vscode_caret_perspective the server runs with, 0 for the whole theory. It is
      not always what wholeTheory says: an -o in serverOptions or serverArgs can set it. */
  perspective: number
  /** Set when the settings now say otherwise: what the next start will use. */
  nextPerspective?: number
  /** False when activation stopped early (no Isabelle found): the server and session
      commands were never registered, so offering them would only produce errors. */
  controls: boolean
  /** Files of the heap image that changed since the server started; see heap_files.ts. */
  stale?: readonly StaleEntry[]
}

export interface StaleEntry {
  file: string
  label: string
  change: 'modified' | 'deleted' | 'unsaved'
}

export interface StatusView {
  text: string
  /** Markdown, with command links from TOOLTIP_COMMANDS. */
  tooltip: string
  background?: 'error' | 'warning'
}

/** The only commands the tooltip may run; status_bar.ts trusts exactly these. */
export const TOOLTIP_COMMANDS = [
  'isabelle.selectSession',
  'isabelle.restartServer',
  'isabelle.showOutput',
  'isabelle-theories.focus',
  'isabelle.toggleWholeTheoryChecking',
  'isabelle.showStaleFiles',
]

/** Isabelle's own default for vscode_caret_perspective (src/Tools/VSCode/etc/options). */
export const DEFAULT_PERSPECTIVE = 50

/**
 * The vscode_caret_perspective a server command line sets: the last `-o` for it wins,
 * as it does in Isabelle, and a negative value counts as 0 (the server takes `max 0`).
 * Both `-o NAME=V` and `-oNAME=V` are read.
 *
 * Taken from the arguments rather than the settings because three settings feed it --
 * serverOptions, checkWholeTheory and serverArgs, in that order -- and the arguments are
 * where their precedence is already decided. Isabelle preferences are not consulted:
 * this option is not in jEdit's dialog, so a value there would have been put in by hand.
 */
export function caretPerspective(args: readonly string[]): number {
  let value = DEFAULT_PERSPECTIVE
  for (let i = 0; i < args.length; i++) {
    const option = args[i] === '-o' ? args[++i] : args[i].startsWith('-o') ? args[i].slice(2) : undefined
    const m = option === undefined ? null
      : /^\s*vscode_caret_perspective\s*=\s*(-?\d+)\s*$/.exec(option)
    if (m) value = Math.max(0, Number(m[1]))
  }
  return value
}

/** How far the prover checks, as a phrase: "the whole theory", "down to 50 lines ...". */
export function checkingExtent(perspective: number): string {
  return perspective === 0
    ? 'the whole theory'
    : `down to ${perspective} line${perspective === 1 ? '' : 's'} below the cursor`
}

/** Stale files named in the tooltip before it defers to the full list. */
const STALE_SHOWN = 8

/**
 * Whether a node's failures are only the symptom of imports that are not loaded yet.
 *
 * Dependency resolution is asynchronous, so a theory opened before its imports have been
 * loaded has a *failing header* -- `imports Mid` cannot be resolved -- and PIDE reports
 * that as a failed command like any other. On a large project that window is long enough
 * to look like a real failure, which is what it was mistaken for.
 *
 * The two conditions together are what make this safe. `loading` is temporal, so a
 * genuinely broken import surfaces as soon as resolution settles rather than being hidden
 * forever; `initialized` is per node, so a proof that actually failed in a theory whose
 * header did go through is never suppressed.
 */
export function settling(node: NodeStatus, loading: boolean): boolean {
  return loading && !node.initialized && node.failed > 0
}

/**
 * Roll every theory the prover knows about into one count.
 *
 * `running` and `failed` are counted independently, since a theory can be both at once;
 * a settling node counts as running and never as failed, the same rule the Theories view
 * applies to its session rows.
 */
export function summarize(nodes: readonly NodeStatus[], loading: boolean): Progress {
  let done = 0, running = 0, failed = 0
  for (const n of nodes) {
    const s = settling(n, loading)
    if (n.percentage === 100) done++
    if (s || n.running > 0) running++
    if (!s && n.failed > 0) failed++
  }
  return { theories: nodes.length, done, running, failed, loading }
}

/**
 * Whether the prover is doing something right now.
 *
 * Deliberately not "some theory is below 100%": unless the whole theory is being checked,
 * PIDE stops vscode_caret_perspective lines below the cursor, so the rest stays
 * unprocessed indefinitely while the prover sits idle, and a spinner would say otherwise.
 */
export function busy(p: Progress): boolean {
  return p.running > 0 || p.loading
}

function progressParts(p: Progress): string[] {
  const parts: string[] = []
  if (p.done < p.theories) parts.push(`${p.done}/${p.theories}`)
  if (p.failed > 0) parts.push(`${p.failed} failed`)
  return parts
}

function runningLook(p: Progress | undefined): { icon: string; parts: string[] } {
  if (p === undefined || p.theories === 0) {
    return { icon: p !== undefined && p.loading ? 'sync~spin' : 'library', parts: [] }
  }
  const icon = busy(p) ? 'sync~spin' : p.failed > 0 ? 'error' : 'library'
  return { icon, parts: progressParts(p) }
}

/** Markdown-escape text that did not come from us, such as an error message. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, c => '\\' + c)
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? ''
  return line.length > 200 ? line.slice(0, 199) + '…' : line
}

function serverLine(input: StatusInput): string {
  switch (input.server) {
    case 'off': return 'not running'
    case 'starting': return 'starting'
    case 'building':
      return input.detail !== undefined
        ? `building the heap image -- ${escapeMarkdown(firstLine(input.detail))}`
        : 'building the heap image'
    case 'running':
      return input.prover !== undefined ? `running · prover ${escapeMarkdown(input.prover)}` : 'running'
    case 'failed':
      return input.detail !== undefined
        ? `stopped -- ${escapeMarkdown(firstLine(input.detail))}`
        : 'stopped'
  }
}

function theoriesLine(p: Progress): string {
  const parts = [`${p.done}/${p.theories} checked`]
  if (p.running > 0) parts.push(`${p.running} running`)
  if (p.failed > 0) parts.push(`${p.failed} failed`)
  if (p.loading) parts.push('resolving imports')
  return parts.join(' · ')
}

/** A command link with arguments. Parentheses would end the Markdown link early. */
export function commandLink(label: string, command: string, args: unknown[]): string {
  const query = encodeURIComponent(JSON.stringify(args))
    .replace(/\(/g, '%28').replace(/\)/g, '%29')
  return `[${label}](command:${command}?${query})`
}

function staleSection(stale: readonly StaleEntry[], logic: string, controls: boolean): string {
  const n = stale.length
  const lines = [
    `**Heap image out of date.** ${n === 1 ? 'A file' : `${n} files`} built into ` +
    `${escapeMarkdown(logic)} changed since the server started, so everything checked ` +
    `on top of ${n === 1 ? 'it' : 'them'} still sees the old text:`,
    '',
  ]
  for (const s of stale.slice(0, STALE_SHOWN)) {
    const note = s.change === 'modified' ? '' : ` (${s.change})`
    lines.push(`- ${commandLink(escapeMarkdown(s.label), 'isabelle.showStaleFiles', [s.file])}${note}`)
  }
  if (n > STALE_SHOWN) {
    lines.push(`- ${commandLink(`${n - STALE_SHOWN} more…`, 'isabelle.showStaleFiles', [])}`)
  }
  if (controls) {
    const unsaved = stale.some(s => s.change === 'unsaved')
    lines.push('',
      '[Rebuild: restart the server](command:isabelle.restartServer)' +
      (unsaved ? ' (it builds from the saved files)' : '') +
      ' · [Or change session](command:isabelle.selectSession)')
  }
  return lines.join('\n')
}

export function statusView(input: StatusInput): StatusView {
  let icon: string
  let parts: string[] = []
  switch (input.server) {
    case 'off': icon = 'debug-disconnect'; break
    case 'starting': icon = 'sync~spin'; break
    case 'building': icon = 'sync~spin'; parts = ['building']; break
    case 'failed': icon = 'error'; break
    case 'running': ({ icon, parts } = runningLook(input.progress)); break
  }
  // Only a running server has an image to be out of date against.
  const stale = input.server === 'running' ? input.stale ?? [] : []
  if (stale.length > 0) parts = [...parts, `${stale.length} stale`]
  const text = [statusText(input.logic, input.requirements, icon), ...parts].join(' · ')

  const facts = [`Server: ${serverLine(input)}`]
  // Progress only means something while the server that reported it is up.
  const progress = input.server === 'running' ? input.progress : undefined
  if (progress !== undefined) facts.push(`Theories: ${theoriesLine(progress)}`)
  // Checking is continuous either way; the setting only decides how far it goes.
  facts.push(`Checking: ${checkingExtent(input.perspective)}` +
    (input.nextPerspective !== undefined && input.nextPerspective !== input.perspective
      ? ` (${checkingExtent(input.nextPerspective)} after a restart)`
      : ''))

  const links = input.controls
    ? [
        '[Change session](command:isabelle.selectSession)',
        `[${input.server === 'off' ? 'Start' : 'Restart'} server](command:isabelle.restartServer)`,
        '[Show output](command:isabelle.showOutput)',
      ]
    : ['[Show output](command:isabelle.showOutput)']
  if (progress !== undefined) links.push('[Theories view](command:isabelle-theories.focus)')
  if (input.controls) {
    links.push(`[${input.wholeTheory ? 'Check near the cursor only' : 'Check the whole theory'}]` +
      '(command:isabelle.toggleWholeTheoryChecking)')
  }

  const tooltip = [
    `**Isabelle session: ${escapeMarkdown(input.logic)}**`,
    sessionSummary(escapeMarkdown(input.logic), input.requirements),
    ...(stale.length > 0 ? [staleSection(stale, input.logic, input.controls)] : []),
    // Two trailing spaces: a Markdown hard break, so the facts read as one block.
    facts.join('  \n'),
    links.join(' · '),
  ].join('\n\n')

  return {
    text,
    tooltip,
    /* A stale image gets the warning colour: unlike a failed proof, it is invisible
       everywhere else, and every result above those files is suspect until a rebuild. */
    background: input.server === 'failed' ? 'error' : stale.length > 0 ? 'warning' : undefined,
  }
}
