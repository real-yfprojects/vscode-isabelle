/* The parts of Sledgehammer jobs (sledgehammer_jobs.ts) that need no editor: where a job's
 * place is after an edit, the `sorry`s of a text, the parameters of a run, and the edit that
 * puts a proof in. No vscode import, so that plain node can test them (suite67).
 */

import { scanWords } from './theory_lexer'

/** A `sorry` to replace, or the command at the caret, whose state the panel shows. */
export type JobKind = 'sorry' | 'command'

/** What a run asks of Sledgehammer: the panel's controls, defaulted from the settings. */
export interface HammerOptions {
  provers: string
  timeout: number
  isar: 'false' | 'smart' | 'true'
  try0: boolean
  stopAtFirst: boolean
  falsify: boolean
  abduce: boolean
  induction: boolean
  subgoal: number
  facts: string
}

/**
 * Where an anchor is after one change of the text. A change before it moves it, text
 * typed right before or after it included; one that overlaps it `touches` it, and the
 * anchor then spans what is left of it and the new text.
 */
export function shiftAnchor(
  anchor: { start: number; end: number },
  change: { offset: number; length: number; text: number },
): { start: number; end: number; touched: boolean } {
  const { start, end } = anchor
  const changeEnd = change.offset + change.length
  const delta = change.text - change.length
  if (changeEnd <= start) return { start: start + delta, end: end + delta, touched: false }
  if (change.offset >= end) return { start, end, touched: false }
  return {
    start: Math.min(start, change.offset),
    end: Math.max(change.offset + change.text, end + delta),
    touched: true,
  }
}

/** The `sorry`s of a text, within [from, to) if given. */
export function findSorries(text: string, from = 0, to = text.length)
    : { offset: number; length: number }[] {
  return scanWords(text)
    .filter(w => w.word === 'sorry' && w.offset >= from && w.offset < to)
    .map(w => ({ offset: w.offset, length: w.word.length }))
}

/** The Sledgehammer parameters of a run, as name, value, name, value. */
export function serverParams(options: HammerOptions, cacheDir?: string): string[] {
  const out: [string, string][] = []
  if (options.provers.trim()) out.push(['provers', options.provers.trim()])
  out.push(['timeout', String(Math.max(1, Math.round(options.timeout)))])
  out.push(['isar_proofs', options.isar])
  out.push(['try0', String(options.try0)])
  if (options.stopAtFirst) out.push(['max_proofs', '1'])
  if (options.falsify) out.push(['falsify', 'smart'])
  if (options.abduce) out.push(['abduce', 'smart'])
  if (options.induction) out.push(['induction_rules', 'instantiate'])
  if (cacheDir) out.push(['cache_dir', cacheDir])
  return out.flat()
}

/** Whether a message reports a falsification: the goal contradicts the facts. */
export function isFalsification(xml: string): boolean {
  const text = xml.replace(/<[^>]*>/g, '')
  return /falsified by|found a falsification|goal is inconsistent|Derived "False"/.test(text)
}

/**
 * The edit that puts a proof in for a job: in place of its `sorry`, or else after its
 * command -- in place of a `sorry` or `oops` that follows, or on a line of its own,
 * indented as the command is. Lines after the first of a multi-line (Isar) proof get the
 * indentation of the place it goes.
 */
export function proofEdit(text: string, job: { kind: JobKind; start: number; end: number },
    proof: string): { start: number; end: number; text: string } {
  const lineStart = (offset: number) => text.lastIndexOf('\n', offset - 1) + 1
  const indentAt = (offset: number) => /^[ \t]*/.exec(text.slice(lineStart(offset)))![0]
  const indented = (indent: string) => proof.split('\n').join('\n' + indent)
  if (job.kind === 'sorry') {
    return { start: job.start, end: job.end, text: indented(indentAt(job.start)) }
  }
  const after = /^\s*/.exec(text.slice(job.end))![0]
  const next = /^(sorry|oops)(?![A-Za-z0-9_'])/.exec(text.slice(job.end + after.length))
  if (next) {
    const at = job.end + after.length
    return { start: at, end: at + next[0].length, text: indented(indentAt(at)) }
  }
  const indent = indentAt(job.start)
  return { start: job.end, end: job.end, text: '\n' + indent + indented(indent) }
}
