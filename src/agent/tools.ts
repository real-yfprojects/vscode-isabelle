/*
 * The handlers of the Isabelle tools for AI agents (definitions in tool_defs.ts), on the
 * extended server's PIDE/agent_* requests and PIDE/check_theories.
 *
 * Whatever the transport, a tool takes JSON arguments and answers with plain text: the
 * agent reads it, so it is laid out for reading, with 1-based lines as in a file read, and
 * in Isabelle's ASCII notation as the theory file has it. Text the agent passes in (goals,
 * candidates, patterns) is encoded the same way, in case it holds Unicode glyphs.
 */
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import { LanguageClient, ParameterStructures, RequestType, State } from 'vscode-languageclient/node'
import { isFalsification } from '../sledgehammer_text'
import { SymbolTable } from '../symbols'
import { formatProfile, ProfileCommand } from './profile'
import { goalStatement, proofsOf, unicodeLines } from './text'

export interface ToolResult {
  text: string
  isError?: boolean
}

/** What a tool tells while it runs, which the client shows with the running call: a short
    line, and how far it is in percent when it knows. */
export type Progress = (message: string, percentage?: number) => void

export type ToolHandler = (args: Record<string, unknown>, token?: vscode.CancellationToken,
  progress?: Progress) => Promise<ToolResult>

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

/** A command by where it is: 0-based line, name and first line of its text. */
interface Place { line: number; command: string; source: string }

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
  /** Where the prover is in a theory not yet done (servers that know it): the commands it
      runs, at most five of them, and how many run; those that wait for their turn, and
      the first of them. Counted without blanks and comments. */
  running?: Place[]
  running_commands?: number
  waiting_commands?: number
  first_waiting?: Place
  sorry?: number
  oops?: number
  /** Each sorry and oops (up to 20), with the goals before it where known. */
  skipped?: (Place & { goal?: string })[]
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
  outcome: 'proved' | 'proved_with_sorry' | 'goals_left' | 'no_subgoals' | 'error' |
    'timeout' | 'output' | 'ok'
  time_ms: string
  state: string
  output: string
  traced: string
  more_steps: string
  stats: { rule: string; applied: number; condition_failed: number }[]
  cycle: string[]
  steps: Record<string, string>[]
  /** The goals each sorry of an outline skips, the text before it, and the handle of the state
      at it with its goals stated on their own (statement_1, ... or error_1, ...); handle and
      prefix are absent from an older server. */
  holes?: ({ line: string; goals: string; prefix?: string; handle?: string; using?: string;
    mode?: string } & Record<string, string | undefined>)[]
  /** The slowest steps of a candidate of several, slowest first. */
  slow_steps?: { line: string; command: string; source: string; time_ms: string }[]
  /** The handle of the state the candidate reached, to go on from. */
  handle?: string
  /** For goals left: each stated on its own at the root of the chain. */
  statements?: { statement?: string; error?: string }[]
  /** The facts the chain added, as `using ...`, for a proof of a statement tried here. */
  using?: string
  /** "prove" where a proof goes on by `apply`, "state" in an Isar proof body, "theory" after a
      closed proof, where there is no goal. */
  mode?: string
}

/** A proof that checks but takes this long is reported as slow. */
const SLOW_PROOF_MS = 1000

interface TryReply {
  error?: string
  state?: string
  /** "true" when the call started in a proof: an own goal is stated with `have` there. */
  proof?: string
  /** The handle of the state with the agent's own goal stated. */
  goal_handle?: string
  /** How the goal was stated: "have ", "proof - have " in an apply proof, or "lemma ". */
  goal_keyword?: string
  /** With `from`: the mode of the handle's state ("theory": no goal there). */
  from_mode?: string
  candidates?: Candidate[]
}

/** What the extension keeps of a handle the prover made: where its chain of calls started,
    and the steps since, which the prover does not keep. */
interface HandleInfo {
  uri: vscode.Uri
  /** The 1-based line the first call of the chain named. */
  line: number
  /** The text above that line then, hashed: once it differs, the state is from before an edit. */
  above: string
  script: string
}

/** As many as the prover keeps (max_handles in vscode_agent.ML). */
const MAX_HANDLES = 256

const NO_HANDLE = (id: string) => `There is no handle ${id} (any more): handles last until ` +
  `${MAX_HANDLES} newer ones are made, or the prover restarts. Start again from a line.`

interface SledgehammerReply { error?: string; messages?: string[] }

interface ContextReply {
  error?: string
  goal?: string
  definitions?: string
  facts?: string
  relevant?: { name: string; statement: string }[]
  relevant_error?: string
}

/* By name: a request given an undefined token would otherwise go out with its parameters
   in an array, which the server does not read. */
