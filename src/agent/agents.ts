/*
 * The Isabelle tools for AI agents in the extension: the MCP endpoint while the setting
 * isabelle.agents.enabled is on, the stdio relay that Claude Code starts, Copilot's view of
 * the endpoint, and the command that sets a project up for both.
 *
 * Tools: tool_defs.ts and tools.ts. Transport: mcp_http.ts and mcp_stdio.ts.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import { LanguageClient } from 'vscode-languageclient/node'
import { SymbolTable } from '../symbols'
import { McpHttpServer } from './mcp_http'
import { AgentTools } from './tools'

const SETTING = 'agents.enabled'

/* The relay and the modules it loads, copied together to global storage. */
const RELAY_FILES = ['mcp_stdio.js', 'mcp_http.js', 'tool_defs.js']

const BEGIN = '<!-- isabelle-vscode:agents -->'
const END = '<!-- /isabelle-vscode:agents -->'

/* VS Code 1.101 and later: an MCP server for Copilot and other chat participants. Not in
   the @types/vscode the extension builds with, which has to match engines.vscode. */
interface McpLm {
  registerMcpServerDefinitionProvider?: (id: string, provider: {
    onDidChangeMcpServerDefinitions?: vscode.Event<void>
    provideMcpServerDefinitions: () => unknown[]
  }) => vscode.Disposable
}
type McpHttpServerDefinitionCtor =
  new (label: string, uri: vscode.Uri, headers?: Record<string, string>, version?: string) => unknown

function folders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)
}

export class Agents {
  private server: McpHttpServer | undefined
  private readonly changed = new vscode.EventEmitter<void>()
  readonly tools: AgentTools
  private relayPath = ''

  constructor(
    private readonly context: vscode.ExtensionContext,
    getClient: () => LanguageClient | undefined,
    getTable: () => SymbolTable | undefined,
    startServer: () => Promise<void>,
    private readonly log: (m: string) => void,
  ) {
    this.tools = new AgentTools(getClient, getTable, startServer)
  }

