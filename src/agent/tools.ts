/*
 * The handlers of the Isabelle tools for AI agents (definitions in tool_defs.ts), on the
 * extended server's PIDE/agent_* requests and PIDE/check_theories.
 *
 * Whatever the transport, a tool takes JSON arguments and answers with plain text: the
 * agent reads it, so it is laid out for reading, with 1-based lines as in a file read, and
 * in Isabelle's ASCII notation as the theory file has it. Text the agent passes in (goals,
 * candidates, patterns) is encoded the same way, in case it holds Unicode glyphs.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import { LanguageClient, ParameterStructures, RequestType, State } from 'vscode-languageclient/node'
import { SymbolTable } from '../symbols'
import { goalStatement, proofsOf, unicodeLines } from './text'

export interface ToolResult {
  text: string
  isError?: boolean
}

export type ToolHandler = (args: Record<string, unknown>, token?: vscode.CancellationToken)
  => Promise<ToolResult>

interface TheoryStatus { uri: string; status: 'pending' | 'checked' | 'failed'; percentage: number }

interface ReportMessage {
  severity: 'error' | 'warning' | 'legacy'
  line: number
  character: number
  end_line: number
  end_character: number
  message: string
  goal?: string
}

interface Report {
  error?: string
  outdated?: boolean
  percentage?: number
  consolidated?: boolean
  /** Whether the theory's end was reached: a theory without one is checked all the same. */
  finalized?: boolean
  ok?: boolean
  failed_commands?: number
  unprocessed_commands?: number
  sorry?: number
  oops?: number
  messages?: ReportMessage[]
}

interface Level { line: number; command: string; source: string; goals: string }

interface StateReply {
  error?: string
  outdated?: boolean
  line?: number
  command?: string
  source?: string
  status?: 'failed' | 'running' | 'finished' | 'unprocessed'
  goals?: string
  current?: Level
  outer?: Level[]
  messages?: string
}

interface Candidate {
  text: string
  outcome: 'proved' | 'goals_left' | 'no_subgoals' | 'error' | 'timeout' | 'output' | 'ok'
  time_ms: string
  state: string
  output: string
  traced: string
  more_steps: string
  stats: { rule: string; applied: number; condition_failed: number }[]
  cycle: string[]
  steps: Record<string, string>[]
}

interface TryReply {
  error?: string
  state?: string
  proof?: string
  candidates?: Candidate[]
}

interface SledgehammerReply { error?: string; messages?: string[] }

/* By name: a request given an undefined token would otherwise go out with its parameters
   in an array, which the server does not read. */
const byName = <P, R>(method: string) =>
  new RequestType<P, R, void>(method, ParameterStructures.byName)
const CheckTheories = byName<object, { theories: TheoryStatus[] }>('PIDE/check_theories')
const AgentReport = byName<object, Report>('PIDE/agent_report')
const AgentState = byName<object, StateReply>('PIDE/agent_state')
const AgentTry = byName<object, TryReply>('PIDE/agent_try')
const AgentSledgehammer = byName<object, SledgehammerReply>('PIDE/agent_sledgehammer')

const POLL_MS = 300
const MAX_TEXT = 30000
const START_WAIT_MS = 90000

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

class ToolError extends Error {}

/** Whether the running server answers PIDE/agent_*: it says so among its capabilities. */
export function supportsAgent(client: LanguageClient | undefined): boolean {
  const experimental = client?.initializeResult?.capabilities.experimental as
    { isabelleAgent?: number } | undefined
  return !!client && client.state === State.Running && !!experimental?.isabelleAgent
}

function str(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name]
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

