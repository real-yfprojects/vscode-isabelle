/*
 * A minimal MCP server for the Isabelle tools, inside the extension host: JSON-RPC over
 * HTTP POST (MCP's Streamable HTTP, without server-sent events, which tools that answer
 * once do not need), on 127.0.0.1 and a random port.
 *
 * Every request must carry the bearer token of this window, which only the lock file in
 * ~/.isabelle-vscode/agents holds: a web page or another user cannot call the prover. The
 * lock file also says which workspace folders the window has, so that the stdio shim
 * (mcp_stdio.ts) that Claude Code starts in a project finds the window for it.
 *
 * Copilot connects here directly, through registerMcpServerDefinitionProvider.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { SERVER_INSTRUCTIONS, TOOL_DEFS } from './tool_defs'
import type { ToolHandler } from './tools'

export const LOCK_DIR = path.join(os.homedir(), '.isabelle-vscode', 'agents')

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

export interface Lock {
  pid: number
  port: number
  token: string
  url: string
  workspaceFolders: string[]
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } }

/**
 * Answers one JSON-RPC message, or undefined for a notification. Shared with the shim,
 * which answers `initialize` and `tools/list` itself while no window serves its folder.
 */
export async function answer(
  message: JsonRpcRequest,
  handlers: Record<string, ToolHandler> | undefined,
  version: string,
): Promise<JsonRpcResponse | undefined> {
  const id = message.id ?? null
  const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result })
  const fail = (code: number, msg: string): JsonRpcResponse =>
    ({ jsonrpc: '2.0', id, error: { code, message: msg } })
  if (message.id === undefined) return undefined   // notifications/initialized and the like
  switch (message.method) {
    case 'initialize': {
      const asked = message.params?.protocolVersion
      return ok({
        protocolVersion: typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked)
          ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'isabelle', title: 'Isabelle', version },
        instructions: SERVER_INSTRUCTIONS,
      })
    }
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: TOOL_DEFS })
    case 'tools/call': {
      const name = message.params?.name
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>
      const handler = typeof name === 'string' ? handlers?.[name] : undefined
      if (typeof name !== 'string' || !TOOL_DEFS.some(t => t.name === name)) {
        return fail(-32602, `Unknown tool: ${String(name)}`)
      }
      if (!handler) return fail(-32603, `No handler for ${name}`)
      const result = await handler(args)
      return ok({ content: [{ type: 'text', text: result.text }], isError: !!result.isError })
    }
    default:
      return fail(-32601, `Method not found: ${message.method}`)
  }
}

export class McpHttpServer {
  private server: http.Server | undefined
  private lockFile: string | undefined
  readonly token = crypto.randomBytes(24).toString('hex')
  url: string | undefined

  constructor(
    private readonly handlers: Record<string, ToolHandler>,
    private readonly version: string,
    private readonly log: (m: string) => void,
    private readonly lockDir = LOCK_DIR,
  ) {}

  async start(workspaceFolders: string[]): Promise<void> {
    const server = http.createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    this.server = server
    const port = (server.address() as { port: number }).port
    this.url = `http://127.0.0.1:${port}/mcp`
    this.writeLock({ pid: process.pid, port, token: this.token, url: this.url, workspaceFolders })
    this.log(`agent tools: MCP on ${this.url}`)
  }

  /** The workspace folders changed: the shim should find this window for the new ones. */
  updateFolders(workspaceFolders: string[]): void {
    if (!this.server || !this.url) return
    const port = (this.server.address() as { port: number }).port
    this.writeLock({ pid: process.pid, port, token: this.token, url: this.url, workspaceFolders })
  }

  private writeLock(lock: Lock): void {
    try {
      fs.mkdirSync(this.lockDir, { recursive: true })
      this.lockFile = path.join(this.lockDir, `${process.pid}.json`)
      fs.writeFileSync(this.lockFile, JSON.stringify(lock, null, 2), { mode: 0o600 })
    } catch (err) {
      this.log(`agent tools: cannot write the lock file: ${err}`)
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json' })
      res.end(body === undefined ? undefined : JSON.stringify(body))
    }
    if (req.headers.authorization !== `Bearer ${this.token}`) return send(401)
    /* A browser page could only reach this with a token it cannot know; refuse it outright
       all the same. */
    if (req.headers.origin) return send(403)
    if (req.method !== 'POST' || !req.url?.startsWith('/mcp')) return send(405)

    let body = ''
    for await (const chunk of req) body += chunk
    let message: JsonRpcRequest | JsonRpcRequest[]
    try { message = JSON.parse(body) }
    catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) }

    try {
      if (Array.isArray(message)) {
        const answers = (await Promise.all(message.map(m => answer(m, this.handlers, this.version))))
          .filter(a => a !== undefined)
        return answers.length ? send(200, answers) : send(202)
      }
      if (message.method === 'tools/call') {
        this.log(`agent tools: ${String(message.params?.name)} ` +
          JSON.stringify(message.params?.arguments ?? {}).slice(0, 200))
      }
      const a = await answer(message, this.handlers, this.version)
      return a ? send(200, a) : send(202)
    } catch (err) {
      return send(500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: String(err) } })
    }
  }

  dispose(): void {
    this.server?.close()
    this.server = undefined
    if (this.lockFile) {
      try { fs.unlinkSync(this.lockFile) } catch { /* gone already */ }
    }
  }
}