  register(): void {
    const subs = this.context.subscriptions
    subs.push(
      this.changed,
      { dispose: () => this.stop() },
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(`isabelle.${SETTING}`)) void this.sync()
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.server?.updateFolders(folders())),
      vscode.commands.registerCommand('isabelle.setUpAgents', () => this.setUp()),
      // Test hook: call a tool as an agent would, without a transport; cancelled after
      // cancelAfterMs if given, as an agent cancels a call.
      vscode.commands.registerCommand('isabelle.agentCall',
        (name: string, args: Record<string, unknown>, cancelAfterMs?: number) => {
          const source = cancelAfterMs === undefined ? undefined : new vscode.CancellationTokenSource()
          if (source) setTimeout(() => source.cancel(), cancelAfterMs)
          return this.tools.handlers[name]?.(args ?? {}, source?.token)
        }),
      // Test hook: the setup without its pick list.
      vscode.commands.registerCommand('isabelle.agentSetUpFiles',
        (root: string, ids: string[]) => this.writeFiles(root, ids)),
      // Test hook: where an agent connects.
      vscode.commands.registerCommand('isabelle.agentEndpoint',
        () => ({ url: this.server?.url, token: this.server?.token, relay: this.relayPath })),
    )
    this.installRelay()
    this.registerCopilot()
    void this.sync()
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('isabelle').get<boolean>(SETTING, false)
  }

  private async sync(): Promise<void> {
    if (this.enabled() && !this.server) {
      const version = String(this.context.extension.packageJSON.version ?? '')
      const server = new McpHttpServer(this.tools.handlers, version, this.log)
      try {
        await server.start(folders())
        this.server = server
      } catch (err) {
        this.log(`agent tools: cannot start the MCP endpoint: ${err}`)
      }
    } else if (!this.enabled() && this.server) {
      this.stop()
    }
    this.changed.fire()
  }

  private stop(): void {
    this.server?.dispose()
    this.server = undefined
  }

  /** Copies the relay where `.mcp.json` can name it for good: global storage outlives updates. */
  private installRelay(): void {
    const target = path.join(this.context.globalStorageUri.fsPath, 'agent')
    try {
      fs.mkdirSync(target, { recursive: true })
      for (const f of RELAY_FILES) {
        fs.copyFileSync(path.join(this.context.extensionPath, 'out', 'agent', f), path.join(target, f))
      }
      this.relayPath = path.join(target, 'mcp_stdio.js')
    } catch (err) {
      this.log(`agent tools: cannot install the relay: ${err}`)
    }
  }

  private registerCopilot(): void {
    const lm = (vscode as unknown as { lm?: McpLm }).lm
    const Definition = (vscode as unknown as { McpHttpServerDefinition?: McpHttpServerDefinitionCtor })
      .McpHttpServerDefinition
    if (!lm?.registerMcpServerDefinitionProvider || !Definition) return
    this.context.subscriptions.push(lm.registerMcpServerDefinitionProvider('isabelle.agents', {
      onDidChangeMcpServerDefinitions: this.changed.event,
      provideMcpServerDefinitions: () => {
        const server = this.server
        if (!server?.url) return []
        return [new Definition('Isabelle', vscode.Uri.parse(server.url),
          { Authorization: `Bearer ${server.token}` },
          String(this.context.extension.packageJSON.version ?? ''))]
      },
    }))
  }

  /* Set Up AI Agents */

  /** How `.mcp.json` starts the relay: Node from the PATH, or VS Code's own runtime as Node. */
  private relayCommand(): { command: string; args: string[]; env?: Record<string, string> } {
    const exe = process.platform === 'win32' ? 'node.exe' : 'node'
    const onPath = (process.env.PATH ?? '').split(path.delimiter)
      .map(d => path.join(d, exe)).find(p => { try { return fs.statSync(p).isFile() } catch { return false } })
    return onPath
      ? { command: 'node', args: [this.relayPath] }
      : { command: process.execPath, args: [this.relayPath], env: { ELECTRON_RUN_AS_NODE: '1' } }
  }

  private guide(): string {
    return fs.readFileSync(path.join(this.context.extensionPath, 'media', 'agents', 'SKILL.md'), 'utf8')
  }

  private async setUp(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) {
      void vscode.window.showWarningMessage('Open the folder of your Isabelle project first.')
      return
    }
    type Item = vscode.QuickPickItem & { id: 'mcp' | 'skill' | 'copilot' }
    const items: Item[] = [
      { id: 'mcp', label: 'Claude Code: add the Isabelle MCP server to .mcp.json', picked: true },
      { id: 'skill', label: 'Claude Code: add the Isabelle skill to .claude/skills/isabelle', picked: true },
      { id: 'copilot', label: 'GitHub Copilot: add the Isabelle guide to .github/copilot-instructions.md', picked: false },
    ]
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: 'Set Up AI Agents for Isabelle',
      placeHolder: 'The tools for Copilot need no file: they come with the setting this turns on.',
    })
    if (!chosen) return
    await vscode.workspace.getConfiguration('isabelle').update(SETTING, true,
      vscode.ConfigurationTarget.Global)

    let done: string[]
    try {
      done = await this.writeFiles(folder.uri.fsPath, chosen.map(i => i.id))
    } catch (err) {
      void vscode.window.showErrorMessage(`Setting up AI agents failed: ${err instanceof Error ? err.message : err}`)
      return
    }
    void vscode.window.showInformationMessage(
      ['The Isabelle tools are on.', ...done.filter(d => d)].join(' ') +
      ' Start a new Claude Code session in this folder and approve the "isabelle" server ' +
      'when it asks (or run /mcp).')
  }

  /** The files the setup writes into a project, as chosen. */
  private async writeFiles(root: string, ids: string[]): Promise<string[]> {
    const done: string[] = []
    for (const id of ids) {
      if (id === 'mcp') done.push(this.writeMcpJson(root))
      if (id === 'skill') done.push(await this.writeSkill(root))
      if (id === 'copilot') done.push(this.writeCopilot(root))
    }
    return done
  }

  private writeMcpJson(root: string): string {
    const file = path.join(root, '.mcp.json')
    let json: { mcpServers?: Record<string, unknown> } = {}
    if (fs.existsSync(file)) {
      try { json = JSON.parse(fs.readFileSync(file, 'utf8')) }
      catch { throw new Error(`${file} is not valid JSON; fix or remove it first.`) }
    }
    json.mcpServers = { ...(json.mcpServers ?? {}), isabelle: { type: 'stdio', ...this.relayCommand() } }
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
    return 'Added "isabelle" to .mcp.json.'
  }

  private async writeSkill(root: string): Promise<string> {
    const file = path.join(root, '.claude', 'skills', 'isabelle', 'SKILL.md')
    const text = this.guide()
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== text) {
      const answer = await vscode.window.showWarningMessage(
        `${path.relative(root, file)} exists and differs from the extension's guide.`,
        'Replace', 'Keep')
      if (answer !== 'Replace') return `Kept ${path.relative(root, file)}.`
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    return `Wrote ${path.relative(root, file)}.`
  }

  private writeCopilot(root: string): string {
    const file = path.join(root, '.github', 'copilot-instructions.md')
    const body = this.guide().replace(/^---[\s\S]*?---\s*/, '')
    const block = `${BEGIN}\n${body.trim()}\n${END}\n`
    let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const start = text.indexOf(BEGIN)
    const end = text.indexOf(END)
    if (start >= 0 && end > start) text = text.slice(0, start) + block + text.slice(end + END.length + 1)
    else text = (text && !text.endsWith('\n\n') ? text.replace(/\n?$/, '\n\n') : text) + block
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    return `Updated ${path.relative(root, file)}.`
  }
}
