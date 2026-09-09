// End-to-end checks for the Simplifier Trace and Graph View, against a real prover.
//
// Everything else covering these two is a unit test over a fixture. This is the suite
// that answers the only question that matters for a protocol: does the server actually
// send what the client expects to receive? The messages were written against the jEdit
// dockables and the Isabelle sources, which is exactly the kind of reading that is
// convincing and wrong.
//
// Needs a patched Isabelle carrying both components; skips itself otherwise, so it is
// safe in the default regression set. Point ISABELLE_PATCHED_HOME at one:
//
//   ISABELLE_PATCHED_HOME=C:/Users/yanni/Isabelle/Isabelle2025-2-query \
//     node test/runTest.js suite30.js
const vscode = require('vscode')
const assert = require('assert')
const path = require('path')

const EXT_ID = 'spike.isabelle-pide-stock'
const wait = ms => new Promise(r => setTimeout(r, ms))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

/**
 * Poll until `predicate` returns something.
 *
 * `describe` reports what was actually seen when it times out. Without it the failure
 * reads "timed out waiting for a graph: undefined", which says only that the thing did
 * not happen -- not whether the panel exists, whether the server ever answered, or
 * whether it answered with an empty graph. Those three need different fixes.
 */
async function pollFor(what, predicate, timeoutMs, describe = undefined, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs
  let last
  let seen
  while (Date.now() < deadline) {
    try { last = await predicate() } catch { last = undefined }
    if (last !== undefined && last !== false) return last
    if (describe !== undefined) { try { seen = await describe() } catch { /* ignore */ } }
    await wait(intervalMs)
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${what}; last state: ${JSON.stringify(seen)}`)
}

/* Settings this suite writes into the workspace, so they can be taken back out again.
   ConfigurationTarget.Workspace means .vscode/settings.json in the *workspace folder*.
   Under runAll that is a per-suite temp copy and nobody notices, but run directly it is
   test/workspace -- and a committed one pins every other machine to this machine's
   absolute isabelle.home. That is not hypothetical: CI read
   "C:/Users/.../Isabelle2025-2-query" on a Linux runner and every prover suite failed. */
const WRITTEN_SETTINGS = ['home', 'simplifierTrace', 'graphview', 'autoStart']

async function run() {
  try { await drive() }
  finally {
    const cfg = vscode.workspace.getConfiguration('isabelle')
    for (const key of WRITTEN_SETTINGS) {
      try { await cfg.update(key, undefined, vscode.ConfigurationTarget.Workspace) }
      catch { /* leaving one behind must not mask the real failure */ }
    }
  }
}

async function drive() {
  const home = process.env.ISABELLE_PATCHED_HOME
  if (!home) {
    console.log('SKIP: ISABELLE_PATCHED_HOME is not set; no patched Isabelle to drive')
    console.log('SUITE30_OK')
    return
  }

  const ext = vscode.extensions.getExtension(EXT_ID)
  assert.ok(ext, `extension ${EXT_ID} not found`)

  // Both panels are off by default, because their messages exist only on the patched
  // branches. Turn them on, point at the patched build, and restart into it.
  const cfg = vscode.workspace.getConfiguration('isabelle')
  await cfg.update('home', home, vscode.ConfigurationTarget.Workspace)
  await cfg.update('simplifierTrace', true, vscode.ConfigurationTarget.Workspace)
  await cfg.update('graphview', true, vscode.ConfigurationTarget.Workspace)
  await cfg.update('autoStart', true, vscode.ConfigurationTarget.Workspace)
  await ext.activate()
  await vscode.commands.executeCommand('isabelle.restartServer')

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const uri = vscode.Uri.file(path.join(ws, 'Trace.thy'))
  const doc = await vscode.workspace.openTextDocument(uri)
  const editor = await vscode.window.showTextDocument(doc)

  // A heap load plus checking; generous, because this is the one suite that pays for a
  // real session.
  await pollFor('the server to reach Running',
    async () => (await vscode.commands.executeCommand('isabelle.serverState'))?.state === 'Running',
    240000, () => vscode.commands.executeCommand('isabelle.serverState'))
  pass('the patched server starts and reaches Running')

  // --- simplifier trace ------------------------------------------------------------
  // Put the caret in the traced lemma. The panel follows the caret, exactly as the jEdit
  // dockable does, so this is what makes a question appear.
  const lemmaLine = doc.getText().split(/\r?\n/).findIndex(l => l.includes('by simp'))
  assert.ok(lemmaLine > 0, 'fixture should contain a "by simp"')
  editor.selection = new vscode.Selection(lemmaLine, 2, lemmaLine, 2)
  await vscode.commands.executeCommand('isabelle.simplifierTrace')

  /* The response arriving is only the protocol handshake -- the server answers a
     request immediately, long before Trace.thy has been elaborated, so `supported`
     alone proves nothing about the trace. What must be waited for is a *question*,
     which exists only once the simplifier has actually suspended.

     On timeout the Output panel is what separates the two possible faults: it carries
     the prover's own "See simplifier trace" active area when a step is genuinely
     asking, so text there with no question means the client is failing to pick the
     question up, and no text means the prover never asked. */
  const describeTrace = async () => ({
    trace: await vscode.commands.executeCommand('isabelle.simplifierTraceState'),
    output: String(await vscode.commands.executeCommand('isabelle.outputPanelContent') ?? '')
      .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
  })

  const traceState = await pollFor('a pending simplifier trace question',
    async () => {
      const s = await vscode.commands.executeCommand('isabelle.simplifierTraceState')
      return s && s.supported && s.serial !== undefined ? s : undefined
    }, 180000, describeTrace)
  pass('the server answers PIDE/simplifier_trace_request with a parsable response')

  assert.ok(traceState.answers.length > 0, 'a question must offer answers')
  // Answers come from the prover; these are Simplifier_Trace.Answer.step's names.
  assert.ok(traceState.answers.includes('continue'),
    `a rewrite step should offer continue: ${traceState.answers}`)
  console.log(`  (question ${traceState.serial}, answers: ${traceState.answers.join(', ')})`)
  pass("a suspended simplifier reports a question with the prover's own answers")

  /* --- the three messages the request/reply triangle does not touch ---------------
     `show` re-assembles the trace from Command.Results by a different server path than
     the question takes (generate_trace, not the manager's context), so it can be broken
     while questions work perfectly. */
  await vscode.commands.executeCommand('isabelle.simplifierTraceShow')
  const full = await pollFor('the full trace to arrive',
    async () => {
      const s = await vscode.commands.executeCommand('isabelle.simplifierTraceState')
      return s && s.full !== undefined ? s : undefined
    }, 60000, describeTrace)
  assert.ok(full.full > 0, `a traced proof should have trace entries, got ${full.full}`)
  console.log(`  (full trace: ${full.full} entries)`)
  pass('simplifier_trace_show returns the assembled trace, not just the question')

  /* Auto-update is the one piece of state the client cannot infer: it lives on the
     server and comes back only in the response. Both edges have to publish, or the
     panel's checkbox silently disagrees with the server after being turned off. */
  await vscode.commands.executeCommand('isabelle.simplifierTraceAutoUpdate', false)
  const off = await pollFor('auto-update to report itself off',
    async () => {
      const s = await vscode.commands.executeCommand('isabelle.simplifierTraceState')
      return s && s.autoUpdate === false ? s : undefined
    }, 30000, describeTrace)
  assert.strictEqual(off.autoUpdate, false)
  await vscode.commands.executeCommand('isabelle.simplifierTraceAutoUpdate', true)
  const on = await pollFor('auto-update to report itself on',
    async () => {
      const s = await vscode.commands.executeCommand('isabelle.simplifierTraceState')
      return s && s.autoUpdate === true ? s : undefined
    }, 30000, describeTrace)
  assert.strictEqual(on.autoUpdate, true)
  pass('auto-update round-trips in both directions')

  /* clear_memory republishes state identical to what is already shown, so the only
     observable is that a response came back at all -- hence the counter. This checks
     the server accepted the message and refreshed; it does NOT verify that the
     simplifier's memoised answers were actually discarded, which would need a proof
     with repeated equivalent rewrites and a re-run of the command. */
  const before = (await vscode.commands.executeCommand('isabelle.simplifierTraceState')).responses
  await vscode.commands.executeCommand('isabelle.simplifierTraceClearMemory')
  await pollFor('a response after clear_memory',
    async () => {
      const s = await vscode.commands.executeCommand('isabelle.simplifierTraceState')
      return s && s.responses > before ? s : undefined
    }, 30000, describeTrace)
  pass('clear_memory is accepted and republishes')

  /* Answering is the half that a read-only panel would never exercise: the reply has to
     reach Simplifier_Trace's manager, quote a serial it recognises, and unblock the ML
     future. If it does not, the question simply stays put. */
  await vscode.commands.executeCommand('isabelle.simplifierTraceReply',
    traceState.serial, 'continue_disable')
  const answered = await pollFor('the question to clear after answering',
    async () => {
      const s = await vscode.commands.executeCommand('isabelle.simplifierTraceState')
      return s && s.serial !== traceState.serial ? s : undefined
    }, 60000, describeTrace)
  console.log(`  (after continue_disable: serial ${answered.serial}, pending ${answered.pending})`)
  pass('answering unblocks the simplifier instead of leaving the question pending')

  // --- graph view ------------------------------------------------------------------
  /* A separate theory, because the traced proof in Trace.thy suspends the simplifier
     and nothing after a suspended command in the same file is ever processed. */
  const depsDoc = await vscode.workspace.openTextDocument(
    vscode.Uri.file(path.join(ws, 'Deps.thy')))
  const depsEditor = await vscode.window.showTextDocument(depsDoc)

  const depsLine = depsDoc.getText().split(/\r?\n/).findIndex(l => l.trim() === 'thy_deps')
  assert.ok(depsLine > 0, 'Deps.thy should contain a thy_deps command')
  depsEditor.selection = new vscode.Selection(depsLine, 0, depsLine, 0)
  await vscode.commands.executeCommand('isabelle.graphview')

  /* If this times out, the Output panel says which half is at fault: text from the
     command means the results reached the client and the server's search is wrong;
     nothing means the command never ran. */
  const describeGraph = async () => ({
    graph: await vscode.commands.executeCommand('isabelle.graphviewState'),
    output: String(await vscode.commands.executeCommand('isabelle.outputPanelContent') ?? '')
      .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
  })

  const graph = await pollFor('a graph from thy_deps',
    async () => {
      const s = await vscode.commands.executeCommand('isabelle.graphviewState')
      return s && s.supported && s.nodes > 0 ? s : undefined
    }, 180000, describeGraph)

  assert.strictEqual(graph.error, undefined, `graph decode failed: ${graph.error}`)
  // Main's import graph. The exact size is Isabelle's business, but a real thy_deps is
  // not two nodes, and every node bar the roots has a parent.
  assert.ok(graph.nodes > 10, `thy_deps should produce a real graph, got ${graph.nodes} nodes`)
  assert.ok(graph.edges > 10, `thy_deps should produce real edges, got ${graph.edges}`)
  console.log(`  (thy_deps: ${graph.nodes} nodes, ${graph.edges} edges)`)
  pass('thy_deps output is found in command results, decoded and published')

  // Moving off the command must clear it, or a stale graph reads as current.
  depsEditor.selection = new vscode.Selection(0, 0, 0, 0)
  const cleared = await pollFor('the graph to clear when the caret moves away',
    async () => {
      const s = await vscode.commands.executeCommand('isabelle.graphviewState')
      return s && s.nodes === 0 ? s : undefined
    }, 60000, () => vscode.commands.executeCommand('isabelle.graphviewState'))
  assert.strictEqual(cleared.nodes, 0)
  pass('moving the caret off the command clears the graph instead of leaving it stale')

  console.log(passed + ' checks passed')
  console.log('SUITE30_OK')
}

module.exports = { run }
