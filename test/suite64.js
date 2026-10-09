// The tools for AI agents against the prover: isabelle_check, _state, _try,
// _sledgehammer and _find_theorems on the extended server (PIDE/agent_*, vscode_agent.ML),
// called as an agent calls them -- through isabelle.agentCall, and once over the MCP
// endpoint with its token.
//
// The theory is never opened in an editor: an agent edits files on disk, so the tools
// have to get the prover to load and check it themselves (PIDE/check_theories).
//
// Runs against the stock distribution with the extended server; see test/server_target.js.
// Skips itself without one, so it is safe in any run.
const vscode = require('vscode')
const target_ = require('./server_target')
const assert = require('assert')
const fs = require('fs')
const http = require('http')
const { spawn } = require('child_process')
const path = require('path')

const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

async function until(what, seconds, probe, interval = 3000) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    if (what) console.log(`  ...${what} (${Math.round((deadline - Date.now()) / 1000)}s left)`)
    await wait(interval)
  }
  return undefined
}

const LINES = [
  'theory Agent_Tools',
  '  imports Main',
  'begin',
  '',
  'definition loopy :: "nat \\<Rightarrow> nat" where "loopy n = n"',
  'lemma loopy_loop: "loopy n = loopy (loopy n)" by (simp add: loopy_def)',
  '',
  'definition f :: "nat \\<Rightarrow> nat" where "f n = 0"',
  'lemma f_cond: "n > 5 \\<Longrightarrow> f n = 0" by (simp add: f_def)',
  '',
  '(* a comment with a literal ∀ *)',
  'lemma rr: "rev (rev xs) = xs"',
  '  by blast',
  '',
  'lemma in_proof:',
  '  fixes x :: nat',
  '  assumes "x > 3"',
  '  shows "x \\<noteq> 0"',
  'proof -',
  '  show ?thesis using assms by simp',
  'qed',
  '',
  'lemma app: "length (xs @ ys) = length ys + length xs"',
  '  apply (induct xs)',
  '   apply simp',
  '  apply simp',
  '  done',
  '',
  'end',
]
/** 1-based, as an agent counts. */
const at = prefix => LINES.findIndex(l => l.startsWith(prefix)) + 1

