/* Theories and Timing, following the two jEdit dockables of those names.
 *
 * Both are views of one Document_Status.Nodes_Status on the server, so they share a
 * single notification (PIDE/theories_response) and this one module.
 *
 * These are TreeViews rather than webviews, unlike every other panel here. That is not
 * a stylistic choice: both dockables are *lists of named things with a status*, which is
 * exactly the shape a TreeView has, and going native buys keyboard navigation, the
 * built-in filter (type-to-find), theme-coloured icons and hover tooltips for free --
 * none of which a webview gets without reimplementing it. The pretty-printed panels
 * (State, Output) stay webviews because their content is Isabelle markup, not a list.
 *
 * The server half is the `vscode-theories-panel` branch of mirror-isabelle.
 */

import * as vscode from 'vscode'
import { LanguageClient } from 'vscode-languageclient/node'

export type NodeStatus = {
  uri: string
  theory: string
  overall: 'ok' | 'failed' | 'pending'
  cumulated_time: number
  max_time: number
  ok: boolean
  total: number
  unprocessed: number
  running: number
  warned: number
  failed: number
  finished: number
  canceled: boolean
  consolidated: boolean
  initialized: boolean
  percentage: number
}

export type CommandTiming = { id: number; name: string; time: number }

export type TheoriesResponse = {
  phase: string
  /** The server is still resolving theory imports; see `settling` below. */
  loading: boolean
  threshold: number
  current?: string
  nodes: NodeStatus[]
  commands: CommandTiming[]
}

const BAR_CELLS = 10

/**
 * jEdit draws a proportional bar per theory. A tree row is the wrong place for it: rows
 * never wrap and the description is truncated from the right, so a bar wide enough to
 * read pushes out the number it is illustrating. It lives in the tooltip instead, which
 * has room.
 */
export function progressBar(percentage: number): string {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((percentage / 100) * BAR_CELLS)))
  return '▰'.repeat(filled) + '▱'.repeat(BAR_CELLS - filled)
}

/** `HOL-Library.Complex_Order` -> session `HOL-Library`, base `Complex_Order`. */
export function splitTheory(qualified: string): { session: string; base: string } {
  const dot = qualified.lastIndexOf('.')
  return dot < 0
    ? { session: '', base: qualified }
    : { session: qualified.slice(0, dot), base: qualified.slice(dot + 1) }
}

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

export function statusIcon(node: NodeStatus, loading = false): vscode.ThemeIcon {
  if (settling(node, loading)) return new vscode.ThemeIcon('sync~spin')
  if (node.failed > 0) return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'))
  if (node.canceled) return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.orange'))
  if (node.running > 0) return new vscode.ThemeIcon('sync~spin')
  if (node.warned > 0) return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'))
  if (node.consolidated) return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'))
  if (node.unprocessed > 0) return new vscode.ThemeIcon('circle-large-outline')
  return new vscode.ThemeIcon('check')
}

/**
 * Short right-hand summary. Ordered most-important-first because the description is what
 * VS Code truncates, and empty for a theory that finished cleanly -- the icon already
 * says so, and a row ending in "0 failed" is noise.
 */
export function statusDescription(node: NodeStatus, loading = false): string {
  if (settling(node, loading)) return 'resolving imports'
  const parts: string[] = []
  if (node.percentage < 100) parts.push(`${node.percentage}%`)
  if (node.failed > 0) parts.push(`${node.failed} failed`)
  if (node.warned > 0) parts.push(`${node.warned} warned`)
  if (node.running > 0) parts.push(`${node.running} running`)
  if (node.unprocessed > 0) parts.push(`${node.unprocessed} left`)
  return parts.join(' · ')
}

/** Roll a session's theories up into one row. */
export function sessionDescription(nodes: readonly NodeStatus[], loading = false): string {
  const done = nodes.filter(n => n.percentage === 100).length
  const failed = nodes.reduce((n, x) => n + (x.failed > 0 && !settling(x, loading) ? 1 : 0), 0)
  const parts = [`${done}/${nodes.length}`]
  if (failed > 0) parts.push(`${failed} failed`)
  return parts.join(' · ')
}

function tooltip(node: NodeStatus): vscode.MarkdownString {
  const md = new vscode.MarkdownString()
  md.appendMarkdown(`**${node.theory}**\n\n`)
  md.appendMarkdown(`${progressBar(node.percentage)} ${node.percentage}%\n\n`)
  md.appendMarkdown(
    [
      `| | |`,
      `|---|---:|`,
      `| total | ${node.total} |`,
      `| finished | ${node.finished} |`,
      `| running | ${node.running} |`,
      `| unprocessed | ${node.unprocessed} |`,
      `| warned | ${node.warned} |`,
      `| failed | ${node.failed} |`,
      `| cumulated time | ${node.cumulated_time.toFixed(3)}s |`,
      `| max command time | ${node.max_time.toFixed(3)}s |`,
    ].join('\n'))
  return md
}