const byName = <P, R>(method: string) =>
  new RequestType<P, R, void>(method, ParameterStructures.byName)
const CheckTheories = byName<object, { theories: TheoryStatus[] }>('PIDE/check_theories')
const AgentReport = byName<object, Report>('PIDE/agent_report')
const AgentState = byName<object, StateReply>('PIDE/agent_state')
const AgentTry = byName<object, TryReply>('PIDE/agent_try')
const AgentSledgehammer = byName<object, SledgehammerReply>('PIDE/agent_sledgehammer')
const AgentContext = byName<object, ContextReply>('PIDE/agent_context')
const AgentProfile = byName<object, { error?: string; outdated?: boolean; commands?: ProfileCommand[] }>(
  'PIDE/agent_profile')

const POLL_MS = 300
const MAX_TEXT = 30000
const START_WAIT_MS = 90000
/** How long a theory may stand still, a command failed and none running, before a check
    gives up waiting for it. */
const STALL_MS = 6000
/** How long the same commands may run, and nothing else move, before a check stops waiting
    for them: Isabelle gives a proof method no time limit, so a metis that does not end runs
    until the command is edited. */
const STUCK_MS = 30000
/** How long isabelle_state waits for a command that runs, for its own goals. */
const RUNNING_WAIT_MS = 10000

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** What a check that did not wait tells the agent to do next. */
const AGAIN = 'Call isabelle_check again: with wait false for how far it is by then, or ' +
  'without it to wait for the result.'

/** Whether the prover has stopped before the end of a theory without finishing it: a
    command failed, none runs, and others wait, as when an import cannot be found. Such a
    theory stays at its percentage for good, and no timeout would end the wait. */
function goesNoFurther(r: Report): boolean {
  return !r.error && !r.outdated && (r.failed_commands ?? 0) > 0 &&
    r.running_commands === 0 && (r.waiting_commands ?? 0) > 0
}

/** Whether the theory has failed but the error that says why is not in the report yet.
    A bad theory header fails the theory at once: the server finds the error parsing the
    header, before the prover has run anything, and the error's text is the prover's,
    reported when it gets to the header. Likewise a command's failure (its status) and its
    error (a result) reach the server separately. On the macOS runner a check of a theory
    with a bad name answered within 0.3 s, in between. */
function errorToCome(r: Report, status: TheoryStatus): boolean {
  return !r.error && !r.outdated &&
    (status.status === 'failed' || (r.failed_commands ?? 0) > 0) &&
    !(r.messages ?? []).some(m => m.severity === 'error')
}

/** How long a check waits for the error of a failed theory to reach the report. */
const ERROR_WAIT_MS = 10000

/** The commands a theory runs, as one string to compare with the next look: empty when
    none runs, or the report cannot tell. */
function runningKey(r: Report): string {
  if (r.error || r.outdated || !r.running?.length) return ''
  return JSON.stringify([r.running_commands, r.running.map(p => [p.line, p.source])])
}

class ToolError extends Error {}

/** The version of PIDE/agent_* the server answers, as it says among its capabilities: 2 adds
    handles, outlines, isabelle_context and isabelle_profile. */
function agentVersion(client: LanguageClient | undefined): number {
  const experimental = client?.initializeResult?.capabilities.experimental as
    { isabelleAgent?: number } | undefined
  return experimental?.isabelleAgent ?? 0
}

/** Whether the running server answers PIDE/agent_*. */
export function supportsAgent(client: LanguageClient | undefined): boolean {
  return !!client && client.state === State.Running && agentVersion(client) > 0
}

const NEWER_SERVER = 'This needs a newer extended Isabelle server than the one running: ' +
  'reload the window after updating the extension.'