/** Starts an MCP stdio server as Claude Code does, and returns a call function. */
function stdioServer(command, args, cwd, env) {
  const clean = Object.fromEntries(Object.entries(process.env)
    .filter(([k]) => !k.startsWith('ELECTRON_') && !k.startsWith('VSCODE_')))
  const child = spawn(command, args, { cwd, env: { ...clean, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map()
  let buffer = ''
  let stderr = ''
  child.stderr.on('data', c => { stderr += c })
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
  const call = (method, params, seconds = 120) => new Promise((resolve, reject) => {
    const id = next++
    const timer = setTimeout(() => reject(new Error(`no answer to ${method}: ${stderr}`)), seconds * 1000)
    waiting.set(id, msg => { clearTimeout(timer); resolve(msg) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  return { call, close: () => child.stdin.end() }
}

async function run() {
  const target = target_.resolve()
  if (!target) {
    console.log('SKIP: ' + target_.skipReason())
    console.log('SUITE64_SKIPPED')
    return
  }
  console.log(target.label)

  const ext = vscode.extensions.getExtension('yfprojects.vscode-isabelle')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Agent_Tools.thy')
  const text = LINES.join('\n') + '\n'
  fs.writeFileSync(file, text, 'utf8')

  await target_.apply(target)
  await vscode.workspace.getConfiguration('isabelle').update('agents.enabled', true,
    vscode.ConfigurationTarget.Global)
  await vscode.commands.executeCommand('isabelle.restartServer')
  const server = await until('starting the extended server', 240, async () => {
    const s = await vscode.commands.executeCommand('isabelle.serverState')
    return s && s.state === 'Running' ? s : undefined
  })
  assert.ok(server && target_.matches(server, target), 'must be talking to the extended server')
  pass('language server runs against the extended server')

  const call = async (name, args) => {
    const started = Date.now()
    const result = await vscode.commands.executeCommand('isabelle.agentCall', name, args)
    console.log(`--- ${name} ${JSON.stringify(args).slice(0, 120)} (${((Date.now() - started) / 1000).toFixed(1)} s)` +
      `${result.isError ? ' [error]' : ''}\n${result.text}`)
    return result
  }

  // --- check: by relative path, never opened ---
  const checked = await call('isabelle_check', { file: 'Agent_Tools.thy', timeout_s: 240 })
  assert.ok(!checked.isError, 'check should answer')
  assert.match(checked.text, /checked, with errors/)
  assert.match(checked.text, /1 error\b/)
  assert.match(checked.text, new RegExp(`error at line ${at('  by blast')}:`))
  assert.match(checked.text, /goal[\s\S]*rev \(rev xs\) = xs/)
  assert.match(checked.text, new RegExp(`line ${at('(* a comment')}: literal Unicode; write it as[\\s\\S]*\\\\<forall>`))
  assert.ok(!vscode.workspace.textDocuments.some(d => d.uri.fsPath === file),
    'the theory is checked without being opened')
  pass('isabelle_check loads a theory nobody opened, and reports its error with the goal, in ASCII')

  // --- check: a theory being written has no end yet, and only an end consolidates ---
  // The sleep makes a check that ran it again take seconds rather than none.
  const draft = path.join(ws, 'Agent_Draft.thy')
  fs.writeFileSync(draft, ['theory Agent_Draft', '  imports Main', 'begin', '',
    'ML_val \\<open>OS.Process.sleep (Time.fromSeconds 6)\\<close>', '',
    'lemma "rev (rev xs) = xs"', '  by simp', ''].join('\n'), 'utf8')
  const timed = async args => {
    const started = Date.now()
    const result = await call('isabelle_check', args)
    return { result, seconds: (Date.now() - started) / 1000 }
  }
  const first = await timed({ file: 'Agent_Draft.thy', timeout_s: 120 })
  assert.match(first.result.text, /Agent_Draft\.thy: checked in/)
  assert.match(first.result.text, /has no end/)
  assert.ok(first.seconds >= 6, 'the first check waits for the theory')
  const again = await timed({ file: 'Agent_Draft.thy', timeout_s: 120 })
  assert.match(again.result.text, /checked in/)
  assert.ok(again.seconds < 2, `a checked theory is not checked again (${again.seconds} s)`)
  pass('a theory without end is checked once its commands are, and says it has no end')

  const opened = await vscode.window.showTextDocument(vscode.Uri.file(draft))
  await wait(1000)
  const inEditor = await timed({ file: draft, timeout_s: 120 })
  assert.match(inEditor.result.text, /checked in/)
  assert.ok(inEditor.seconds < 2, `opening a checked theory does not check it again (${inEditor.seconds} s)`)
  assert.strictEqual(vscode.window.activeTextEditor?.document, opened.document)
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
  pass('opening the checked theory in an editor does not check it again')

  // --- state ---
  const state = await call('isabelle_state', { file, line: at('   apply simp') })
  assert.match(state.text, /apply simp/)
  assert.match(state.text, /goal \(1 subgoal\)/)
  assert.match(state.text, /length \(\(a # xs\) @ ys\)|length \(xs @ ys\)/)
  const inner = await call('isabelle_state', { file, line: at('  show ?thesis') })
  assert.match(inner.text, /enclosing goal/, 'the goal of the lemma around the show')
  pass('isabelle_state gives the goals at a line and the enclosing ones')

  // --- try: the file's goal ---
  const before = fs.readFileSync(file, 'utf8')
  const tried = await call('isabelle_try', { file, line: at('  by blast'),
    candidates: ['by simp', 'by blast', 'apply (induct xs)', 'thm rev_rev_ident', 'sorry'] })
  assert.match(tried.text, /PROVED \(\d+ ms\): by simp/)
  assert.match(tried.text, /ERROR \(\d+ ms\): by blast/)
  assert.match(tried.text, /GOALS_LEFT \(\d+ ms\): apply \(induct xs\)[\s\S]*2 subgoals/)
  assert.match(tried.text, /OUTPUT \(\d+ ms\): thm rev_rev_ident\n\s+rev \(rev \?xs\) = \?xs/)
  assert.match(tried.text, /ERROR \(\d+ ms\): sorry\n\s+skips the proof/)
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'the file is not touched')
  const onLemma = await call('isabelle_try', { file, line: at('lemma rr'), candidates: ['by simp'] })
  assert.match(onLemma.text, /PROVED/, 'the line of a lemma means its goal')
  pass('isabelle_try tries candidates on the goal at a line, without editing the file')

  // --- try: a simp loop, and a watched rule ---
  const loop = await call('isabelle_try', { file, line: at('lemma rr'), goal: 'loopy 3 = 3',
    candidates: ['by (simp add: loopy_loop)'], timeout_s: 3 })
  assert.match(loop.text, /TIMEOUT/)
  assert.match(loop.text, /loopy_loop x\d+/)
  assert.match(loop.text, /cycle: loopy_loop/)
  pass('a simp loop comes back as a timeout with its rule and cycle')

  const watched = await call('isabelle_try', { file, line: at('lemma rr'), goal: 'f m = 0',
    candidates: ['by (simp add: f_cond)'], watch_rules: ['f_cond'] })
  assert.match(watched.text, /f_cond \[condition failed\]/)
  assert.match(watched.text, /5 < m \\<Longrightarrow> f m \\<equiv> 0/)
  assert.match(watched.text, /premises as simp saw them:\n\s+5 < m/)
  pass('a watched conditional rule shows its instance, its premise and that the condition failed')

  // --- try: goals of one's own ---
  const own = await call('isabelle_try', { file, line: at('  show ?thesis'), goal: 'x > 1',
    candidates: ['using assms by simp', 'by simp'] })
  assert.match(own.text, /goal tried:[\s\S]*(x > 1|1 < x)/)
  assert.match(own.text, /PROVED \(\d+ ms\): using assms by simp/, 'the proof\'s fixes and assumptions are there')
  assert.match(own.text, /ERROR \(\d+ ms\): by simp/)
  const helper = await call('isabelle_try', { file, line: at('lemma app'),
    goal: 'rev (xs @ ys) = rev ys @ rev xs', candidates: ['by simp'] })
  assert.match(helper.text, /PROVED/)
  const badGoal = await call('isabelle_try', { file, line: at('lemma app'),
    goal: 'True \\<and>', candidates: ['by simp'] })
  assert.ok(badGoal.isError && /could not be stated/.test(badGoal.text))
  pass('isabelle_try states goals of one\'s own, in a proof and at the theory level')

  // --- find_theorems ---
  const found = await call('isabelle_find_theorems', { file, query: '"rev (rev _)"' })
  // The theory's own rr states the library's rev_rev_ident again, which find_theorems drops
  assert.match(found.text, /found \d+ theorem\(s\)[\s\S]*rev \(rev \?xs\) = \?xs/)
  pass('isabelle_find_theorems searches the facts at the end of the theory')

  // --- sledgehammer ---
  const hammered = await call('isabelle_sledgehammer', { file, line: at('  by blast'), timeout_s: 20 })
  if (/that check:/.test(hammered.text)) {
    assert.match(hammered.text, /by /)
    pass('isabelle_sledgehammer finds proofs and checks them')
  } else {
    console.log('NOTE: Sledgehammer found nothing that checks here (provers missing?)')
  }

  /* A job of its own (vscode_sledgehammer.ML): editing the command it runs on, which ended
     the old query, leaves it running. The lemma's statement is written differently a moment
     into the run -- a new command for the prover, with the same goal. */
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const appLine = at('lemma app') - 1
  const restate = async (from, to) => {
    const col = doc.lineAt(appLine).text.indexOf(from)
    const we = new vscode.WorkspaceEdit()
    we.replace(doc.uri, new vscode.Range(appLine, col, appLine, col + from.length), to)
    assert.ok(await vscode.workspace.applyEdit(we))
  }
  const editedRun = call('isabelle_sledgehammer', { file, line: at('lemma app'), timeout_s: 20 })
  await wait(1500)
  await restate('length ys + length xs"', 'length ys + length (xs)"')
  const edited = await editedRun
  await restate('length ys + length (xs)"', 'length ys + length xs"')
  assert.ok(!edited.isError, 'the run should not end with the edit')
  assert.ok(!/changed at this position/.test(edited.text))
  if (/that check:/.test(edited.text)) pass('isabelle_sledgehammer goes on while its command is edited')
  else console.log('NOTE: no proof that checks after the edit (provers missing?)')

  /* A call the agent cancels cancels its job: the two calls after it, at once, run side by
     side rather than one of them waiting for the cancelled run's slot until its timeout. */
  const hard = '(x::nat) ^ 3 + y ^ 3 \\<noteq> z ^ 3 \\<or> x * y * z = 0'
  const cancelledAt = Date.now()
  const cancelled = await vscode.commands.executeCommand('isabelle.agentCall', 'isabelle_sledgehammer',
    { file, line: at('lemma app'), goal: hard, timeout_s: 40 }, 4000)
  assert.ok(cancelled.isError && /Cancelled/.test(cancelled.text), 'the call should be cancelled')
  assert.ok(Date.now() - cancelledAt < 10000, 'at once')
  const twoAt = Date.now()
  const [one, two] = await Promise.all([
    call('isabelle_sledgehammer', { file, line: at('lemma rr'), timeout_s: 15 }),
    call('isabelle_sledgehammer', { file, line: at('lemma app'), timeout_s: 15 }),
  ])
  const both = (Date.now() - twoAt) / 1000
  assert.ok(!one.isError && !two.isError, 'both calls should answer')
  assert.ok(both < 30, `side by side, and no slot held by the cancelled run (${both.toFixed(1)} s)`)
  pass(`a cancelled call frees its slot, and two calls run at once (${both.toFixed(1)} s)`)

  // --- the endpoint, as Copilot or the relay reach it ---
  const endpoint = await vscode.commands.executeCommand('isabelle.agentEndpoint')
  assert.ok(endpoint.url && endpoint.token, 'the endpoint runs while the setting is on')
  assert.ok(fs.existsSync(endpoint.relay), 'the relay is installed in global storage')
  const reply = await new Promise((resolve, reject) => {
    const req = http.request(endpoint.url, { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.token}` } }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve(JSON.parse(data)))
    })
    req.on('error', reject)
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'isabelle_state', arguments: { file, line: at('  done') } } }))
  })
  assert.match(reply.result.content[0].text, /done/)
  pass('the MCP endpoint answers a tool call')

  // --- Claude Code's way in: the .mcp.json the setup writes, and the relay it starts ---
  const mcpFile = path.join(ws, '.mcp.json')
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { other: { command: 'other-server' } } }))
  await vscode.commands.executeCommand('isabelle.agentSetUpFiles', ws, ['mcp', 'copilot'])
  await vscode.commands.executeCommand('isabelle.agentSetUpFiles', ws, ['copilot'])
  const mcp = JSON.parse(fs.readFileSync(mcpFile, 'utf8'))
  assert.deepStrictEqual(mcp.mcpServers.other, { command: 'other-server' }, 'other servers are kept')
  const entry = mcp.mcpServers.isabelle
  assert.strictEqual(entry.type, 'stdio')
  assert.strictEqual(entry.args[0], endpoint.relay, '.mcp.json names the installed relay')
  const instructions = fs.readFileSync(path.join(ws, '.github', 'copilot-instructions.md'), 'utf8')
  assert.strictEqual(instructions.split('<!-- isabelle-vscode:agents -->').length, 2,
    'the guide is in the Copilot instructions once, however often the setup runs')
  assert.match(instructions, /isabelle_check/)
  pass('the setup merges its server into .mcp.json and its guide into the Copilot instructions')

  const relay = stdioServer(entry.command, entry.args, ws, entry.env)
  const init = await relay.call('initialize', { protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'suite64', version: '0' } })
  assert.strictEqual(init.result.serverInfo.name, 'isabelle')
  assert.match(init.result.instructions, /isabelle_check/)
  const tools = await relay.call('tools/list', {})
  assert.strictEqual(tools.result.tools.length, 5)
  const viaRelay = await relay.call('tools/call',
    { name: 'isabelle_check', arguments: { file: 'Agent_Tools.thy' } })
  console.log('--- via the relay:\n' + viaRelay.result.content[0].text)
  assert.ok(!viaRelay.result.isError)
  assert.match(viaRelay.result.content[0].text, /1 error\b/)
  relay.close()
  pass(`the relay that .mcp.json starts (${path.basename(entry.command)}) reaches this window's prover`)
  fs.rmSync(mcpFile, { force: true })
  fs.rmSync(path.join(ws, '.github'), { recursive: true, force: true })

  await vscode.workspace.getConfiguration('isabelle').update('agents.enabled', undefined,
    vscode.ConfigurationTarget.Global)
  assert.ok(await until(undefined, 10, async () =>
    !(await vscode.commands.executeCommand('isabelle.agentEndpoint')).url, 500),
    'turning the setting off stops the endpoint')
  pass('the endpoint stops with the setting')

  await target_.reset(target)
  fs.rmSync(file, { force: true })
  fs.rmSync(draft, { force: true })

  console.log(`\n${passed} checks passed`)
  console.log('SUITE64_OK')
}

module.exports = { run }