function num(args: Record<string, unknown>, name: string): number | undefined {
  const v = args[name]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function strings(args: Record<string, unknown>, name: string): string[] {
  const v = args[name]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function truncate(text: string): string {
  return text.length <= MAX_TEXT ? text : text.slice(0, MAX_TEXT) + '\n[... truncated]'
}

function indent(text: string, by = '    '): string {
  return text.split('\n').map(l => by + l).join('\n')
}

export class AgentTools {
  constructor(
    private readonly getClient: () => LanguageClient | undefined,
    private readonly getTable: () => SymbolTable | undefined,
    /** Starts the server if nobody has yet: it otherwise waits for a theory to be opened. */
    private readonly startServer: () => Promise<void>,
  ) {}

  readonly handlers: Record<string, ToolHandler> = {
    isabelle_check: (a, t) => this.run(() => this.check(a, t), t),
    isabelle_state: (a, t) => this.run(() => this.state(a, t), t),
    isabelle_try: (a, t) => this.run(() => this.tryCandidates(a, t), t),
    isabelle_sledgehammer: (a, t) => this.run(() => this.sledgehammer(a, t), t),
    isabelle_find_theorems: (a, t) => this.run(() => this.findTheorems(a, t), t),
  }

  /** Answers at once when the call is cancelled: a request to the server may not stop. */
  private async run(f: () => Promise<string>, token?: vscode.CancellationToken)
      : Promise<ToolResult> {
    const cancelled: ToolResult = { text: 'Cancelled.', isError: true }
    if (token?.isCancellationRequested) return cancelled
    let off: vscode.Disposable | undefined
    const onCancel = new Promise<ToolResult>(resolve => {
      off = token?.onCancellationRequested(() => resolve(cancelled))
    })
    const work = f().then(text => ({ text: truncate(text) }), (err): ToolResult =>
      ({ text: err instanceof Error ? err.message : String(err), isError: true }))
    try { return await Promise.race([work, onCancel]) }
    finally { off?.dispose() }
  }

  private async client(token?: vscode.CancellationToken): Promise<LanguageClient> {
    if (!this.getClient()) {
      void this.startServer().catch(() => { /* reported in the window */ })
    }
    const deadline = Date.now() + START_WAIT_MS
    let client = this.getClient()
    while ((!client || client.state !== State.Running) && Date.now() < deadline &&
        !token?.isCancellationRequested) {
      await sleep(500)
      client = this.getClient()
    }
    if (!client || client.state !== State.Running) {
      throw new ToolError('The Isabelle language server is not running yet in the VS Code ' +
        'window: it may be building the session image, which can take minutes the first ' +
        'time. Try again later; the status bar of the window shows the progress.')
    }
    if (!supportsAgent(client)) {
      throw new ToolError('This needs the extended Isabelle server, version with agent tools ' +
        '(setting isabelle.extendedServer, then reload the window).')
    }
    return client
  }

  private encode(text: string): string {
    return this.getTable()?.encode(text) ?? text
  }

  /** The theory file: absolute, or relative to one of the workspace folders. */
  private resolve(args: Record<string, unknown>): vscode.Uri {
    const name = str(args, 'file')
    if (!name) throw new ToolError('No file given.')
    const candidates = path.isAbsolute(name) ? [name]
      : (vscode.workspace.workspaceFolders ?? []).map(f => path.join(f.uri.fsPath, name))
    const found = candidates.find(p => fs.existsSync(p))
    if (!found) throw new ToolError(`No such file: ${name}`)
    if (!found.endsWith('.thy')) throw new ToolError(`Not a theory file: ${name}`)
    return vscode.Uri.file(found)
  }

  private asUri(client: LanguageClient, uri: vscode.Uri): string {
    return client.code2ProtocolConverter.asUri(uri)
  }

  private text(uri: vscode.Uri): string {
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString())
    return open ? open.getText() : fs.readFileSync(uri.fsPath, 'utf8')
  }

  /** 0-based position of a 1-based line and optional column; the first non-blank by default. */
  private position(uri: vscode.Uri, args: Record<string, unknown>, lineDefault?: 'end')
      : { line: number; character: number } {
    const lines = this.text(uri).split(/\r?\n/)
    let line = num(args, 'line')
    if (line === undefined) {
      if (lineDefault !== 'end') throw new ToolError('No line given.')
      let last = lines.length
      while (last > 1 && lines[last - 1].trim() === '') last--
      line = last
    }
    const l = Math.max(1, Math.min(Math.floor(line), lines.length)) - 1
    const column = num(args, 'column')
    const character = column !== undefined
      ? Math.max(0, Math.floor(column) - 1)
      : Math.max(0, lines[l].search(/\S/))
    return { line: l, character }
  }

  /** Loads the theory as required, if it is not yet, and polls how far the prover is. */
  private async status(client: LanguageClient, uri: vscode.Uri): Promise<TheoryStatus> {
    const { theories } = await client.sendRequest(CheckTheories, { files: [this.asUri(client, uri)] })
    return theories[0] ?? { uri: '', status: 'failed', percentage: 0 }
  }

  /** Until the server knows the theory: a theory nobody had opened is read first. */
  private async load(client: LanguageClient, uri: vscode.Uri, token?: vscode.CancellationToken)
      : Promise<void> {
    const deadline = Date.now() + 30000
    for (;;) {
      await this.status(client, uri)
      const report = await client.sendRequest(AgentReport, { uri: this.asUri(client, uri) })
      if (!report.error) return
      if (Date.now() > deadline || token?.isCancellationRequested) throw new ToolError(report.error)
      await sleep(POLL_MS)
    }
  }

  /* isabelle_check */

  private async check(args: Record<string, unknown>, token?: vscode.CancellationToken)
      : Promise<string> {
    const client = await this.client(token)
    const uri = this.resolve(args)
    const timeout = (num(args, 'timeout_s') ?? 300) * 1000
    const start = Date.now()
    let status = await this.status(client, uri)
    while (status.status === 'pending' && Date.now() - start < timeout &&
        !token?.isCancellationRequested) {
      await sleep(POLL_MS)
      status = await this.status(client, uri)
    }
    let report = await client.sendRequest(AgentReport, { uri: this.asUri(client, uri) })
    for (let i = 0; i < 20 && report.outdated; i++) {
      await sleep(POLL_MS)
      report = await client.sendRequest(AgentReport, { uri: this.asUri(client, uri) })
    }
    if (report.error) throw new ToolError(report.error)
    return this.formatReport(uri, status, report, Date.now() - start)
  }

  private formatReport(uri: vscode.Uri, status: TheoryStatus, r: Report, ms: number): string {
    const messages = r.messages ?? []
    const errors = messages.filter(m => m.severity === 'error')
    const warnings = messages.filter(m => m.severity !== 'error')
    const name = path.basename(uri.fsPath)
    const state =
      status.status === 'pending' ? `still being checked (${status.percentage}%) when the timeout passed` :
      status.status === 'failed' || errors.length ? 'checked, with errors' : 'checked'
    const counts = [
      `${errors.length} error${errors.length === 1 ? '' : 's'}`,
      `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
      `${r.sorry ?? 0} sorry`,
      ...(r.oops ? [`${r.oops} oops`] : []),
    ].join(', ')
    const out = [`${name}: ${state} in ${(ms / 1000).toFixed(1)} s: ${counts}.`]
    if (status.status === 'pending') {
      out.push('Messages so far are below; call isabelle_check again to wait longer.')
    } else if (r.finalized === false) {
      out.push('The theory has no end: its commands are checked, but isabelle build rejects it ' +
        'as it stands.')
    }
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString())
    if (open?.isDirty) {
      out.push('The file has unsaved changes in the editor: the prover checks the text in the editor, ' +
        'not the file on disk, and edits to the file are not seen until the user saves.')
    }
    for (const m of [...errors, ...warnings]) {
      const range = m.line === m.end_line
        ? `${m.line + 1}:${m.character + 1}-${m.end_character + 1}`
        : `${m.line + 1}:${m.character + 1}-${m.end_line + 1}:${m.end_character + 1}`
      out.push('', `${m.severity} at line ${range}:`, indent(m.message))
      if (m.goal) out.push('  goal before this command:', indent(m.goal))
    }
    const unicode = unicodeLines(this.text(uri), this.getTable())
    if (unicode.length) {
      out.push('', 'Literal Unicode in the file (isabelle build rejects it in terms):',
        ...unicode.slice(0, 20).map(u => indent(u, '  ')))
    }
    return out.join('\n')
  }

  /* isabelle_state */

  private async state(args: Record<string, unknown>, token?: vscode.CancellationToken)
      : Promise<string> {
    const client = await this.client(token)
    const uri = this.resolve(args)
    const position = this.position(uri, args)
    await this.load(client, uri, token)
    const deadline = Date.now() + 120000
    let reply: StateReply
    for (;;) {
      reply = await client.sendRequest(AgentState, {
        textDocument: { uri: this.asUri(client, uri) }, position })
      if (reply.error) throw new ToolError(reply.error)
      const done = !reply.outdated && (reply.status === 'finished' || reply.status === 'failed')
      if (done || Date.now() > deadline || token?.isCancellationRequested) break
      await sleep(POLL_MS)
    }
    const out = [`line ${(reply.line ?? 0) + 1}: ${reply.source ?? ''}  [${reply.status}]`]
    if (reply.status === 'unprocessed' || reply.status === 'running') {
      out.push('(the prover has not finished this command yet)')
    }
    if (reply.goals) out.push('', reply.goals)
    else if (reply.current) {
      out.push('', `goals (left by line ${reply.current.line + 1}: ${reply.current.source}):`,
        reply.current.goals)
    }
    for (const level of reply.outer ?? []) {
      out.push('', `enclosing goal, of line ${level.line + 1}: ${level.source}`, level.goals)
    }
    if (reply.messages) out.push('', 'messages:', indent(reply.messages))
    return out.join('\n')
  }

  /* isabelle_try */

  private async requestTry(
    client: LanguageClient,
    uri: vscode.Uri,
    position: { line: number; character: number },
    params: {
      goal: string; candidates: string[]; timeout_ms: number; stats?: boolean
      watch_rules?: string[]; watch_patterns?: string[]; watch_limit?: number
    },
    token?: vscode.CancellationToken,
  ): Promise<TryReply> {
    await this.load(client, uri, token)
    const deadline_ms = 240000 + params.timeout_ms * 2 * Math.ceil(params.candidates.length / 4)
    const reply = await client.sendRequest(AgentTry, {
      textDocument: { uri: this.asUri(client, uri) }, position, ...params, deadline_ms,
    }, token)
    if (reply.error) throw new ToolError(reply.error)
    return reply
  }

  private async tryCandidates(args: Record<string, unknown>, token?: vscode.CancellationToken)
      : Promise<string> {
    const client = await this.client(token)
    const uri = this.resolve(args)
    const candidates = strings(args, 'candidates').map(c => this.encode(c)).filter(c => c.trim())
    if (!candidates.length) throw new ToolError('No candidates given.')
    if (candidates.length > 12) throw new ToolError('At most 12 candidates at once.')
    const reply = await this.requestTry(client, uri, this.position(uri, args), {
      goal: goalStatement(this.encode(str(args, 'goal') ?? '')),
      candidates,
      timeout_ms: Math.round((num(args, 'timeout_s') ?? 10) * 1000),
      stats: args.simp_stats === true,
      watch_rules: strings(args, 'watch_rules'),
      watch_patterns: strings(args, 'watch_patterns').map(p => this.encode(p)),
      watch_limit: num(args, 'watch_limit') ?? 20,
    }, token)
    return this.formatTry(reply,
      strings(args, 'watch_rules').length + strings(args, 'watch_patterns').length > 0)
  }

  private formatTry(reply: TryReply, watching = false): string {
    const out: string[] = []
    if (reply.state) out.push('goal tried:', indent(reply.state), '')
    for (const c of reply.candidates ?? []) {
      out.push(`${c.outcome.toUpperCase()} (${c.time_ms} ms): ${c.text}`)
      if (c.state) out.push(indent(c.state))
      if (c.output && c.outcome !== 'proved') out.push(indent(c.output))
      if (c.stats.length) {
        out.push(c.traced === 'rerun'
          ? '    rewrite rules applied most (from a traced rerun of up to 5 s):'
          : '    rewrite rules applied most:')
        for (const s of c.stats) {
          out.push(`      ${s.rule} x${s.applied}` +
            (s.condition_failed ? ` (condition failed ${s.condition_failed}x)` : ''))
        }
      }
      if (c.cycle.length) out.push(`    the run ends in the cycle: ${c.cycle.join(' -> ')}`)
      if (c.steps.length) {
        out.push('    watched steps:')
        for (const s of c.steps) {
          out.push(`      ${s.rule} [${s.outcome}]`, indent(s.instance, '        '))
          if (s.premises) out.push('        premises as simp saw them:', indent(s.premises, '          '))
          if (s.inner) out.push(`        rules applied within them: ${s.inner}`)
        }
        if (c.more_steps !== '0') out.push(`      ... and ${c.more_steps} more`)
      } else if (watching && c.traced) {
        out.push('    no watched rule was applied (it never matched)')
      }
      out.push('')
    }
    return out.join('\n').trimEnd()
  }

  /* isabelle_sledgehammer */

  private async sledgehammer(args: Record<string, unknown>, token?: vscode.CancellationToken)
      : Promise<string> {
    const client = await this.client(token)
    const uri = this.resolve(args)
    const position = this.position(uri, args)
    const goal = goalStatement(this.encode(str(args, 'goal') ?? ''))
    const timeout_s = Math.round(num(args, 'timeout_s') ?? 30)
    await this.load(client, uri, token)
    const reply = await client.sendRequest(AgentSledgehammer, {
      textDocument: { uri: this.asUri(client, uri) }, position, goal, timeout_s,
      deadline_ms: 240000 + timeout_s * 3000,
    }, token)
    if (reply.error) throw new ToolError(reply.error)
    const messages = reply.messages ?? []
    const proofs = [...new Set(messages.flatMap(proofsOf))]
    if (!proofs.length) {
      return ['Sledgehammer found no proof.', ...messages.map(m => indent(m))].join('\n')
    }
    const replay = await this.requestTry(client, uri, position,
      { goal, candidates: proofs.slice(0, 12), timeout_ms: 10000 }, token)
    const good = (replay.candidates ?? []).filter(c => c.outcome === 'proved')
    const out = good.length
      ? ['Proofs that Sledgehammer found and that check:', ...good.map(c => `  ${c.text}  (${c.time_ms} ms)`)]
      : ['Sledgehammer found proofs, but none of them checks when replayed:']
    const bad = (replay.candidates ?? []).filter(c => c.outcome !== 'proved')
    if (bad.length) {
      out.push('', 'Found but not checking:', ...bad.map(c => `  ${c.text}  [${c.outcome}]`))
    }
    return out.join('\n')
  }

  /* isabelle_find_theorems */

  private async findTheorems(args: Record<string, unknown>, token?: vscode.CancellationToken)
      : Promise<string> {
    const client = await this.client(token)
    const uri = this.resolve(args)
    const query = str(args, 'query')
    if (!query) throw new ToolError('No query given.')
    const limit = Math.max(1, Math.round(num(args, 'limit') ?? 40))
    const position = this.position(uri, args, 'end')
    const reply = await this.requestTry(client, uri, position,
      { goal: '', candidates: [`find_theorems (${limit}) ${this.encode(query)}`], timeout_ms: 30000 },
      token)
    const c = reply.candidates?.[0]
    if (!c) throw new ToolError('No answer.')
    if (c.outcome === 'error' || c.outcome === 'timeout') {
      throw new ToolError(`find_theorems failed (${c.outcome}): ${c.state}`)
    }
    return c.output || 'Nothing found.'
  }
}
