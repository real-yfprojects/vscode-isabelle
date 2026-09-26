/* The Isabelle status bar item: session image, server state and checking progress.
 *
 * One item rather than a second one beside the session picker's: the server's state is
 * the state *of that session*, and "HOL" next to a spinner reads as one fact. Clicking
 * still picks the session; everything else is in the tooltip. What it says is decided in
 * status_items.ts; this only owns the item and keeps it current.
 */

import * as vscode from 'vscode'
import { Progress, ServerPhase, StaleEntry, StatusView, TOOLTIP_COMMANDS, caretPerspective,
  statusView, summarize } from './status_items'
import type { TheoriesResponse } from './theories_panel'
import { checkWholeTheory, serverArguments } from './isabelle'

/* serverOptions and serverArgs because either can carry -o vscode_caret_perspective. */
const WATCHED = ['isabelle.logic', 'isabelle.logicRequirements', 'isabelle.checkWholeTheory',
  'isabelle.continuousChecking', 'isabelle.serverOptions', 'isabelle.serverArgs']

export class IsabelleStatus {
  private readonly item: vscode.StatusBarItem
  private readonly subscription: vscode.Disposable
  private server: ServerPhase = 'off'
  private detail: string | undefined
  private progress: Progress | undefined
  private prover: string | undefined
  private stale: readonly StaleEntry[] = []
  /** vscode_caret_perspective of the server last launched; settings apply on restart. */
  private launched: number | undefined
  private view: StatusView | undefined
  private controls = false

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
    // Until enableControls(): the only command sure to exist this early.
    this.item.command = 'isabelle.showOutput'
    /* Read from settings rather than told by the picker, so a session set by hand in
       settings.json shows up too -- it used to leave the item behind. */
    this.subscription = vscode.workspace.onDidChangeConfiguration(e => {
      if (WATCHED.some(key => e.affectsConfiguration(key))) this.render()
    })
    this.render()
    this.item.show()
  }

  get phase(): ServerPhase { return this.server }

  /** The session and server commands are registered: clicking now picks the session. */
  enableControls(): void {
    this.controls = true
    this.item.command = 'isabelle.selectSession'
    this.render()
  }

  setServer(phase: ServerPhase, detail?: string): void {
    this.server = phase
    this.detail = detail
    this.render()
  }

  setProgress(response: TheoriesResponse | undefined): void {
    this.progress = response && summarize(response.nodes ?? [], response.loading === true)
    this.prover = response?.phase
    this.render()
  }

  /** The command line a server is being started with. */
  setLaunchArgs(args: readonly string[]): void {
    this.launched = caretPerspective(args)
    this.render()
  }

  setStale(files: readonly StaleEntry[]): void {
    this.stale = files
    this.render()
  }

  render(): void {
    const cfg = vscode.workspace.getConfiguration('isabelle')
    /* A server that is up keeps the extent it was started with; with none, the settings
       are what the next one will use, so they are the whole story. */
    const configured = caretPerspective(serverArguments())
    const up = this.server === 'starting' || this.server === 'building' || this.server === 'running'
    const perspective = up && this.launched !== undefined ? this.launched : configured
    this.view = statusView({
      logic: cfg.get<string>('logic')?.trim() || 'HOL',
      requirements: cfg.get<boolean>('logicRequirements') === true,
      server: this.server,
      detail: this.detail,
      progress: this.progress,
      prover: this.prover,
      wholeTheory: checkWholeTheory(cfg),
      perspective,
      nextPerspective: configured,
      controls: this.controls,
      stale: this.stale,
    })
    this.item.text = this.view.text
    const tooltip = new vscode.MarkdownString(this.view.tooltip)
    tooltip.isTrusted = { enabledCommands: TOOLTIP_COMMANDS }
    this.item.tooltip = tooltip
    // Only these two backgrounds are honoured for status bar items.
    this.item.backgroundColor = this.view.background === undefined
      ? undefined
      : new vscode.ThemeColor(`statusBarItem.${this.view.background}Background`)
  }

  /** Test hook: the item as drawn, since a StatusBarItem cannot be read back from outside. */
  snapshot() {
    return {
      text: this.view?.text,
      tooltip: this.view?.tooltip,
      background: this.view?.background,
      server: this.server,
      progress: this.progress,
      stale: this.stale,
    }
  }

  dispose(): void {
    this.subscription.dispose()
    this.item.dispose()
  }
}
