// Ported UI: PIDE markup decorations, and the infoview on a stock server.
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
  const ext = vscode.extensions.getExtension('yfprojects.vscode-isabelle')
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

  // ---------- 2. Infoview, on the stock server's messages ----------
  // No extended server here, so the infoview puts PIDE/dynamic_output and State_Panel
  // instances together (the stock backend; suite45 covers the extended one).
  const infoview = () => vscode.commands.executeCommand('isabelle.infoviewState')
  const text = html => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  await vscode.commands.executeCommand('isabelle-infoview.focus')
  editor.selection = new vscode.Selection(5, 2, 5, 2)
  const live = await pollFor('infoview goals at the cursor', async () => {
    const s = await infoview()
    return s && s.mode === 'stock' && /P/.test(text(s.live?.goals)) ? s : undefined
  }, 120000)
  console.log('infoview goals: ' + text(live.live.goals).slice(0, 160))
  assert.ok(/goal|subgoal/i.test(text(live.live.goals)),
    `the live section should show a proof state, got: ${text(live.live.goals).slice(0, 120)}`)
  assert.strictEqual(typeof live.live.messages, 'string',
    'PIDE/dynamic_output should have filled the messages')
  assert.ok(!/subgoal/.test(text(live.live.messages)),
    'the proof state must not come twice: the messages are sent without it')
  pass('Infoview shows the goals and messages at the cursor')

  // ---------- 3. A pin, on a State_Panel instance ----------
  await vscode.commands.executeCommand('isabelle.infoviewPin')
  const pinned = await pollFor('a pin with goals', async () => {
    const s = await infoview()
    return s && s.pins.length === 1 && text(s.pins[0].goals) ? s : undefined
  }, 60000)
  const pinGoals = text(pinned.pins[0].goals)
  assert.strictEqual(typeof pinned.pins[0].id, 'number',
    'a stock pin is a PIDE/state_init instance (Isabelle counters go negative)')
  assert.strictEqual(pinned.pins[0].line, 5)
  editor.selection = new vscode.Selection(7, 2, 7, 2)
  await wait(5000)
  const moved = await infoview()
  assert.strictEqual(text(moved.pins[0].goals), pinGoals, 'the pin keeps its proof state')
  pass(`a pin keeps its proof state when the cursor moves (id=${pinned.pins[0].id})`)

  await vscode.commands.executeCommand('isabelle.infoviewUnpinAll')
  await pollFor('no pins', async () => ((await infoview())?.pins.length === 0) || undefined, 30000)
  pass('unpinning removes the pin')

  console.log(`\n${passed} checks passed`)
  console.log('SUITE6_OK')
}

module.exports = { run }
