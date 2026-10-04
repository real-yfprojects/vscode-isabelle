// Checking goes on while Sledgehammer runs: vscode_sledgehammer.ML on the extended server.
//
// HOL runs the panel's query at the priority of the theory execution, and Sledgehammer
// queues 24 prover slices per worker thread at once, each holding its worker while an
// external prover runs. A command edited meanwhile was checked only after all of them, so
// for the rest of the run (about 20 s here) the editor showed nothing new. The server now
// loads that query at a lower priority. This runs Sledgehammer on a goal it cannot prove,
// so that it takes its whole timeout, breaks a later command while it runs, and checks
// that the error arrives before Sledgehammer finishes.
//
// Runs against a patched Isabelle or against the stock one with the extended server; see
// test/server_target.js. Skips itself when there is neither, so it is safe in any run.
const vscode = require('vscode')
const target_ = require('./server_target')
const assert = require('assert')
const fs = require('fs')
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
  'theory Hammer_Busy',
  '  imports Main',
  'begin',
  '',
  'lemma hard: "(\\<forall>x::nat. P x \\<longrightarrow> Q (f x)) \\<Longrightarrow> R"',
  '  sorry',
  '',
  'lemma l2: "True" by simp',
  '',
  'lemma l3: "1 + (1::nat) = 2" by simp',
  '',
  'end',
]
const HARD = LINES.findIndex(l => l.startsWith('lemma hard'))
const L2 = LINES.findIndex(l => l.startsWith('lemma l2'))
const L3 = LINES.findIndex(l => l.startsWith('lemma l3'))

const hammer = () => vscode.commands.executeCommand('isabelle.sledgehammerState')
const running = s => !!s && /Sledgehammering/.test(s.status)

const hasError = (uri, line) => vscode.languages.getDiagnostics(uri).some(d =>
  d.severity === vscode.DiagnosticSeverity.Error && d.range.start.line === line)

/** Replace `from` by `to` on `line`, and wait until the line's error matches the change. */
async function edit(editor, line, from, to, seconds) {
  const col = editor.document.lineAt(line).text.indexOf(from)
  assert.ok(col >= 0, `${from} not on line ${line}`)
  const start = Date.now()
  await editor.edit(b => b.replace(new vscode.Range(line, col, line, col + from.length), to))
  const broken = to.includes('FOO')
  const ok = await until(undefined, seconds,
    async () => hasError(editor.document.uri, line) === broken, 200)
  return ok ? (Date.now() - start) / 1000 : undefined
}

async function run() {
  const target = target_.resolve()
  if (!target) {
    console.log('SKIP: ' + target_.skipReason())
    console.log('SUITE53_SKIPPED')
    return
  }
  console.log(target.label)

  const ext = vscode.extensions.getExtension('yfprojects.vscode-isabelle')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Hammer_Busy.thy')
  fs.writeFileSync(file, LINES.join('\n') + '\n', 'utf8')

  await target_.apply(target)
  await vscode.commands.executeCommand('isabelle.restartServer')

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  editor.selection = new vscode.Selection(HARD, 0, HARD, 0)

  const server = await until('restarting against the extended server', 240, async () => {
    const s = await vscode.commands.executeCommand('isabelle.serverState')
    return s && s.state === 'Running' ? s : undefined
  })
  assert.ok(server, 'the server should start')
  assert.ok(target_.matches(server, target), 'must be talking to the extended server')
  pass('language server runs against the extended server')

  // Without Sledgehammer: also waits for the theory to be checked as far as l3.
  const before = await edit(editor, L3, 'by simp', 'by FOO', 240)
  assert.ok(before !== undefined, 'breaking l3 should show an error')
  assert.ok(await edit(editor, L3, 'by FOO', 'by simp', 60) !== undefined,
    'repairing l3 should clear its error')
  pass(`an edit is checked in ${before.toFixed(1)}s without Sledgehammer`)

  // On the lemma itself, whose state has the goal; after sorry there is none.
  await vscode.commands.executeCommand('isabelle-sledgehammer.focus')
  editor.selection = new vscode.Selection(HARD, 0, HARD, 0)
  await wait(1500)
  await vscode.commands.executeCommand('isabelle.sledgehammer')
  const started = await until('Sledgehammer starting', 60, async () => running(await hammer()), 500)
  assert.ok(started, 'Sledgehammer should start on the lemma')
  pass('Sledgehammer runs on the unprovable lemma')

  /* The provers are scheduled after the relevance filter, a few seconds in; an edit made
     before that was checked promptly even without the fix. So edit twice, and require both
     checks to arrive within 10 s while Sledgehammer still runs. */
  await wait(3000)
  const checks = []
  for (const [line, name] of [[L3, 'l3'], [L2, 'l2']]) {
    const secs = await edit(editor, line, 'by simp', 'by FOO', 10)
    const state = await hammer()
    checks.push({ name, secs, during: running(state), status: state && state.status })
    console.log(`  breaking ${name}: ${secs === undefined ? 'not checked within 10s' :
      `checked after ${secs.toFixed(1)}s`}, Sledgehammer: ${state && state.status}`)
  }
  for (const c of checks) {
    assert.ok(c.secs !== undefined,
      `breaking ${c.name} should be checked while Sledgehammer runs, not after it`)
  }
  if (checks[checks.length - 1].during) {
    pass('edits near the caret are checked while Sledgehammer runs')
  } else {
    // Over before the provers held the workers for long: nothing to compare against.
    console.log('NOTE: Sledgehammer finished early (provers missing?); timing not asserted')
  }

  const finished = async () => { const s = await hammer(); return s && s.status === 'Finished' }
  assert.ok(await until('Sledgehammer finishing', 90, finished), 'Sledgehammer should finish')

  /* The run is a task of its own now, forked from the print's: Cancel must still reach it
     and its slices, as subtasks of the print's exec. */
  editor.selection = new vscode.Selection(HARD, 0, HARD, 0)
  await wait(1000)
  await vscode.commands.executeCommand('isabelle.sledgehammer')
  assert.ok(await until(undefined, 60, async () => running(await hammer()), 500),
    'Sledgehammer should start again')
  await wait(5000)
  const cancelled = Date.now()
  await vscode.commands.executeCommand('isabelle.sledgehammerCancel')
  assert.ok(await until(undefined, 10, finished, 250), 'Cancel should end the run')
  pass(`Cancel ends the run in ${((Date.now() - cancelled) / 1000).toFixed(1)}s`)

  // And it still finds proofs: on a goal that it can prove, a proof is offered.
  await editor.edit(b => b.insert(new vscode.Position(L3 + 2, 0),
    'lemma easy: "P \\<longrightarrow> P"\n  sorry\n\n'))
  const EASY = L3 + 2
  editor.selection = new vscode.Selection(EASY, 0, EASY, 0)
  await wait(3000)
  await vscode.commands.executeCommand('isabelle.sledgehammer')
  await until(undefined, 60, async () => running(await hammer()), 500)
  assert.ok(await until('Sledgehammer proving', 90, finished), 'Sledgehammer should finish')
  const proved = await hammer()
  console.log('output: ' + String(proved.output).replace(/\s+/g, ' ').slice(0, 300))
  assert.match(String(proved.output), /Try this|found a proof/, 'a proof should be offered')
  pass('Sledgehammer still finds a proof')

  await target_.reset(target)
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  fs.rmSync(file, { force: true })

  console.log(`\n${passed} checks passed`)
  console.log('SUITE53_OK')
}

module.exports = { run }
