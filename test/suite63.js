// The transport of the tools for AI agents, without an editor or a prover: MCP's JSON-RPC
// answers, the HTTP endpoint the extension serves (its token and the refusal of browser
// pages), how the stdio relay that Claude Code starts finds the window for its folder, and
// the text helpers -- the goal an agent states, literal Unicode, Sledgehammer's proofs.
//
// The relay is run as Claude Code runs it, a child process speaking newline-delimited
// JSON-RPC, against an endpoint with stand-in tools.
const assert = require('assert')
const { spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const out = path.join(__dirname, '..', 'out', 'agent')
const { answer, McpHttpServer, PROTOCOL_VERSIONS } = require(path.join(out, 'mcp_http.js'))
const { findLock } = require(path.join(out, 'mcp_stdio.js'))
const { TOOL_DEFS, NO_WINDOW } = require(path.join(out, 'tool_defs.js'))
const { goalStatement, unicodeLines, proofsOf } = require(path.join(out, 'text.js'))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

function post(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      res => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : undefined }))
      })
    req.on('error', reject)
    req.end(typeof body === 'string' ? body : JSON.stringify(body))
  })
}

/** A relay child, and a function that sends a message and waits for the answer to it. */
function relay(env) {
  const child = spawn(process.execPath, [path.join(out, 'mcp_stdio.js')],
    { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] })
  const waiting = new Map()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    let i
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i)
      buffer = buffer.slice(i + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      waiting.get(msg.id)?.(msg)
      waiting.delete(msg.id)
    }
  })
  let next = 1
  /** Sends a request; its id, and the answer, which may never come. */
  const send = (method, params, seconds = 15) => {
    const id = next++
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), seconds * 1000)
      waiting.set(id, msg => { clearTimeout(timer); resolve(msg) })
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return { id, answer }
  }
  const call = (method, params) => send(method, params).answer
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  return { send, call, notify, close: () => child.stdin.end() }
}

/** A POST that can be aborted before its answer. */
function postAbortable(url, body, headers) {
  let req
  const answer = new Promise((resolve, reject) => {
    req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      res => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => resolve(JSON.parse(data)))
      })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
  return { answer, abort: () => req.destroy() }
}