function needsVersion(client: LanguageClient, version: number): void {
  if (agentVersion(client) < version) throw new ToolError(NEWER_SERVER)
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

/** The first line of a text, cut to `max` characters. */
function shorten(text: string, max: number): string {
  const line = text.split('\n')[0].trim()
  return line.length <= max ? line : line.slice(0, max - 1) + '…'
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

  private readonly handles = new Map<string, HandleInfo>()

  private remember(id: string, info: HandleInfo): void {
    this.handles.set(id, info)
    while (this.handles.size > MAX_HANDLES) {
      this.handles.delete(this.handles.keys().next().value as string)
    }
  }

  /** Where a query runs: with a handle (`from`), at the line its chain started at, on the
      handle's state; else at the `path` and `line` given. */
  private locate(client: LanguageClient, args: Record<string, unknown>) {
    const from = str(args, 'from')?.trim()
    const origin = from ? this.handles.get(from) : undefined
    if (from) {
      needsVersion(client, 2)
      if (!origin) throw new ToolError(NO_HANDLE(from))
    }
    const uri = origin?.uri ?? this.resolve(args)
    const position = this.position(uri, origin ? { line: origin.line } : args)
    return { from, origin, uri, position }
  }

  /** The note for a handle whose theory changed above its chain since. */
  private staleNote(from: string | undefined, origin: HandleInfo | undefined): string[] {
    if (!origin || this.above(origin.uri, origin.line) === origin.above) return []
    return [`The theory changed above line ${origin.line} since ${from}'s chain started there: ` +
      'its state is from before that edit. Start again from a line if the edit matters.', '']
  }

  /** The text above a 1-based line, hashed. */
  private above(uri: vscode.Uri, line: number): string {
    const lines = this.text(uri).split(/\r?\n/).slice(0, line - 1)
    return createHash('sha1').update(lines.join('\n')).digest('hex')
  }

  readonly handlers: Record<string, ToolHandler> = {
    isabelle_check: (a, t, p) => this.run(() => this.check(a, t, p), t),
    isabelle_state: (a, t, p) => this.run(() => this.state(a, t, p), t),
    isabelle_try: (a, t, p) => this.run(() => this.tryCandidates(a, t, p), t),
    isabelle_sledgehammer: (a, t, p) => this.run(() => this.sledgehammer(a, t, p), t),
    isabelle_find_theorems: (a, t, p) => this.run(() => this.findTheorems(a, t, p), t),
    isabelle_context: (a, t, p) => this.run(() => this.context(a, t, p), t),
    isabelle_profile: (a, t, p) => this.run(() => this.profile(a, t, p), t),
  }

  /** `work`, while `what` is reported with the seconds it has taken, every second: for a
      single request to the server, which tells nothing until it answers. */
  private async ticking<T>(progress: Progress | undefined, what: string, work: () => Promise<T>)
      : Promise<T> {
    if (!progress) return work()
    const start = Date.now()
    const tick = () => {
      const s = Math.round((Date.now() - start) / 1000)
      progress(s ? `${what} (${s} s)` : what)
    }
    tick()
    const timer = setInterval(tick, 1000)
    try { return await work() } finally { clearInterval(timer) }
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

  private async client(token?: vscode.CancellationToken, progress?: Progress)
      : Promise<LanguageClient> {
    if (!this.getClient()) {
      void this.startServer().catch(() => { /* reported in the window */ })
    }
    const deadline = Date.now() + START_WAIT_MS
    let client = this.getClient()
    while ((!client || client.state !== State.Running) && Date.now() < deadline &&
        !token?.isCancellationRequested) {
      progress?.('waiting for the Isabelle server to start')
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

  /** The theory file: absolute, or relative to one of the workspace folders. `file` is what
      the argument was called before, which a client may still have from its tool list. */
  private resolve(args: Record<string, unknown>): vscode.Uri {
    const name = str(args, 'path') ?? str(args, 'file')
    if (!name) throw new ToolError('No path given.')
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

  private async check(args: Record<string, unknown>, token?: vscode.CancellationToken,
      progress?: Progress): Promise<string> {
    const client = await this.client(token, progress)
    const uri = this.resolve(args)
    /* `wait: false` asks how far the prover is, and answers at once: the agent goes on with
       something else and asks again, or has the client move the call to the background. */
    const wait = args.wait !== false
    const timeout = wait ? (num(args, 'timeout_s') ?? 120) * 1000 : 0
    const start = Date.now()
    let status = await this.status(client, uri)
    let stalled = false
    /* Since when the same commands run and the percentage stands still, once that has gone
       on for STUCK_MS: the check answers then, and names them. */
    let stuck: number | undefined
    let percentage = status.percentage
    let moved = Date.now()
    let probed = 0
    let running: string | undefined
    let runningSince = 0
    const tell = this.checkProgress(client, uri, wait ? progress : undefined)
    while (status.status === 'pending' && Date.now() - start < timeout &&
        !token?.isCancellationRequested) {
      await tell(status)
      await sleep(POLL_MS)
      status = await this.status(client, uri)
      if (status.percentage !== percentage) {
        percentage = status.percentage
        moved = Date.now()
        running = undefined
      } else if (Date.now() - moved >= STALL_MS && Date.now() - probed >= 2000) {
        probed = Date.now()
        const r = await client.sendRequest(AgentReport, { uri: this.asUri(client, uri) })
        if (goesNoFurther(r)) { stalled = true; break }
        const now = runningKey(r)
        if (now !== running) { running = now; runningSince = probed }
        else if (now && probed - runningSince >= STUCK_MS) { stuck = runningSince; break }
      }
    }
    let report = await client.sendRequest(AgentReport, { uri: this.asUri(client, uri) })
    for (let i = 0; i < 20 && report.outdated; i++) {
      await sleep(POLL_MS)
      report = await client.sendRequest(AgentReport, { uri: this.asUri(client, uri) })
    }
    const errorBy = Date.now() + ERROR_WAIT_MS
    while (Date.now() < errorBy && (report.outdated || errorToCome(report, status)) &&
        !token?.isCancellationRequested) {
      await sleep(POLL_MS)
      report = await client.sendRequest(AgentReport, { uri: this.asUri(client, uri) })
    }
    if (report.error) {
      /* Right after the theory was asked for, the prover may not have it yet. */
      if (!wait && status.status === 'pending') {
        return `${path.basename(uri.fsPath)}: being checked (${status.percentage}% done); the ` +
          'prover has not reached its commands yet. ' + AGAIN
      }
      throw new ToolError(report.error)
    }
    return this.formatReport(uri, status, report, Date.now() - start, wait, stalled,
      stuck === undefined ? undefined : Date.now() - stuck)
  }

  /** Reports how far a check is, with the command the prover runs, looked up now and then:
      the report that tells it carries the theory's messages too. */
  private checkProgress(client: LanguageClient, uri: vscode.Uri, progress?: Progress)
      : (status: TheoryStatus) => Promise<void> {
    if (!progress) return async () => {}
    const name = path.basename(uri.fsPath)
    let looked = 0
    let at = ''
    return async status => {
      if (Date.now() - looked >= 1500) {
        looked = Date.now()
        const r = await client.sendRequest(AgentReport, { uri: this.asUri(client, uri) })
        const p = r.error || r.outdated ? undefined : r.running?.[0]
        at = p ? `, running line ${p.line + 1}: ${shorten(p.source, 50)}` : ''
      }
      progress(`checking ${name}${at}`, status.percentage)
    }
  }

  /** Where the prover is in a theory that is not done: what it runs, and what waits. */
  private formatProgress(r: Report, wait: boolean, stuck: boolean): string[] {
    if (!r.running) return []   // a server that does not tell
    const at = (p: Place) => `line ${p.line + 1}: ${p.source}`
    const out: string[] = []
    const waiting = r.waiting_commands ?? 0
    if (r.running.length) {
      out.push('Running now:', ...r.running.map(p => '  ' + at(p)))
      const more = (r.running_commands ?? 0) - r.running.length
      if (more > 0) out.push(`  ... and ${more} more`)
    } else if (waiting > 0) {
      out.push('No command is running at the moment.')
    }
    if (waiting > 0) {
      out.push(`Waiting for the prover: ${waiting} command${waiting === 1 ? '' : 's'} (not ` +
        'started, or their proofs still being checked)' +
        (r.first_waiting ? `, the first at ${at(r.first_waiting)}` : '') + '.')
    }
    if (!r.running.length && waiting === 0) {
      /* Node_Status counts a theory as 99% done until it is consolidated. */
      out.push('Every command is processed; the theory is not consolidated yet, which the ' +
        'prover does after its last command.')
    } else if (!r.running.length && (r.failed_commands ?? 0) > 0) {
      out.push('A command has failed and none runs: if this is the same on the next call, the ' +
        'prover goes no further with this theory, as when an import cannot be found.')
    }
    if (wait && !stuck && r.running.length) {
      out.push('If the same command is still running when you ask again, it is slow or stuck, ' +
        'as a simplifier loop or a heavy automatic method is. isabelle_try on its goal, with a ' +
        'timeout, shows the rule cycle of a loop; editing the command makes the prover drop ' +
        'its run.')
    }
    return out
  }

  private formatReport(uri: vscode.Uri, status: TheoryStatus, r: Report, ms: number,
      wait: boolean, stalled: boolean, stuckMs?: number): string {
    const messages = r.messages ?? []
    const errors = messages.filter(m => m.severity === 'error')
    const warnings = messages.filter(m => m.severity !== 'error')
    const name = path.basename(uri.fsPath)
    const pending = status.status === 'pending' && !stalled
    /* Commands that never ran, because the theory's start failed -- a name that is not the
       file's, an import that cannot be found -- and the prover goes no further. */
    const unrun = r.waiting_commands ?? 0
    const notRun = !pending && status.status !== 'checked' && unrun > 0 &&
      (r.running_commands ?? 0) === 0
    const state =
      notRun ? 'not checked' :
      pending && stuckMs !== undefined ?
        `no progress for ${Math.round(stuckMs / 1000)} s (${status.percentage}% done)` :
      pending && wait ? `still being checked (${status.percentage}%) when the timeout passed` :
      pending ? `being checked (${status.percentage}% done)` :
      status.status === 'failed' || errors.length ? 'checked, with errors' : 'checked'
    const counts = [
      `${errors.length} error${errors.length === 1 ? '' : 's'}`,
      `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
      `${r.sorry ?? 0} sorry`,
      ...(r.oops ? [`${r.oops} oops`] : []),
    ].join(', ')
    const took = pending && !wait ? '' : ` in ${(ms / 1000).toFixed(1)} s`
    const out = [`${name}: ${state}${took}: ${counts}.`]
    if (notRun) {
      const first = r.first_waiting
      out.push(`The prover did not run the theory: ${unrun} command${unrun === 1 ? '' : 's'} ` +
        'never started' + (first ? `, the first at line ${first.line + 1}: ${first.source}` : '') +
        ', because a command at its start failed. The errors below say why, usually a theory ' +
        'name that is not the file\'s, or an import that cannot be found.')
    } else if (pending && stuckMs !== undefined) {
      out.push('The commands below have run all that time and nothing else has moved: they ' +
        'are probably stuck, as a simplifier loop or a metis, auto or smt that does not end ' +
        'is. Isabelle gives a proof method no time limit, so the prover goes on until the ' +
        'command is edited: replace it, or put sorry there for now, and the prover drops its ' +
        'run. isabelle_try on its goal, with a timeout, tells whether it ends. If it is only ' +
        'slow, call isabelle_check again to wait longer. Messages so far are below.')
      out.push(...this.formatProgress(r, wait, true))
    } else if (pending) {
      out.push(wait ? 'Messages so far are below; call isabelle_check again to wait longer.'
        : 'Messages so far are below. ' + AGAIN)
      out.push(...this.formatProgress(r, wait, false))
    } else if (r.finalized === false) {
      out.push('The theory has no end: its commands are checked, but isabelle build rejects it ' +
        'as it stands.')
    }
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString())
    if (open?.isDirty) {
      out.push('The file has unsaved changes in the editor: the prover checks the text in the editor, ' +
        'not the file on disk, and edits to the file are not seen until the user saves.')
    }
    const skipped = r.skipped ?? []
    if (skipped.length) {
      out.push('', 'Proofs left out, with the goals each skips:')
      for (const p of skipped) {
        out.push(`  line ${p.line + 1}: ${p.source}`)
        if (p.goal) out.push(indent(p.goal, '      '))
      }
      const more = (r.sorry ?? 0) + (r.oops ?? 0) - skipped.length
      if (more > 0) out.push(`  ... and ${more} more`)
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

  private async state(args: Record<string, unknown>, token?: vscode.CancellationToken,
      progress?: Progress): Promise<string> {
    const client = await this.client(token, progress)
    const uri = this.resolve(args)
    const position = this.position(uri, args)
    await this.load(client, uri, token)
    /* A command the prover has not reached is waited for; one that runs only for a while,
       since it may never end: then what it has is the answer. */
    const deadline = Date.now() + 120000
    let runningSince: number | undefined
    let reply: StateReply
    for (;;) {
      reply = await client.sendRequest(AgentState, {
        textDocument: { uri: this.asUri(client, uri) }, position })
      if (reply.error) throw new ToolError(reply.error)
      const done = !reply.outdated && (reply.status === 'finished' || reply.status === 'failed')
      if (reply.status === 'running') runningSince ??= Date.now()
      const ranLong = runningSince !== undefined && Date.now() - runningSince >= RUNNING_WAIT_MS
      if (done || ranLong || Date.now() > deadline || token?.isCancellationRequested) break
      progress?.(`waiting for line ${(reply.line ?? position.line) + 1}: ` +
        (reply.status === 'running' ? 'the prover runs it' : 'the prover has not reached it'))
      await sleep(POLL_MS)
    }
    const out = [`line ${(reply.line ?? 0) + 1}: ${reply.source ?? ''}  [${reply.status}]`]
    if (reply.status === 'running') {
      out.push('(the prover is still running this command; if isabelle_check names it as ' +
        'running on the next call too, it is slow or stuck)')
    } else if (reply.status === 'unprocessed') {
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
      from?: string; goal: string; candidates: string[]; timeout_ms: number; stats?: boolean
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

  private async tryCandidates(args: Record<string, unknown>, token?: vscode.CancellationToken,
      progress?: Progress): Promise<string> {
    const client = await this.client(token, progress)
    const { from, origin, uri, position } = this.locate(client, args)
    const line = position.line + 1
    const candidates = strings(args, 'candidates').map(c => this.encode(c)).filter(c => c.trim())
    if (!candidates.length) throw new ToolError('No candidates given.')
    if (candidates.length > 12) throw new ToolError('At most 12 candidates at once.')
    const timeout_ms = Math.round((num(args, 'timeout_s') ?? 10) * 1000)
    const where = from ? `from ${from}` : `at line ${line}`
    const what = candidates.length === 1
      ? `trying ${shorten(candidates[0], 40)} ${where}`
      : `trying ${candidates.length} candidates ${where}, ${timeout_ms / 1000} s each`
    const goal = goalStatement(this.encode(str(args, 'goal') ?? ''))
    const reply = await this.ticking(progress, what, () => this.requestTry(client, uri, position, {
      from: from ?? '',
      goal,
      candidates,
      timeout_ms,
      stats: args.simp_stats === true,
      watch_rules: strings(args, 'watch_rules'),
      watch_patterns: strings(args, 'watch_patterns').map(p => this.encode(p)),
      watch_limit: num(args, 'watch_limit') ?? 20,
    }, token))

    /* The steps since the first call, which the prover does not keep: the handle's, then the
       own goal, then the candidate. */
    const chain = {
      uri, line: origin?.line ?? line,
      above: origin?.above ?? this.above(uri, line),
    }
    const join = (before: string | undefined, step: string) => before ? `${before}\n${step}` : step
    let prefix = origin?.script
    if (reply.goal_handle) {
      prefix = join(prefix, `${reply.goal_keyword ?? (reply.proof ? 'have ' : 'lemma ')}${goal}`)
      this.remember(reply.goal_handle, { ...chain, script: prefix })
    }
    for (const c of reply.candidates ?? []) {
      if (c.handle) this.remember(c.handle, { ...chain, script: join(prefix, c.text) })
      // A hole's steps: the outline up to its sorry, which a proof from it replaces.
      for (const h of c.holes ?? []) {
        if (h.handle) this.remember(h.handle, { ...chain, script: h.prefix ? join(prefix, h.prefix) : prefix ?? '' })
      }
    }
    const out = this.staleNote(from, origin)
    if (from && reply.from_mode === 'theory' && !goal) {
      out.push(`${from} is the theory after a closed proof: there is no goal to go on with. ` +
        'State one there with `goal`, or go on from the handle of a hole or of goals left.', '')
    }
    out.push(this.formatTry(reply,
      strings(args, 'watch_rules').length + strings(args, 'watch_patterns').length > 0,
      { line: chain.line, prefix }))
    return out.join('\n')
  }

  /** `chain`: the line the chain of calls started at, and its steps before these candidates. */
  private formatTry(reply: TryReply, watching = false,
      chain?: { line: number; prefix?: string }): string {
    const out: string[] = []
    if (reply.goal_handle) out.push(`own goal stated: handle ${reply.goal_handle}`)
    if (reply.state) out.push('goal tried:', indent(reply.state), '')
    const candidates = reply.candidates ?? []
    for (const c of candidates) {
      const holes = c.holes ?? []
      const label = c.outcome === 'proved_with_sorry'
        ? `PROVED WITH ${holes.length} SORRY, an outline and not yet a proof`
        : c.outcome.toUpperCase()
      const slow = c.outcome === 'proved' && Number(c.time_ms) >= SLOW_PROOF_MS
        ? ', slow: prefer a faster proof' : ''
      out.push(`${label} (${c.time_ms} ms${slow}): ${c.text}`)
      if (c.state) out.push(indent(c.state))
      if (c.handle && chain?.prefix) {
        out.push(`    the steps so far, from line ${chain.line}:`,
          indent(`${chain.prefix}\n${c.text}`, '      '))
      }
      const statements = c.statements ?? []
      if (statements.length) {
        out.push(`    each goal left, stated on its own -- for isabelle_sledgehammer or ` +
          `isabelle_try with it as \`goal\` at line ${chain?.line ?? '?'}:`)
        statements.forEach((s, i) => out.push(s.statement !== undefined
          ? indent(`${i + 1}. ${s.statement}`, '      ')
          : `      ${i + 1}. (not given: ${s.error})`))
        const using = c.using ? `${c.using} ` : ''
        out.push(c.mode === 'state'
          ? `    a proof \`by M\` found that way goes on from ${c.handle} as: show ?thesis ${using}by M`
          : `    a proof \`by M\` of goal 1 found that way goes on from ${c.handle} as: ${using}apply M` +
            (statements.length > 1 ? ' (for goal i, put `prefer i` first)' : ''))
      }
      const multiline = c.text.includes('\n')
      holes.forEach((h, i) => {
        out.push(`    hole ${i + 1}` + (multiline ? `, the sorry at line ${h.line} of the candidate` : '') +
          ', goals:', indent(h.goals, '      '))
        const stated = Object.keys(h).map(k => /^(statement|error)_(\d+)$/.exec(k))
          .filter((m): m is RegExpExecArray => m !== null)
          .sort((a, b) => Number(a[2]) - Number(b[2]))
        if (stated.length) {
          out.push(`      stated on its own, with what the outline assumed there -- for ` +
            `isabelle_sledgehammer or isabelle_try with it as \`goal\` at line ${chain?.line ?? '?'}:`)
          stated.forEach(m => out.push(m[1] === 'statement'
            ? indent(`${m[2]}. ${h[m[0]]}`, '        ')
            : `        ${m[2]}. (not given: ${h[m[0]]})`))
        }
        if (h.handle) {
          const using = h.using ? `${h.using} ` : ''
          out.push(`      a proof \`by M\` of it goes in place of the sorry as: ${using}by M`,
            `      handle ${h.handle}: try proofs for this hole with from: "${h.handle}"`)
        }
      })
      const steps = c.slow_steps ?? []
      if (steps.length) {
        out.push('    slowest steps:',
          ...steps.map(s => `      ${s.time_ms} ms` + (multiline ? `, line ${s.line}` : '') + `: ${s.source}`))
      }
      if (c.output && c.outcome !== 'proved' && c.outcome !== 'proved_with_sorry') {
        out.push(indent(c.output))
      }
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
      if (c.handle) {
        out.push(c.mode === 'theory'
          ? `    handle ${c.handle}: the theory after this closed proof, with no goal; state more ` +
            `there with goal and from: "${c.handle}"` + (holes.length ? ' (for the holes, use their handles above)' : '')
          : `    handle ${c.handle}: go on from this state with from: "${c.handle}"`)
      }
      out.push('')
    }
    const proved = candidates.filter(c => c.outcome === 'proved')
    if (proved.length > 1) {
      /* Only where it is clearly faster: a few ms either way is noise (an agent saw 38 ms
         against 46, and 24 ms for the same proof on the next call). */
      const ms = (c: Candidate) => Number(c.time_ms)
      const fastest = proved.reduce((a, b) => ms(b) < ms(a) ? b : a)
      const slowest = Math.max(...proved.map(ms))
      out.push(slowest - ms(fastest) >= 50 && slowest >= 1.5 * ms(fastest)
        ? `Fastest proof: ${fastest.text} (${fastest.time_ms} ms)`
        : `The ${proved.length} proofs take about as long (${ms(fastest)}-${slowest} ms); ` +
          'times this short vary from call to call, so pick by what reads best.')
    }
    return out.join('\n').trimEnd()
  }

  /* isabelle_context */

  private async context(args: Record<string, unknown>, token?: vscode.CancellationToken,
      progress?: Progress): Promise<string> {
    const client = await this.client(token, progress)
    needsVersion(client, 2)
    const { from, origin, uri, position } = this.locate(client, args)
    await this.load(client, uri, token)
    const relevant = args.relevant !== false
    const limit = Math.max(1, Math.round(num(args, 'limit') ?? 20))
    const reply = await this.ticking(progress,
      `looking up the context ${from ? `of ${from}` : `at line ${position.line + 1}`}`,
      () => client.sendRequest(AgentContext, {
        textDocument: { uri: this.asUri(client, uri) }, position,
        from: from ?? '',
        goal: goalStatement(this.encode(str(args, 'goal') ?? '')),
        relevant,
        // Some over: the same statement under several names is shown once (below).
        limit: limit + 10,
        deadline_ms: 240000,
      }, token))
    if (reply.error) throw new ToolError(reply.error)
    const out = this.staleNote(from, origin)
    out.push(reply.goal ? `goal:\n${indent(reply.goal)}` : 'There is no goal here.')
    out.push('', 'definitions of the constants in the goal, by the fact to unfold or simp them with:',
      indent(reply.definitions || '(none with a specification)'))
    out.push('', 'variables and facts of the proof:', indent(reply.facts || '(none)'))
    if (relevant) {
      out.push('', 'facts most relevant to the first goal, by Sledgehammer\'s relevance filter (MePo), best first:')
      /* HOL states some facts several times under other names (append.right_neutral, and
         cvc_rewrites_fold(1), (4), (10) for the SMT reconstruction): the first, best ranked. */
      const seen = new Set<string>()
      const facts = (reply.relevant ?? []).filter(f => {
        // Up to the names of its variables: ?xs @ [] = ?xs is ?a @ [] = ?a.
        const names = new Map<string, string>()
        const key = f.statement.replace(/\s+/g, ' ').trim()
          .replace(/\?[A-Za-z][\w']*(\.\d+)?/g, v => {
            if (!names.has(v)) names.set(v, `?${names.size}`)
            return names.get(v) as string
          })
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }).slice(0, limit)
      if (facts.length) {
        for (const f of facts) out.push(`    ${f.name}:`, indent(f.statement, '      '))
      } else {
        out.push(`    (${reply.relevant_error ?? 'none'})`)
      }
    }
    return out.join('\n')
  }

  /* isabelle_profile */

  private async profile(args: Record<string, unknown>, token?: vscode.CancellationToken,
      progress?: Progress): Promise<string> {
    const client = await this.client(token, progress)
    needsVersion(client, 2)
    const uri = this.resolve(args)
    const timeout = (num(args, 'timeout_s') ?? 120) * 1000
    const start = Date.now()
    let status = await this.status(client, uri)
    const tell = this.checkProgress(client, uri, progress)
    while (status.status === 'pending' && Date.now() - start < timeout &&
        !token?.isCancellationRequested) {
      await tell(status)
      await sleep(POLL_MS)
      status = await this.status(client, uri)
    }
    let reply = await client.sendRequest(AgentProfile, { uri: this.asUri(client, uri) })
    for (let i = 0; i < 20 && reply.outdated; i++) {
      await sleep(POLL_MS)
      reply = await client.sendRequest(AgentProfile, { uri: this.asUri(client, uri) })
    }
    if (reply.error) throw new ToolError(reply.error)
    const by = str(args, 'by') === 'command' ? 'command' : 'lemma'
    const kinds = str(args, 'kinds') === 'all' ? 'all' : 'proofs'
    return formatProfile(reply.commands ?? [], {
      by, kinds,
      match: strings(args, 'match').map(m => this.encode(m)),
      exclude: strings(args, 'exclude').map(m => this.encode(m)),
      fromLine: num(args, 'from_line'),
      toLine: num(args, 'to_line'),
      limit: Math.max(1, Math.round(num(args, 'limit') ?? 10)),
      minS: num(args, 'min_s') ?? 0.1,
    }, {
      name: path.basename(uri.fsPath),
      pending: status.status === 'pending',
      percentage: status.percentage,
    })
  }

  /* isabelle_sledgehammer */

  private async sledgehammer(args: Record<string, unknown>, token?: vscode.CancellationToken,
      progress?: Progress): Promise<string> {
    const client = await this.client(token, progress)
    const uri = this.resolve(args)
    const position = this.position(uri, args)
    const goal = goalStatement(this.encode(str(args, 'goal') ?? ''))
    const timeout_s = Math.round(num(args, 'timeout_s') ?? 30)
    await this.load(client, uri, token)
    /* A job of the extended server, which goes on while the theory is edited; the server
       does not stop a request on $/cancelRequest, so a cancelled call cancels its job. */
    const job_id = `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const off = token?.onCancellationRequested(() =>
      void client.sendNotification('PIDE/sledgehammer_job_cancel', { id: job_id }))
    let reply: SledgehammerReply
    try {
      reply = await this.ticking(progress,
        `Sledgehammer at line ${position.line + 1}, timeout ${timeout_s} s`,
        () => client.sendRequest(AgentSledgehammer, {
          textDocument: { uri: this.asUri(client, uri) }, position, goal, timeout_s, job_id,
          deadline_ms: 240000 + timeout_s * 3000,
        }, token))
    } finally { off?.dispose() }
    if (reply.error) throw new ToolError(reply.error)
    const messages = reply.messages ?? []
    const proofs = [...new Set(messages.flatMap(proofsOf))]
    if (!proofs.length) {
      const falsified = messages.filter(m => isFalsification(m))
      if (falsified.length) {
        return ['Sledgehammer falsified the goal: it contradicts known facts, so it is ' +
          'probably false as stated. Fix the statement rather than hammering it again.',
          ...messages.map(m => indent(m))].join('\n')
      }
      return ['Sledgehammer found no proof.', ...messages.map(m => indent(m))].join('\n')
    }
    const replayed = proofs.slice(0, 12)
    const replay = await this.ticking(progress,
      `checking the ${replayed.length} proof${replayed.length === 1 ? '' : 's'} Sledgehammer found`,
      () => this.requestTry(client, uri, position,
        { goal, candidates: replayed, timeout_ms: 10000 }, token))
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

  private async findTheorems(args: Record<string, unknown>, token?: vscode.CancellationToken,
      progress?: Progress): Promise<string> {
    const client = await this.client(token, progress)
    const uri = this.resolve(args)
    const query = str(args, 'query')
    if (!query) throw new ToolError('No query given.')
    const limit = Math.max(1, Math.round(num(args, 'limit') ?? 40))
    const position = this.position(uri, args, 'end')
    const reply = await this.ticking(progress,
      `searching the facts at line ${position.line + 1} of ${path.basename(uri.fsPath)}`,
      () => this.requestTry(client, uri, position,
        { goal: '', candidates: [`find_theorems (${limit}) ${this.encode(query)}`], timeout_ms: 30000 },
        token))
    const c = reply.candidates?.[0]
    if (!c) throw new ToolError('No answer.')
    if (c.outcome === 'error' || c.outcome === 'timeout') {
      throw new ToolError(`find_theorems failed (${c.outcome}): ${c.state}`)
    }
    return c.output || 'Nothing found.'
  }
}
