// Ported UI: PIDE markup decorations, Output panel, State panel.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

async function pollFor(label, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v !== undefined && v !== null && !(typeof v === 'object' && Object.keys(v).length === 0)) return v
    await wait(2000)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Panels.thy')
  fs.writeFileSync(file, [
    'theory Panels',
    '  imports Main',
    'begin',
    '',
    'lemma q: "P \\<longrightarrow> P"',
    '  apply (rule impI)',
    '  apply assumption',
    '  done',
    '',
    'end',
    '',
  ].join('\n'), 'utf8')

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  // Sit inside the proof so PIDE has a goal to report.
  editor.selection = new vscode.Selection(5, 2, 5, 2)
  await wait(1000)

  // ---------- 1. PIDE markup decorations ----------
  console.log('waiting for PIDE markup...')
  const summary = await pollFor('PIDE decorations',
    () => vscode.commands.executeCommand('isabelle.pideDecorationSummary'), 180000)
  const types = Object.keys(summary).sort()
  console.log('decoration types received: ' + JSON.stringify(summary))
  assert.ok(types.length > 0, 'expected at least one decoration type')
  assert.ok(types.some(t => t.startsWith('text_')),
    `expected syntax colouring (text_*), got ${types}`)
  pass(`PIDE markup decorations applied (${types.length} types, ` +
       `${Object.values(summary).reduce((a, b) => a + b, 0)} ranges)`)

  // ---------- 2. Output panel ----------
  await vscode.commands.executeCommand('isabelle-output.focus')
  await wait(3000)
  editor.selection = new vscode.Selection(6, 2, 6, 2)
  await wait(4000)
  const outHtml = await pollFor('output panel content',
    () => vscode.commands.executeCommand('isabelle.outputPanelContent'), 60000)
  console.log('output panel html: ' + String(outHtml).replace(/\s+/g, ' ').slice(0, 160))
  assert.ok(String(outHtml).length > 0, 'output panel should have content')
  pass('Output panel received PIDE/dynamic_output HTML')

  // ---------- 3. State panel ----------
  await vscode.commands.executeCommand('isabelle-state.focus')
  await wait(3000)
  const stateId = await pollFor('state panel id',
    async () => {
      const v = await vscode.commands.executeCommand('isabelle.statePanelId')
      return v === undefined ? undefined : { v }
    }, 60000)
  console.log('state panel id: ' + stateId.v)
  assert.strictEqual(typeof stateId.v, 'number',
    'PIDE/state_init should have returned a numeric state id')
  pass(`State panel initialised (id=${stateId.v}; Isabelle counters go negative)`)

  editor.selection = new vscode.Selection(5, 2, 5, 2)
  await vscode.commands.executeCommand('isabelle.stateUpdate')
  await wait(5000)
  const stateHtml = await pollFor('state panel content',
    () => vscode.commands.executeCommand('isabelle.statePanelContent'), 60000)
  const text = String(stateHtml).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  console.log('state panel text: ' + text.slice(0, 160))
  assert.ok(/goal|proof|P/i.test(text), `state panel should show a proof state, got: ${text.slice(0, 120)}`)
  pass('State panel shows the proof state')

  console.log(`\n${passed} checks passed`)
  console.log('SUITE6_OK')
}

module.exports = { run }
