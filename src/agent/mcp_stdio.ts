/*
 * The stdio MCP server that Claude Code (or any MCP client) starts: a relay to the VS Code
 * window whose workspace holds the current directory, whose extension serves the Isabelle
 * tools over HTTP (mcp_http.ts). Newline-delimited JSON-RPC on stdin and stdout.
 *
 * Runs with plain Node, outside VS Code: the extension copies it, with the two modules it
 * needs, to a fixed place in its global storage, which `.mcp.json` names. The window is
 * looked up again when a call fails, so a reload of the window or a later start does not
 * need a restart of the agent; while there is none, `initialize` and `tools/list` are
 * answered here and a tool call says what to do.
 *
 * ISABELLE_VSCODE_WORKSPACE picks the window by a folder other than the current directory.
 */
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'
import * as readline from 'readline'
import { answer, Lock, LOCK_DIR } from './mcp_http'
import { NO_WINDOW } from './tool_defs'

const VERSION = 'relay'

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

function normal(p: string): string {
  const r = path.resolve(p)
  return process.platform === 'win32' ? r.toLowerCase() : r
}

function contains(folder: string, dir: string): boolean {
  const f = normal(folder)
  const d = normal(dir)
  return d === f || d.startsWith(f.endsWith(path.sep) ? f : f + path.sep)
}

/** The live window whose deepest workspace folder holds the directory; the newest wins. */
export function findLock(dir: string, lockDir = LOCK_DIR): Lock | undefined {
  let best: { lock: Lock; depth: number; mtime: number } | undefined
  let files: string[] = []
  try { files = fs.readdirSync(lockDir).filter(f => f.endsWith('.json')) } catch { return undefined }
  for (const f of files) {
    const file = path.join(lockDir, f)
    let lock: Lock
    let mtime: number
    try {
      lock = JSON.parse(fs.readFileSync(file, 'utf8'))
      mtime = fs.statSync(file).mtimeMs
    } catch { continue }
    if (!alive(lock.pid)) {
      try { fs.unlinkSync(file) } catch { /* another relay was first */ }
      continue
    }
    for (const folder of lock.workspaceFolders ?? []) {
      if (!contains(folder, dir)) continue
      const depth = normal(folder).length
      if (!best || depth > best.depth || (depth === best.depth && mtime > best.mtime)) {
        best = { lock, depth, mtime }
      }
    }
  }
  return best?.lock
}

function post(lock: Lock, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(lock.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${lock.token}`,
      },
    }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', c => { data += c })
      res.on('end', () => {
        if (res.statusCode === 401) reject(new Error('unauthorized'))
        else resolve(data)
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function relay(line: string, dir: string, write: (s: string) => void): Promise<void> {
  let message: { id?: unknown; method?: string }
  try { message = JSON.parse(line) }
  catch {
    write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
    return
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const lock = findLock(dir)
    if (!lock) break
    try {
      const reply = await post(lock, line)
      if (reply.trim()) write(reply.trim())
      return
    } catch { /* the window went away: look again */ }
  }
  /* No window: answer what needs none, and tell the agent why the tools cannot work. */
  if (message.method === 'tools/call') {
    write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
      result: { content: [{ type: 'text', text: NO_WINDOW }], isError: true } }))
    return
  }
  const a = await answer(message as never, undefined, VERSION)
  if (a) write(JSON.stringify(a))
}

export function main(): void {
  const dir = process.env.ISABELLE_VSCODE_WORKSPACE || process.cwd()
  const write = (s: string) => process.stdout.write(s.replace(/\n/g, ' ') + '\n')
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  /* Answered in the order asked, one at a time: MCP allows concurrency, but the prover
     works on one window, and order keeps a log readable. Tool calls can be long, so
     pings are not held up behind them. */
  let queue = Promise.resolve()
  rl.on('line', line => {
    if (!line.trim()) return
    let quick = false
    try { quick = JSON.parse(line).method !== 'tools/call' } catch { /* relay reports it */ }
    if (quick) void relay(line, dir, write)
    else queue = queue.then(() => relay(line, dir, write))
  })
  rl.on('close', () => { void queue.then(() => process.exit(0)) })
}

if (require.main === module) main()