type TimingItem = { kind: 'theory'; node: NodeStatus } | { kind: 'command'; cmd: CommandTiming }

type TheoryItem =
  | { kind: 'session'; session: string; nodes: NodeStatus[] }
  | { kind: 'theory'; node: NodeStatus }

/**
 * Theories grouped by their session.
 *
 * A flat list does not fit: every row carries its session as a prefix
 * (`HOL-Library.Liminf_Limsup`), which is both redundant down a column and long enough
 * that the status is truncated away. Grouping removes the prefix from the label and
 * gives the imported library sessions somewhere to be collapsed out of the way.
 */
export function groupBySession(nodes: readonly NodeStatus[]): TheoryItem[] {
  const groups = new Map<string, NodeStatus[]>()
  for (const node of nodes) {
    const { session } = splitTheory(node.theory)
    const list = groups.get(session)
    if (list) list.push(node)
    else groups.set(session, [node])
  }
  const out: TheoryItem[] = []
  for (const [session, list] of groups) {
    // A theory with no qualifier has no session to file it under.
    if (session === '') out.push(...list.map(node => ({ kind: 'theory', node } as TheoryItem)))
    else out.push({ kind: 'session', session, nodes: list })
  }
  return out
}

/** Sessions you are working in stay open; finished library sessions fold away. */
export function sessionIsBusy(nodes: readonly NodeStatus[]): boolean {
  return nodes.some(n => n.failed > 0 || n.running > 0 || n.percentage < 100)
}

class TheoriesProvider implements vscode.TreeDataProvider<TheoryItem> {
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.emitter.event
  nodes: NodeStatus[] = []
  loading = false

  refresh(nodes: NodeStatus[], loading: boolean): void {
    this.nodes = nodes
    this.loading = loading
    this.emitter.fire()
  }

  getChildren(element?: TheoryItem): TheoryItem[] {
    if (!element) return groupBySession(this.nodes)
    if (element.kind === 'session') {
      return element.nodes.map(node => ({ kind: 'theory', node } as TheoryItem))
    }
    return []
  }

  getTreeItem(element: TheoryItem): vscode.TreeItem {
    if (element.kind === 'session') {
      const busy = sessionIsBusy(element.nodes)
      const item = new vscode.TreeItem(element.session,
        busy ? vscode.TreeItemCollapsibleState.Expanded
             : vscode.TreeItemCollapsibleState.Collapsed)
      item.id = 'session:' + element.session
      item.description = sessionDescription(element.nodes, this.loading)
      item.iconPath = new vscode.ThemeIcon('library')
      item.contextValue = 'isabelleSession'
      return item
    }
    const node = element.node
    const item = new vscode.TreeItem(splitTheory(node.theory).base,
      vscode.TreeItemCollapsibleState.None)
    item.id = node.uri
    item.description = statusDescription(node, this.loading)
    item.iconPath = statusIcon(node, this.loading)
    item.tooltip = tooltip(node)
    item.resourceUri = vscode.Uri.parse(node.uri)
    item.contextValue = 'isabelleTheory'
    item.command = {
      command: 'vscode.open',
      title: 'Open Theory',
      arguments: [vscode.Uri.parse(node.uri)],
    }
    return item
  }
}

class TimingProvider implements vscode.TreeDataProvider<TimingItem> {
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.emitter.event
  private nodes: NodeStatus[] = []
  private commands: CommandTiming[] = []
  private current: string | undefined

  refresh(nodes: NodeStatus[], commands: CommandTiming[], current: string | undefined): void {
    // Only theories that actually spent time; sorted like jEdit's, slowest first.
    this.nodes = nodes.filter(n => n.cumulated_time > 0)
      .sort((a, b) => b.cumulated_time - a.cumulated_time)
    this.commands = [...commands].sort((a, b) => b.time - a.time)
    this.current = current
    this.emitter.fire()
  }

  private isCurrent(node: NodeStatus): boolean {
    return this.current !== undefined && node.uri === this.current
  }

  getChildren(element?: TimingItem): TimingItem[] {
    if (!element) return this.nodes.map(node => ({ kind: 'theory', node } as TimingItem))
    // The server can only resolve command ids against the caret's own snapshot, so
    // commands are available for the current theory alone -- as in jEdit.
    if (element.kind === 'theory' && this.isCurrent(element.node)) {
      return this.commands.map(cmd => ({ kind: 'command', cmd } as TimingItem))
    }
    return []
  }

