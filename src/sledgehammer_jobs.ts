/* Sledgehammer jobs: runs that go on while the theory is edited, several at a time.
 *
 * The panel's classic run is a query on one command, so an edit of that command ends it --
 * and typing the next step does edit it: a word that is not yet a keyword (the `h` of
 * `have`) joins the span of the command before. A job, on the extended server, only takes
 * the proof state from its command and runs on in a group of its own
 * (vscode_sledgehammer.ML), so it survives that, and others run beside it.
 *
 *   PIDE/sledgehammer_job_start {id, textDocument, position, at_command, ...}
 *   PIDE/sledgehammer_job_update {id, status, message?, proofs?, outcome?, error?, range?}
 *   PIDE/sledgehammer_job_cancel {id}
 *
 * The server forgets where a job came from; this module follows each job's place through
 * the edits (its anchor), shows what it found there as CodeLenses and quick fixes, and puts
 * a proof in on request: in place of the `sorry` it was started on, or after its command.
 */

import * as vscode from 'vscode'
import { LanguageClient, State } from 'vscode-languageclient/node'
import { enclosing, outlineFor } from './outline'
import { findSorries, HammerOptions, isFalsification, JobKind, proofEdit, serverParams, shiftAnchor }
  from './sledgehammer_text'

export { HammerOptions } from './sledgehammer_text'

export type JobStatus = 'queued' | 'starting' | 'running' | 'finished' | 'cancelled' | 'error'

export interface Job {
  id: string
  uri: string
  kind: JobKind
  /** The anchor, as offsets into the document, moved along by every edit. */
  start: number
  end: number
  label: string
  status: JobStatus
  /** Sledgehammer's messages, as XML (with `<sendback>` proofs). */
  messages: string[]
  /** The proofs among them, as they go into the file. */
  proofs: string[]
  falsified: boolean
  outcome?: string
  error?: string
  /** Dismissed: still followed, so that automatic runs leave its `sorry` alone. */
  hidden: boolean
  startedAt: number
  endedAt?: number
}

const ACTIVE: ReadonlySet<JobStatus> = new Set(['queued', 'starting', 'running'])
export const isActive = (job: Job) => ACTIVE.has(job.status)

/* ---------- the jobs of a client ---------- */

interface Update {
  id: string
  status: JobStatus
  message?: string
  proofs?: string[]
  outcome?: string
  error?: string
  range?: { start: { line: number; character: number }; end: { line: number; character: number } }
}

/** Whether the running server knows the PIDE/sledgehammer_job_* messages. */
export function supportsJobs(client: LanguageClient | undefined): boolean {
  const experimental = client?.initializeResult?.capabilities.experimental as
    { isabelleSledgehammerJobs?: number } | undefined
  return !!client && client.state === State.Running && !!experimental?.isabelleSledgehammerJobs
}

/** The settings' defaults, which the panel's controls then override for this window. */
export function defaultOptions(): HammerOptions {
  const cfg = vscode.workspace.getConfiguration('isabelle.sledgehammer')
  return {
    provers: '',
    timeout: cfg.get<number>('timeout', 30),
    isar: 'smart',
    try0: true,
    stopAtFirst: cfg.get<boolean>('stopAtFirstProof', true),
    falsify: cfg.get<boolean>('falsify', true),
    abduce: false,
    induction: false,
    subgoal: 1,
    facts: '',
  }
}

let nextId = 0
const newId = () => `job-${Date.now().toString(36)}-${(nextId++).toString(36)}`

export class SledgehammerJobs implements vscode.CodeLensProvider, vscode.CodeActionProvider {
  readonly jobs = new Map<string, Job>()
  options: HammerOptions = defaultOptions()

  private readonly changed = new vscode.EventEmitter<void>()
  /** Fires when a job is added, changes or goes. */
  readonly onDidChange = this.changed.event
  readonly onDidChangeCodeLenses = this.changed.event

