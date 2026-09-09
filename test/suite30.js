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

async function pollFor(what, predicate, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try { last = await predicate() } catch { last = undefined }
    if (last !== undefined && last !== false) return last
    await wait(intervalMs)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}: ${JSON.stringify(last)}`)
}

async function run() {
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
    240000)
  pass('the patched server starts and reaches Running')

  // --- simplifier trace ------------------------------------------------------------
  // Put the caret in the traced lemma. The panel follows the caret, exactly as the jEdit
  // dockable does, so this is what makes a question appear.
  const lemmaLine = doc.getText().split(/\r?\n/).findIndex(l => l.includes('by simp'))
  assert.ok(lemmaLine > 0, 'fixture should contain a "by simp"')
  editor.selection = new vscode.Selection(lemmaLine, 2, lemmaLine, 2)
  await vscode.commands.executeCommand('isabelle.simplifierTrace')

  const traceState = await pollFor('the server to answer simplifier_trace_request',
    async () => {
      const s = await vscode.commands.executeCommand('isabelle.simplifierTraceState')
      return s && s.supported ? s : undefined
    }, 120000)
  // The response arriving at all is the protocol check: the server understood the
  // request, produced the shape the client parses, and the notification round-tripped.
  pass('the server answers PIDE/simplifier_trace_request with a parsable response')

  // A suspended simplifier is timing-dependent -- the question exists only while the
  // proof is blocked -- so a question is reported when present rather than required.
  if (traceState.serial !== undefined) {
    assert.ok(traceState.answers.length > 0, 'a question must offer answers')
    // Answers come from the prover; these are Simplifier_Trace.Answer.step's names.
    assert.ok(traceState.answers.includes('continue'),
      `a rewrite step should offer continue: ${traceState.answers}`)
    console.log(`  (question ${traceState.serial}, answers: ${traceState.answers.join(', ')})`)
    pass('a suspended simplifier reports a question with the prover\'s own answers')
  } else {
    console.log('  (no question pending -- the trace had already run to completion)')
  }

  // --- graph view ------------------------------------------------------------------
  const depsLine = doc.getText().split(/\r?\n/).findIndex(l => l.trim() === 'thy_deps')
  assert.ok(depsLine > 0, 'fixture should contain a thy_deps command')
  editor.selection = new vscode.Selection(depsLine, 0, depsLine, 0)
  await vscode.commands.executeCommand('isabelle.graphview')

  const graph = await pollFor('a graph from thy_deps',
    async () => {
      const s = await vscode.commands.executeCommand('isabelle.graphviewState')
      return s && s.supported && s.nodes > 0 ? s : undefined
    }, 180000)

  assert.strictEqual(graph.error, undefined, `graph decode failed: ${graph.error}`)
  // Main's import graph. The exact size is Isabelle's business, but a real thy_deps is
  // not two nodes, and every node bar the roots has a parent.
  assert.ok(graph.nodes > 10, `thy_deps should produce a real graph, got ${graph.nodes} nodes`)
  assert.ok(graph.edges > 10, `thy_deps should produce real edges, got ${graph.edges}`)
  console.log(`  (thy_deps: ${graph.nodes} nodes, ${graph.edges} edges)`)
  pass('thy_deps output is found in command results, decoded and published')

  // Moving off the command must clear it, or a stale graph reads as current.
  editor.selection = new vscode.Selection(0, 0, 0, 0)
  const cleared = await pollFor('the graph to clear when the caret moves away',
    async () => {
      const s = await vscode.commands.executeCommand('isabelle.graphviewState')
      return s && s.nodes === 0 ? s : undefined
    }, 60000)
  assert.strictEqual(cleared.nodes, 0)
  pass('moving the caret off the command clears the graph instead of leaving it stale')

  console.log(passed + ' checks passed')
  console.log('SUITE30_OK')
}

module.exports = { run }
