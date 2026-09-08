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
  percentage: number
}

export type CommandTiming = { id: number; name: string; time: number }

export type TheoriesResponse = {
  phase: string
  threshold: number
  current?: string
  nodes: NodeStatus[]
  commands: CommandTiming[]
}

const BAR_CELLS = 10

/** jEdit draws a proportional bar per theory; the nearest honest thing in a tree row. */
export function progressBar(percentage: number): string {
  const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((percentage / 100) * BAR_CELLS)))
  return '▰'.repeat(filled) + '▱'.repeat(BAR_CELLS - filled)
}

export function statusIcon(node: NodeStatus): vscode.ThemeIcon {
  if (node.failed > 0) return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'))
  if (node.canceled) return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.orange'))
  if (node.running > 0) return new vscode.ThemeIcon('sync~spin')
  if (node.warned > 0) return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'))
  if (node.consolidated) return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'))
  if (node.unprocessed > 0) return new vscode.ThemeIcon('circle-large-outline')
  return new vscode.ThemeIcon('check')
}

/** Short right-hand summary: the bar plus whatever is not simply "finished". */
export function statusDescription(node: NodeStatus): string {
  const parts: string[] = []
  if (node.failed > 0) parts.push(`${node.failed} failed`)
  if (node.warned > 0) parts.push(`${node.warned} warned`)
  if (node.running > 0) parts.push(`${node.running} running`)
  if (node.unprocessed > 0) parts.push(`${node.unprocessed} unprocessed`)
  const tail = parts.length ? '  ' + parts.join(', ') : ''
  return `${progressBar(node.percentage)} ${node.percentage}%${tail}`
}

function tooltip(node: NodeStatus): vscode.MarkdownString {
  const md = new vscode.MarkdownString()
  md.appendMarkdown(`**${node.theory}**\n\n`)
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

class TheoriesProvider implements vscode.TreeDataProvider<NodeStatus> {
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this.emitter.event
  nodes: NodeStatus[] = []

  refresh(nodes: NodeStatus[]): void {
    this.nodes = nodes
    this.emitter.fire()
  }

  getChildren(element?: NodeStatus): NodeStatus[] {
    return element ? [] : this.nodes
  }

  getTreeItem(node: NodeStatus): vscode.TreeItem {
    const item = new vscode.TreeItem(node.theory, vscode.TreeItemCollapsibleState.None)
    item.id = node.uri
    item.description = statusDescription(node)
    item.iconPath = statusIcon(node)
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
    const item = new vscode.TreeItem(node.theory,
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
  private theoriesView: vscode.TreeView<NodeStatus> | undefined
  private last: TheoriesResponse | undefined
  private supported = false

  constructor(
    private readonly client: LanguageClient,
    private readonly log: (m: string) => void,
  ) {}

  register(disposables: vscode.Disposable[]): void {
    this.theoriesView = vscode.window.createTreeView('isabelle-theories',
      { treeDataProvider: this.theories })
    const timingView = vscode.window.createTreeView('isabelle-timing',
      { treeDataProvider: this.timing })

    disposables.push(
      this.theoriesView,
      timingView,
      this.client.onNotification('PIDE/theories_response', (p: TheoriesResponse) => {
        this.supported = true
        this.last = p
        this.theories.refresh(p.nodes ?? [])
        this.timing.refresh(p.nodes ?? [], p.commands ?? [], p.current)
        if (this.theoriesView) this.theoriesView.description = `Prover: ${p.phase}`
        timingView.description = `Threshold: ${p.threshold}s`
      }),
      vscode.commands.registerCommand('isabelle.theoriesRefresh', () => this.request()),
      vscode.commands.registerCommand('isabelle.gotoCommand', (id: number) => {
        this.log(`goto_command ${id}`)
        return this.client.sendNotification('PIDE/goto_command', { id, offset: 0 })
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

    this.sendThreshold()
    this.request()
  }

  private sendThreshold(): void {
    const threshold = vscode.workspace.getConfiguration('isabelle').get<number>('timingThreshold')
    if (typeof threshold === 'number' && threshold >= 0) {
      void this.client.sendNotification('PIDE/theories_set_threshold', { threshold })
        .catch(err => this.log(`theories_set_threshold failed: ${err}`))
    }
  }

  request(): void {
    void this.client.sendNotification('PIDE/theories_request', {})
      .catch(err => this.log(`theories_request failed: ${err}`))
  }

  /** Test hooks. */
  get serverSupported(): boolean { return this.supported }
  get lastResponse(): TheoriesResponse | undefined { return this.last }
}