  private autoTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly client: LanguageClient,
    private readonly log: (m: string) => void,
    /** Unicode glyphs back to the `\<name>` of the file, for text from the panel. */
    private readonly encode: (text: string) => string,
    /** The directory of Sledgehammer's prover cache, made on demand; none if it is off. */
    private readonly cacheDir: () => string | undefined,
  ) {}

  register(disposables: vscode.Disposable[], selector: vscode.DocumentSelector): void {
    disposables.push(
      this.changed,
      { dispose: () => { if (this.autoTimer) clearTimeout(this.autoTimer) } },
      this.client.onNotification('PIDE/sledgehammer_job_update', (u: Update) => this.onUpdate(u)),
      vscode.workspace.onDidChangeTextDocument(e => this.onEdit(e)),
      vscode.workspace.onDidCloseTextDocument(doc => this.onClose(doc)),
      vscode.window.onDidChangeTextEditorVisibleRanges(() => this.scheduleAuto()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleAuto()),
      vscode.languages.registerCodeLensProvider(selector, this),
      vscode.languages.registerCodeActionsProvider(selector, this,
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
      vscode.commands.registerCommand('isabelle.sledgehammerSorries', (uri?: string, line?: number) =>
        this.runSorries(vscode.window.activeTextEditor,
          uri !== undefined && line !== undefined ? { uri, line } : undefined)),
      vscode.commands.registerCommand('isabelle.sledgehammerSorry', (uri: string, offset: number) => {
        const doc = this.document(uri)
        return doc && this.startSorry(doc, offset)
      }),
      vscode.commands.registerCommand('isabelle.sledgehammerApply',
        (id: string, proof: string) => this.apply(id, proof)),
      vscode.commands.registerCommand('isabelle.sledgehammerCancelJob', (id: string) => this.cancel(id)),
      vscode.commands.registerCommand('isabelle.sledgehammerRetry', (id: string) => this.retry(id)),
      vscode.commands.registerCommand('isabelle.sledgehammerDismiss', (id: string) => this.dismiss(id)),
    )
    this.scheduleAuto()
  }

  /* ---------- starting ---------- */

  /**
   * A job at the caret: on a `sorry`, one that replaces it; elsewhere one on the command
   * there, on the state the infoview shows for it.
   */
  async runAtCursor(editor = vscode.window.activeTextEditor): Promise<Job | undefined> {
    if (!editor) return undefined
    const doc = editor.document
    const caret = doc.offsetAt(editor.selection.active)
    const lineStart = doc.offsetAt(new vscode.Position(editor.selection.active.line, 0))
    const lineEnd = doc.offsetAt(doc.lineAt(editor.selection.active.line).range.end)
    const sorry = findSorries(doc.getText(), lineStart, lineEnd)
      .find(s => s.offset <= caret + 1 && caret <= s.offset + s.length + 1) ??
      (doc.lineAt(editor.selection.active.line).text.trim() === 'sorry'
        ? findSorries(doc.getText(), lineStart, lineEnd)[0] : undefined)
    if (sorry) return this.start(doc, 'sorry', sorry.offset, sorry.offset + sorry.length)
    return this.start(doc, 'command', caret, caret)
  }

  /**
   * One job for each `sorry` of the selection, or else of the lemma around the caret --
   * or around `line` of the document at `uri`, as the light bulb asks. A `sorry` that has a
   * run going, or a proof waiting, is left alone.
   */
  async runSorries(editor = vscode.window.activeTextEditor, at?: { uri: string; line: number })
      : Promise<Job[]> {
    const doc = at ? this.document(at.uri) : editor?.document
    if (!doc) return []
    const selection = at ? undefined : editor?.selection
    const [from, to] = selection && !selection.isEmpty
      ? [doc.offsetAt(selection.start), doc.offsetAt(selection.end)]
      : lemmaRange(doc, at?.line ?? selection?.active.line ?? 0)
    const sorries = this.sorriesOf(doc).filter(s => s.offset >= from && s.offset < to &&
      this.wantsRun(doc.uri.toString(), s.offset))
    if (sorries.length === 0) {
      void vscode.window.showInformationMessage('No sorry to hammer ' +
        (selection && !selection.isEmpty ? 'in the selection.' : 'in this lemma.'))
      return []
    }
    return sorries.map(s => this.startSorry(doc, s.offset))
  }

  /** A job on the `sorry` at an offset, in place of any earlier one there. */
  startSorry(doc: vscode.TextDocument, offset: number): Job {
    const uri = doc.uri.toString()
    for (const job of [...this.jobs.values()]) {
      if (job.uri === uri && job.kind === 'sorry' && job.start === offset) this.drop(job)
    }
    return this.start(doc, 'sorry', offset, offset + 'sorry'.length)
  }

  /** Whether a `sorry` has neither a run going nor a proof waiting. */
  private wantsRun(uri: string, offset: number): boolean {
    return ![...this.jobs.values()].some(j =>
      j.uri === uri && j.kind === 'sorry' && j.start === offset &&
      (isActive(j) || (!j.hidden && j.proofs.length > 0)))
  }

  /* The light bulb asks at every move of the caret: the scan, once per version. */
  private sorryCache = new Map<string, { version: number; sorries: { offset: number; length: number }[] }>()

  private sorriesOf(doc: vscode.TextDocument): { offset: number; length: number }[] {
    const key = doc.uri.toString()
    const hit = this.sorryCache.get(key)
    if (hit && hit.version === doc.version) return hit.sorries
    const sorries = findSorries(doc.getText())
    this.sorryCache.set(key, { version: doc.version, sorries })
    return sorries
  }

  private start(doc: vscode.TextDocument, kind: JobKind, start: number, end: number,
      options = this.options): Job {
    const pos = doc.positionAt(start)
    const job: Job = {
      id: newId(),
      uri: doc.uri.toString(),
      kind, start, end,
      label: labelOf(doc, kind, pos.line),
      status: 'queued',
      messages: [],
      proofs: [],
      falsified: false,
      hidden: false,
      startedAt: Date.now(),
    }
    this.jobs.set(job.id, job)
    const cfg = vscode.workspace.getConfiguration('isabelle.sledgehammer')
    void this.client.sendNotification('PIDE/sledgehammer_job_start', {
      id: job.id,
      textDocument: { uri: this.client.code2ProtocolConverter.asUri(doc.uri) },
      position: { line: pos.line, character: pos.character },
      at_command: kind === 'command',
      goal: '',
      subgoal: Math.max(1, Math.round(options.subgoal)),
      facts: options.facts.trim(),
      params: serverParams(options, this.cacheDir()),
      stop_at_first: options.stopAtFirst,
      max_parallel: Math.max(1, cfg.get<number>('maxParallel', 2)),
    })
    this.log(`sledgehammer job ${job.id}: ${kind} at ${doc.uri.fsPath}:${pos.line + 1}`)
    this.changed.fire()
    return job
  }

  /* ---------- from the server ---------- */

  private onUpdate(u: Update): void {
    const job = this.jobs.get(u.id)
    if (!job || !isActive(job)) return
    if (u.message) {
      job.messages.push(u.message)
      if (isFalsification(u.message)) job.falsified = true
    }
    for (const p of u.proofs ?? []) if (!job.proofs.includes(p)) job.proofs.push(p)
    if (u.range && job.kind === 'command') {
      const doc = this.document(job.uri)
      if (doc) {
        job.start = doc.offsetAt(new vscode.Position(u.range.start.line, u.range.start.character))
        job.end = doc.offsetAt(new vscode.Position(u.range.end.line, u.range.end.character))
        job.label = labelOf(doc, 'command', doc.positionAt(job.start).line)
      }
    }
    if (u.outcome) job.outcome = u.outcome
    if (u.error) job.error = u.error
    job.status = u.status
    if (!isActive(job)) job.endedAt = Date.now()
    this.changed.fire()
  }

  /* ---------- following the text ---------- */

  private onEdit(e: vscode.TextDocumentChangeEvent): void {
    if (e.contentChanges.length === 0) return
    const uri = e.document.uri.toString()
    const jobs = [...this.jobs.values()].filter(j => j.uri === uri)
    if (jobs.length === 0) return
    let changed = false
    for (const job of jobs) {
      let touched = false
      for (const c of e.contentChanges) {
        const r = shiftAnchor(job, { offset: c.rangeOffset, length: c.rangeLength, text: c.text.length })
        if (r.start !== job.start || r.end !== job.end) changed = true
        job.start = r.start
        job.end = r.end
        touched ||= r.touched
      }
      /* A `sorry` replaced or deleted, by hand or by a proof put in: nothing left to do. */
      if (job.kind === 'sorry' && touched &&
          e.document.getText(new vscode.Range(e.document.positionAt(job.start),
            e.document.positionAt(job.end))) !== 'sorry') {
        this.drop(job)
        changed = true
      }
    }
    if (changed) this.changed.fire()
    this.scheduleAuto()
  }

  private onClose(doc: vscode.TextDocument): void {
    const uri = doc.uri.toString()
    for (const job of [...this.jobs.values()]) if (job.uri === uri) this.drop(job)
    this.sorryCache.delete(uri)
    this.changed.fire()
  }

  private document(uri: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(d => d.uri.toString() === uri)
  }

  /** A job on the `sorry` at an offset; with `any`, also a dismissed or finished one. */
  private jobAt(uri: string, offset: number, any = false): Job | undefined {
    return [...this.jobs.values()].find(j =>
      j.uri === uri && j.kind === 'sorry' && j.start === offset &&
      (any || (!j.hidden && j.status !== 'cancelled')))
  }

  /* ---------- automatic runs on the sorrys in view ---------- */

  private scheduleAuto(): void {
    if (!vscode.workspace.getConfiguration('isabelle.sledgehammer').get<boolean>('autoSorry', false)) {
      return
    }
    if (this.autoTimer) clearTimeout(this.autoTimer)
    this.autoTimer = setTimeout(() => { this.autoTimer = undefined; this.runAuto() }, 1500)
  }

  /** A job for each `sorry` in view that has had none; a few at a time, as typing settles. */
  private runAuto(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const doc = editor.document
      if (doc.languageId !== 'isabelle') continue
      const text = doc.getText()
      for (const range of editor.visibleRanges) {
        const from = doc.offsetAt(range.start)
        const to = doc.offsetAt(range.end)
        for (const s of findSorries(text, from, to).slice(0, 10)) {
          if (!this.jobAt(doc.uri.toString(), s.offset, true)) {
            this.start(doc, 'sorry', s.offset, s.offset + s.length)
          }
        }
      }
    }
  }

  /* ---------- acting on a job ---------- */

  cancel(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    if (isActive(job)) {
      void this.client.sendNotification('PIDE/sledgehammer_job_cancel', { id })
      job.status = 'cancelled'
      job.endedAt = Date.now()
    }
    this.changed.fire()
  }

  cancelAll(): void {
    for (const job of this.jobs.values()) if (isActive(job)) this.cancel(job.id)
  }

  /** Out of sight, but its `sorry` keeps it, so that automatic runs pass it by. */
  dismiss(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    if (isActive(job)) this.cancel(id)
    job.hidden = true
    this.changed.fire()
  }

  clearFinished(): void {
    for (const job of this.jobs.values()) if (!isActive(job)) job.hidden = true
    this.changed.fire()
  }

  retry(id: string): Job | undefined {
    const job = this.jobs.get(id)
    const doc = job && this.document(job.uri)
    if (!job || !doc) return undefined
    this.drop(job)
    return this.start(doc, job.kind, job.start, job.end)
  }

  private drop(job: Job): void {
    if (isActive(job)) void this.client.sendNotification('PIDE/sledgehammer_job_cancel', { id: job.id })
    this.jobs.delete(job.id)
  }

  /** Puts a proof in for a job; `proof` may be glyphs, as the panel shows it. */
  async apply(id: string, proof: string): Promise<boolean> {
    const job = this.jobs.get(id)
    if (!job) return false
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(job.uri))
    const edit = proofEdit(doc.getText(), job, this.encode(proof))
    const range = new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end))
    const we = new vscode.WorkspaceEdit()
    we.replace(doc.uri, range, edit.text)
    const ok = await vscode.workspace.applyEdit(we)
    this.log(`sledgehammer job ${id}: ${ok ? 'put in' : 'could not put in'} ${JSON.stringify(edit.text)}`)
    if (ok) {
      this.drop(job)
      this.changed.fire()
    }
    return ok
  }

  async locate(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (!job) return
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(job.uri))
    const editor = await vscode.window.showTextDocument(doc, { preview: false })
    const range = new vscode.Range(doc.positionAt(job.start), doc.positionAt(job.end))
    editor.selection = new vscode.Selection(range.start, range.start)
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  }

  /** The newest job not dismissed, for the test hook and the classic status line. */
  latest(): Job | undefined {
    let last: Job | undefined
    for (const job of this.jobs.values()) if (!job.hidden && (!last || job.startedAt >= last.startedAt)) last = job
    return last
  }

  visible(): Job[] {
    return [...this.jobs.values()].filter(j => !j.hidden).sort((a, b) => b.startedAt - a.startedAt)
  }

  /* ---------- in the editor ---------- */

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const uri = doc.uri.toString()
    const lenses: vscode.CodeLens[] = []
    for (const job of this.jobs.values()) {
      if (job.uri !== uri || job.hidden || job.status === 'cancelled') continue
      const range = new vscode.Range(doc.positionAt(job.start), doc.positionAt(job.start))
      const lens = (title: string, command: string, tooltip?: string, ...args: unknown[]) =>
        lenses.push(new vscode.CodeLens(range, { title, command, tooltip, arguments: args }))
      if (isActive(job)) {
        lens(`$(loading~spin) Sledgehammer ${job.status === 'running' ? 'running' : job.status}…`,
          'isabelle-sledgehammer.focus', 'Show the Sledgehammer panel')
        lens('Cancel', 'isabelle.sledgehammerCancelJob', 'Stop this run', job.id)
      } else if (job.proofs.length) {
        for (const proof of job.proofs.slice(0, 3)) {
          lens(`$(check) ${shorten(proof)}`, 'isabelle.sledgehammerApply',
            job.kind === 'sorry' ? 'Replace sorry with this proof' : 'Put this proof in', job.id, proof)
        }
        lens('Dismiss', 'isabelle.sledgehammerDismiss', undefined, job.id)
      } else if (job.falsified) {
        lens('$(warning) Sledgehammer falsified the goal', 'isabelle-sledgehammer.focus',
          'The goal contradicts known facts: see the Sledgehammer panel')
        lens('Dismiss', 'isabelle.sledgehammerDismiss', undefined, job.id)
      } else if (job.status === 'error') {
        lens(`$(error) Sledgehammer: ${shorten(job.error ?? 'failed')}`, 'isabelle-sledgehammer.focus')
        lens('Dismiss', 'isabelle.sledgehammerDismiss', undefined, job.id)
      } else {
        lens('$(circle-slash) Sledgehammer found no proof', 'isabelle-sledgehammer.focus')
        lens('Retry', 'isabelle.sledgehammerRetry', undefined, job.id)
        lens('Dismiss', 'isabelle.sledgehammerDismiss', undefined, job.id)
      }
    }
    return lenses
  }

  provideCodeActions(doc: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    const uri = doc.uri.toString()
    const from = doc.offsetAt(range.start)
    const to = doc.offsetAt(range.end)
    const actions: vscode.CodeAction[] = []
    for (const job of this.jobs.values()) {
      if (job.uri !== uri || job.hidden || job.proofs.length === 0) continue
      const line = (o: number) => doc.positionAt(o).line
      if (line(job.start) > line(to) || line(job.end) < line(from)) continue
      job.proofs.forEach((proof, i) => {
        const title = (job.kind === 'sorry' ? 'Replace sorry with ' : 'Put in ') + shorten(proof, 60)
        const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix)
        action.command = { title, command: 'isabelle.sledgehammerApply', arguments: [job.id, proof] }
        action.isPreferred = i === 0
        actions.push(action)
      })
    }

    /* A run for each sorry on the lines asked about that has none going and no proof
       waiting; and one for all such sorrys of the lemma, if there are more. */
    const lineStart = doc.offsetAt(new vscode.Position(range.start.line, 0))
    const lineEnd = doc.offsetAt(doc.lineAt(range.end.line).range.end)
    const sorries = this.sorriesOf(doc)
    for (const s of sorries) {
      if (s.offset < lineStart || s.offset >= lineEnd || !this.wantsRun(uri, s.offset)) continue
      const title = 'Sledgehammer this sorry'
      const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix)
      action.command = { title, command: 'isabelle.sledgehammerSorry', arguments: [uri, s.offset] }
      actions.push(action)
    }
    if (actions.some(a => a.command?.command === 'isabelle.sledgehammerSorry')) {
      const [from, to] = lemmaRange(doc, range.start.line)
      const open = sorries.filter(s => s.offset >= from && s.offset < to && this.wantsRun(uri, s.offset))
      if (open.length > 1) {
        const title = `Sledgehammer all ${open.length} sorrys of this lemma`
        const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix)
        action.command = { title, command: 'isabelle.sledgehammerSorries', arguments: [uri, range.start.line] }
        actions.push(action)
      }
    }
    return actions
  }
}

/** The offsets of the innermost outline item around a line: its lemma; else all the text. */
function lemmaRange(doc: vscode.TextDocument, line: number): [number, number] {
  const item = enclosing(outlineFor(doc), line).filter(n => n.children.length === 0).pop()
  if (!item) return [0, doc.getText().length]
  return [doc.offsetAt(new vscode.Position(item.line, 0)),
    doc.offsetAt(doc.lineAt(Math.min(item.endLine, doc.lineCount - 1)).range.end)]
}

function labelOf(doc: vscode.TextDocument, kind: JobKind, line: number): string {
  let l = line
  /* A `sorry` on a line of its own says less than the step it closes. */
  if (kind === 'sorry' && doc.lineAt(l).text.trim() === 'sorry') {
    while (l > 0 && doc.lineAt(l - 1).isEmptyOrWhitespace) l--
    if (l > 0) l--
  }
  return shorten(doc.lineAt(l).text.trim(), 80)
}

function shorten(text: string, max = 50): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : one.slice(0, max - 1) + '…'
}