  getTreeItem(element: TimingItem): vscode.TreeItem {
    if (element.kind === 'command') {
      const item = new vscode.TreeItem(element.cmd.name, vscode.TreeItemCollapsibleState.None)
      item.description = `${element.cmd.time.toFixed(3)}s`
      item.iconPath = new vscode.ThemeIcon('symbol-event')
      item.contextValue = 'isabelleCommandTiming'
      item.command = {
        command: 'isabelle.gotoCommand',
        title: 'Go to Command',
        arguments: [element.cmd.id],
      }
      return item
    }
    const node = element.node
    const expandable = this.isCurrent(node) && this.commands.length > 0
    const item = new vscode.TreeItem(splitTheory(node.theory).base,
      expandable ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None)
    item.id = 'timing:' + node.uri
    item.description = `${node.cumulated_time.toFixed(3)}s` +
      (node.max_time > 0 ? `  (max ${node.max_time.toFixed(3)}s)` : '')
    item.iconPath = new vscode.ThemeIcon('watch')
    item.resourceUri = vscode.Uri.parse(node.uri)
    item.command = {
      command: 'vscode.open',
      title: 'Open Theory',
      arguments: [vscode.Uri.parse(node.uri)],
    }
    return item
  }
}

export class TheoriesPanel {
  private readonly theories = new TheoriesProvider()
  private readonly timing = new TimingProvider()
  private theoriesView: vscode.TreeView<TheoryItem> | undefined
  private timingView: vscode.TreeView<unknown> | undefined
  private client: LanguageClient | undefined
  private last: TheoriesResponse | undefined
  private supported = false

  constructor(private readonly log: (m: string) => void) {}

  /**
   * Views and commands, for the lifetime of the *extension*.
   *
   * Deliberately not tied to a client. These used to be created per client, so a restart
   * that failed to come back left the view with no provider at all ("There is no data
   * provider registered that can provide view data") and its refresh command missing --
   * two errors about plumbing, on top of whatever actually went wrong. The view now
   * always exists and simply reports that the prover is not running.
   */
  registerViews(disposables: vscode.Disposable[]): void {
    this.theoriesView = vscode.window.createTreeView<TheoryItem>('isabelle-theories',
      { treeDataProvider: this.theories })
    const timingView = vscode.window.createTreeView('isabelle-timing',
      { treeDataProvider: this.timing })

    this.timingView = timingView
    disposables.push(
      this.theoriesView,
      timingView,
      vscode.commands.registerCommand('isabelle.theoriesRefresh', () => this.request()),
      vscode.commands.registerCommand('isabelle.gotoCommand', (id: number) => {
        this.log(`goto_command ${id}`)
        return this.client?.sendNotification('PIDE/goto_command', { id, offset: 0 })
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('isabelle.timingThreshold')) this.sendThreshold()
      }),
      // Test hook.
      vscode.commands.registerCommand('isabelle.theoriesState', () => ({
        supported: this.supported,
        phase: this.last?.phase,
        threshold: this.last?.threshold,
        current: this.last?.current,
        nodes: this.last?.nodes ?? [],
        commands: this.last?.commands ?? [],
      })),
    )

    this.setDescription('not running')
  }

  /** Subscribe to the current client. Called again on every restart. */
  bind(client: LanguageClient, disposables: vscode.Disposable[]): void {
    this.client = client
    disposables.push(
      client.onNotification('PIDE/theories_response', (p: TheoriesResponse) => {
        this.supported = true
        this.last = p
        this.theories.refresh(p.nodes ?? [], p.loading === true)
        this.timing.refresh(p.nodes ?? [], p.commands ?? [], p.current)
        // Say why nothing is failing yet, rather than leaving a wall of spinners.
        this.setDescription(
          p.loading ? `Prover: ${p.phase} · resolving imports` : `Prover: ${p.phase}`)
        if (this.timingView) this.timingView.description = `Threshold: ${p.threshold}s`
      }),
      { dispose: () => this.unbind() },
    )
    this.sendThreshold()
    this.request()
  }

  /** The prover went away. Keep the views, drop what they were showing. */
  unbind(): void {
    this.client = undefined
    this.last = undefined
    this.theories.refresh([], false)
    this.timing.refresh([], [], undefined)
    this.setDescription('not running')
  }

  private setDescription(text: string): void {
    if (this.theoriesView) this.theoriesView.description = text
  }

  private sendThreshold(): void {
    const threshold = vscode.workspace.getConfiguration('isabelle').get<number>('timingThreshold')
    if (typeof threshold === 'number' && threshold >= 0) {
      void this.client?.sendNotification('PIDE/theories_set_threshold', { threshold })
        ?.catch(err => this.log(`theories_set_threshold failed: ${err}`))
    }
  }

  /** Refresh on demand. Harmless with no prover: the command must never be missing. */
  request(): void {
    if (this.client === undefined) {
      this.setDescription('not running')
      return
    }
    void this.client.sendNotification('PIDE/theories_request', {})
      .catch(err => this.log(`theories_request failed: ${err}`))
  }

  /** Test hooks. */
  get serverSupported(): boolean { return this.supported }
  get lastResponse(): TheoriesResponse | undefined { return this.last }
}