const until = async (probe, ms = 5000) => {
  const deadline = Date.now() + ms
  while (!probe() && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
  return probe()
}

async function run() {
  // --- JSON-RPC answers ---
  const init = await answer({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26' } }, {}, '1.0')
  assert.strictEqual(init.result.protocolVersion, '2025-03-26')
  assert.ok(init.result.capabilities.tools)
  assert.match(init.result.instructions, /\\<forall>/, 'the instructions tell the notation')
  const later = await answer({ jsonrpc: '2.0', id: 2, method: 'initialize',
    params: { protocolVersion: '2099-01-01' } }, {}, '1.0')
  assert.strictEqual(later.result.protocolVersion, PROTOCOL_VERSIONS[0])
  pass('initialize agrees on a protocol version, the newest when the client\'s is unknown')

  const list = await answer({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, {}, '1.0')
  assert.deepStrictEqual(list.result.tools.map(t => t.name),
    ['isabelle_check', 'isabelle_state', 'isabelle_try', 'isabelle_sledgehammer', 'isabelle_find_theorems'])
  for (const t of list.result.tools) {
    assert.strictEqual(t.inputSchema.type, 'object')
    for (const r of t.inputSchema.required) assert.ok(t.inputSchema.properties[r], `${t.name}.${r}`)
  }
  pass('tools/list lists the five tools, each with a schema covering its required arguments')

  assert.strictEqual(await answer({ jsonrpc: '2.0', method: 'notifications/initialized' }, {}, '1'), undefined)
  const unknown = await answer({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, {}, '1')
  assert.strictEqual(unknown.error.code, -32601)
  const badTool = await answer({ jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'rm_rf', arguments: {} } }, {}, '1')
  assert.strictEqual(badTool.error.code, -32602)
  pass('notifications get no answer; unknown methods and tools are errors')

  // --- the HTTP endpoint ---
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'isa-agents-'))
  const lockDir = path.join(home, '.isabelle-vscode', 'agents')
  const project = path.join(home, 'project')
  fs.mkdirSync(path.join(project, 'sub'), { recursive: true })
  const calls = []
  const stopped = []
  const handlers = Object.fromEntries(TOOL_DEFS.map(t => [t.name, async (args, token) => {
    calls.push([t.name, args])
    if (args.wait) {
      // Like a check that waits for the prover: only cancellation ends it
      await new Promise(resolve => token.onCancellationRequested(resolve))
      stopped.push(args.wait)
      return { text: 'Cancelled.', isError: true }
    }
    return args.fail ? { text: 'it failed', isError: true } : { text: `${t.name} on ${args.file}` }
  }]))
  const server = new McpHttpServer(handlers, '9.9', () => {}, lockDir)
  await server.start([project])
  const auth = { Authorization: `Bearer ${server.token}` }

  assert.strictEqual((await post(server.url, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401)
  assert.strictEqual((await post(server.url, { jsonrpc: '2.0', id: 1, method: 'ping' },
    { Authorization: 'Bearer wrong' })).status, 401)
  assert.strictEqual((await post(server.url, { jsonrpc: '2.0', id: 1, method: 'ping' },
    { ...auth, Origin: 'https://evil.example' })).status, 403)
  pass('the endpoint refuses requests without the token, and any from a web page')

  const called = await post(server.url, { jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'isabelle_check', arguments: { file: 'A.thy' } } }, auth)
  assert.strictEqual(called.status, 200)
  assert.deepStrictEqual(called.body.result.content, [{ type: 'text', text: 'isabelle_check on A.thy' }])
  assert.strictEqual(called.body.result.isError, false)
  const failed = await post(server.url, { jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: { name: 'isabelle_try', arguments: { fail: true } } }, auth)
  assert.strictEqual(failed.body.result.isError, true)
  const note = await post(server.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, auth)
  assert.strictEqual(note.status, 202)
  const batch = await post(server.url, [{ jsonrpc: '2.0', id: 9, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' }], auth)
  assert.strictEqual(batch.body.length, 1)
  assert.strictEqual((await post(server.url, '{not json', auth)).body.error.code, -32700)
  pass('tool calls answer with text content and isError; notifications 202; batches; parse errors')

  const dropped = postAbortable(server.url, { jsonrpc: '2.0', id: 10, method: 'tools/call',
    params: { name: 'isabelle_check', arguments: { wait: 'closed' } } }, auth)
  dropped.answer.catch(() => { /* aborted */ })
  assert.ok(await until(() => calls.some(c => c[1].wait === 'closed')), 'the call starts')
  dropped.abort()
  assert.ok(await until(() => stopped.includes('closed')), 'a closed connection cancels its call')
  const named = postAbortable(server.url, { jsonrpc: '2.0', id: 11, method: 'tools/call',
    params: { name: 'isabelle_check', arguments: { wait: 'named' } } }, auth)
  assert.ok(await until(() => calls.some(c => c[1].wait === 'named')), 'the call starts')
  const other = await post(server.url, { jsonrpc: '2.0', method: 'notifications/cancelled',
    params: { requestId: 12 } }, auth)
  assert.strictEqual(other.status, 202)
  assert.ok(!stopped.includes('named'), 'a cancellation of another request leaves it running')
  await post(server.url, { jsonrpc: '2.0', method: 'notifications/cancelled',
    params: { requestId: 11, reason: 'user' } }, auth)
  assert.strictEqual((await named.answer).result.isError, true)
  assert.ok(stopped.includes('named'))
  pass('a tool call is cancelled by closing its connection, or by notifications/cancelled')

  const lock = JSON.parse(fs.readFileSync(path.join(lockDir, `${process.pid}.json`), 'utf8'))
  assert.strictEqual(lock.url, server.url)
  assert.strictEqual(lock.token, server.token)
  assert.deepStrictEqual(lock.workspaceFolders, [project])
  pass('the lock file names the endpoint, its token and the workspace folders')

  // --- finding the window ---
  assert.strictEqual(findLock(path.join(project, 'sub'), lockDir).url, server.url)
  assert.strictEqual(findLock(project, lockDir).url, server.url)
  assert.strictEqual(findLock(home, lockDir), undefined, 'a folder outside the workspace has no window')
  assert.strictEqual(findLock(project + '-other', lockDir), undefined, 'a prefix is not a parent')
  const dead = path.join(lockDir, '99999991.json')
  fs.writeFileSync(dead, JSON.stringify({ ...lock, pid: 99999991, workspaceFolders: [path.join(project, 'sub')] }))
  assert.strictEqual(findLock(path.join(project, 'sub'), lockDir).url, server.url)
  assert.ok(!fs.existsSync(dead), 'the lock of a window that is gone is removed')
  const inner = path.join(lockDir, `${process.ppid}.json`)
  fs.writeFileSync(inner, JSON.stringify({ ...lock, pid: process.ppid, url: 'http://127.0.0.1:1/mcp',
    workspaceFolders: [path.join(project, 'sub')] }))
  assert.strictEqual(findLock(path.join(project, 'sub'), lockDir).url, 'http://127.0.0.1:1/mcp',
    'the window with the deeper folder wins')
  fs.rmSync(inner)
  pass('a directory finds the live window whose deepest workspace folder holds it')

  // --- the relay, as Claude Code runs it ---
  const env = { HOME: home, USERPROFILE: home }
  const r = relay({ ...env, ISABELLE_VSCODE_WORKSPACE: path.join(project, 'sub') })
  const rInit = await r.call('initialize', { protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'test', version: '0' } })
  assert.strictEqual(rInit.result.serverInfo.version, '9.9', 'initialize reaches the window')
  const rList = await r.call('tools/list', {})
  assert.strictEqual(rList.result.tools.length, 5)
  const rCall = await r.call('tools/call', { name: 'isabelle_state', arguments: { file: 'B.thy', line: 3 } })
  assert.strictEqual(rCall.result.content[0].text, 'isabelle_state on B.thy')
  assert.deepStrictEqual(calls[calls.length - 1], ['isabelle_state', { file: 'B.thy', line: 3 }])
  pass('the relay passes initialize, tools/list and tool calls to the window')

  const long = r.send('tools/call', { name: 'isabelle_check', arguments: { wait: 'relayed' } })
  let answered = false
  long.answer.then(() => { answered = true }, () => { /* never answered: right */ })
  const queued = r.send('tools/call', { name: 'isabelle_check', arguments: { wait: 'queued' } })
  queued.answer.then(() => { answered = true }, () => {})
  assert.ok(await until(() => calls.some(c => c[1].wait === 'relayed')), 'the call reaches the window')
  r.notify('notifications/cancelled', { requestId: queued.id })
  r.notify('notifications/cancelled', { requestId: long.id, reason: 'user' })
  assert.ok(await until(() => stopped.includes('relayed')), 'the window stops the call')
  const after = await r.call('tools/call', { name: 'isabelle_state', arguments: { file: 'C.thy' } })
  assert.strictEqual(after.result.content[0].text, 'isabelle_state on C.thy', 'the queue goes on')
  assert.ok(!calls.some(c => c[1].wait === 'queued'), 'a cancelled call in the queue never starts')
  assert.ok(!answered, 'a cancelled call gets no answer')
  r.close()
  pass('the relay cancels a call the agent cancels, under way or still queued')

  const lost = relay({ ...env, ISABELLE_VSCODE_WORKSPACE: os.tmpdir() })
  const lInit = await lost.call('initialize', { protocolVersion: '2025-06-18' })
  assert.strictEqual(lInit.result.serverInfo.name, 'isabelle')
  assert.strictEqual((await lost.call('tools/list', {})).result.tools.length, 5)
  const lCall = await lost.call('tools/call', { name: 'isabelle_check', arguments: { file: 'A.thy' } })
  assert.strictEqual(lCall.result.isError, true)
  assert.strictEqual(lCall.result.content[0].text, NO_WINDOW)
  lost.close()
  pass('without a window the relay still lists the tools, and a call says what to do')

  server.dispose()
  assert.ok(!fs.existsSync(path.join(lockDir, `${process.pid}.json`)), 'the lock goes with the endpoint')
  fs.rmSync(home, { recursive: true, force: true })
  pass('closing the endpoint removes its lock')

  // --- text ---
  assert.strictEqual(goalStatement(''), '')
  assert.strictEqual(goalStatement('rev (rev xs) = xs'), '\\<open>rev (rev xs) = xs\\<close>')
  assert.strictEqual(goalStatement('"A x" if "B x" for x'), '"A x" if "B x" for x')
  assert.strictEqual(goalStatement('\\<open>P\\<close>'), '\\<open>P\\<close>')
  assert.strictEqual(goalStatement('fixes x :: nat assumes "x > 0" shows "x \\<noteq> 0"'),
    'fixes x :: nat assumes "x > 0" shows "x \\<noteq> 0"')
  pass('a plain goal goes into a cartouche; a quoted or structured one stays as it is')

  const table = { encode: s => s.replace(/∀/g, '\\<forall>') }
  assert.deepStrictEqual(unicodeLines('lemma "\\<forall>x. P x"\nlemma "∀x. P x"\n(* café *)', table),
    ['line 2: literal Unicode; write it as\n    lemma "\\<forall>x. P x"', 'line 3: non-ASCII characters'])
  pass('literal Unicode is found by line, with its ASCII spelling where there is one')

  assert.deepStrictEqual(proofsOf(
    'cvc5: Try this: by (metis append_Nil2 rev_rev_ident) (12 ms)\n' +
    'zipperposition: Try this: by simp (0.4 ms)\n' +
    'e: Try this: by (smt (verit) foo) (> 1.0 s, timed out)\nvampire: No proof found'),
    ['by (metis append_Nil2 rev_rev_ident)', 'by simp', 'by (smt (verit) foo)'])
  pass('Sledgehammer\'s proofs are read without their timings')

  console.log(`\n${passed} checks passed`)
  console.log('SUITE63_OK')
}

module.exports = { run }
if (require.main === module) run().catch(err => { console.error(err); process.exit(1) })
