// End-to-end test of the Theories and Timing views against a PATCHED Isabelle.
//
// Needs a server that answers PIDE/theories_request -- the vscode-theories-panel branch
// of mirror-isabelle. Point ISABELLE_PATCHED_HOME (or ISABELLE_QUERY_HOME) at such a
// build; the suite skips itself otherwise, so a normal run is unaffected.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }
const theoriesState = () => vscode.commands.executeCommand('isabelle.theoriesState')

/** Poll for a condition rather than sleeping through a worst case. */
async function until(what, seconds, probe) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    console.log(`  ...${what} (${Math.round((deadline - Date.now()) / 1000)}s left)`)
    await wait(2000)
  }
  return undefined
}

async function run() {
  const home = process.env.ISABELLE_PATCHED_HOME || process.env.ISABELLE_QUERY_HOME
  if (!home) {
    console.log('SKIP: no patched Isabelle (set ISABELLE_PATCHED_HOME)')
    console.log('SUITE17_SKIPPED')
    return
  }
  console.log('patched Isabelle: ' + home)

  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'T.thy')
  fs.writeFileSync(file, [
    'theory T',
    '  imports Main',
    'begin',
    '',
    'lemma t1: "(2::nat) ^ 10 = 1024"',
    '  by simp',
    '',
    'lemma t2: "rev (rev xs) = xs"',
    '  by (induct xs) auto',
    '',
    'lemma t3: "(n::nat) + 0 = n"',
    '  by simp',
    '',
    'end',
    '',
  ].join('\n'), 'utf8')

  const cfg = vscode.workspace.getConfiguration('isabelle')
  await cfg.update('home', home, vscode.ConfigurationTarget.Global)
  await cfg.update('theoriesPanel', true, vscode.ConfigurationTarget.Global)
  // 0 keeps every command that took at least a millisecond, so the Timing view has
  // something to show for a small theory.
  await cfg.update('timingThreshold', 0, vscode.ConfigurationTarget.Global)
  await vscode.commands.executeCommand('isabelle.restartServer')

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })

  const server = await until('restarting against the patched build', 240, async () => {
    const s = await vscode.commands.executeCommand('isabelle.serverState')
    return s && s.state === 'Running' ? s : undefined
  })
  assert.ok(server, 'the patched Isabelle should start')
  console.log('isabelle home in use: ' + server.isabelleHome)
  assert.strictEqual(server.isabelleHome, home, 'must be talking to the patched build')
  pass('language server runs against the patched build')

  // Nudge PIDE into processing this file.
  editor.selection = new vscode.Selection(5, 2, 5, 2)

  const st = await until('waiting for a theories status', 240, async () => {
    const s = await theoriesState()
    return s && s.supported && s.nodes.length > 0 ? s : undefined
  })
  assert.ok(st, 'the server should answer PIDE/theories_request')
  console.log(`phase=${st.phase} threshold=${st.threshold} nodes=${st.nodes.length}`)
  pass('server reports theory status over PIDE/theories_response')

  assert.ok(typeof st.phase === 'string' && st.phase.length > 0, 'phase should be reported')
  assert.strictEqual(st.threshold, 0, 'the client threshold should reach the server')

  const ours = st.nodes.find(n => n.theory === 'T' || n.theory.endsWith('.T'))
  assert.ok(ours, `T should be listed; got ${st.nodes.map(n => n.theory).join(', ')}`)
  assert.ok(ours.total > 0, 'T should have commands')
  console.log(`T: total=${ours.total} finished=${ours.finished} percentage=${ours.percentage}`)
  pass('the edited theory appears with per-command counts')

  const finished = await until('waiting for T to be processed', 240, async () => {
    const s = await theoriesState()
    const n = s && s.nodes.find(x => x.theory === 'T' || x.theory.endsWith('.T'))
    return n && n.percentage === 100 ? { s, n } : undefined
  })
  assert.ok(finished, 'T should reach 100%')
  assert.strictEqual(finished.n.failed, 0, 'the theory has no failing proof')
  pass('status converges to 100% with no failures')

  // Timing: command entries arrive for the theory the caret is in.
  const timed = await until('waiting for command timings', 120, async () => {
    const s = await theoriesState()
    return s && s.commands.length > 0 ? s : undefined
  })
  assert.ok(timed, 'the current theory should report command timings')
  assert.ok(timed.current && timed.current.endsWith('T.thy'),
    `current should be T.thy, got ${timed && timed.current}`)
  const byTime = [...timed.commands].sort((a, b) => b.time - a.time)
  console.log('commands: ' + byTime.map(c => `${c.name}@${c.time}s`).join(', '))
  assert.ok(byTime[0].time > 0, 'a command timing should be positive')
  pass('Timing reports per-command times for the current theory')

  // The incoming half of PIDE/caret_update: goto_command must actually move the caret.
  // Park it at line 0 and navigate to a command that is not the theory header -- that
  // header starts at line 0 itself, so using it would make the assertion vacuous.
  const target = byTime.find(c => c.name !== 'theory') || byTime[0]
  console.log(`navigating to ${target.name} (${target.time}s)`)
  editor.selection = new vscode.Selection(0, 0, 0, 0)
  await wait(300)
  // PIDE/goto_command is fire-and-forget and the server drops it while the snapshot is
  // outdated (a caret move is itself a perspective edit), so ask again on each poll.
  const moved = await until('waiting for the caret to be moved by the server', 30, async () => {
    await vscode.commands.executeCommand('isabelle.gotoCommand', target.id)
    await wait(500)
    const active = vscode.window.activeTextEditor
    if (!active || !active.document.uri.fsPath.endsWith('T.thy')) return undefined
    return active.selection.active.line !== 0 ? active.selection.active : undefined
  })
  assert.ok(moved, 'PIDE/goto_command should relocate the caret via PIDE/caret_update')
  console.log(`caret moved to line ${moved.line}`)
  pass('incoming PIDE/caret_update moves the editor (Locate now works)')

  console.log(`${passed} checks passed`)
  console.log('SUITE17_OK')
}

module.exports.run = () => run().catch(err => {
  console.error('FAIL: ' + (err && err.stack || err))
  process.exit(1)
})
