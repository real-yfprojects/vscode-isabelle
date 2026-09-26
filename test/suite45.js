// The infoview against the extended server: PIDE/infoview_* end to end.
//
// What only the extended server can do, and so what this suite is for: goals and messages
// arrive apart, and a pin follows the text -- through an edit to the pinned command, which
// replaces it with a new one, and through lines inserted above it. The stock backend is
// covered by suite6.
//
// Runs against a patched Isabelle or the stock one with the extended server (see
// test/server_target.js), and skips itself when there is neither.
const vscode = require('vscode')
const target_ = require('./server_target')
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const EXT_ID = 'yfprojects.vscode-isabelle'
const wait = ms => new Promise(r => setTimeout(r, ms))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

const infoview = () => vscode.commands.executeCommand('isabelle.infoviewState')

/* Polls the infoview until `predicate` holds for it, and reports what it last saw if it
   never does: "timed out" alone does not say whether the pin was missing, stale, or
   showing the wrong command. */
async function until(what, predicate, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  let state
  while (Date.now() < deadline) {
    try {
      state = await infoview()
      if (state && predicate(state)) return state
    } catch { /* not registered yet */ }
    await wait(1000)
  }
  const brief = s => s && {
    mode: s.mode, paused: s.paused, pending: s.pending,
    live: s.live && { line: s.live.line, command: s.live.command, source: s.live.source,
      status: s.live.status, goals: text(s.live.goals).slice(0, 80) },
    pins: s.pins.map(p => ({ id: p.id, line: p.line, source: p.source, status: p.status,
      stale: p.stale, goals: text(p.goals).slice(0, 80) })),
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}; last: ${JSON.stringify(brief(state))}`)
}

const text = html => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

const WRITTEN_SETTINGS = ['home', 'extendedServer', 'autoStart']

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
  const target = target_.resolve()
  if (!target) {
    console.log('SKIP: ' + target_.skipReason())
    console.log('SUITE45_OK')
    return
  }
  console.log(target.label)

  const ext = vscode.extensions.getExtension(EXT_ID)
  const cfg = vscode.workspace.getConfiguration('isabelle')
  await target_.apply(target, vscode.ConfigurationTarget.Workspace)
  await cfg.update('autoStart', true, vscode.ConfigurationTarget.Workspace)
  await ext.activate()
  await vscode.commands.executeCommand('isabelle.restartServer')

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Pins.thy')
  fs.writeFileSync(file, [
    'theory Pins',                                     // 0
    '  imports Main',                                  // 1
    'begin',                                           // 2
    '',                                                // 3
    'lemma swap: "A \\<and> B \\<Longrightarrow> B \\<and> A"', // 4
    '  apply (rule conjI)',                            // 5
    '   apply (erule conjE)',                          // 6
    '   apply assumption',                             // 7
    '  apply (erule conjE)',                           // 8
    '  apply assumption',                              // 9
    '  done',                                          // 10
    '',                                                // 11
    'lemma refl: "x = (x::nat)"',                      // 12
    '  by simp',                                       // 13
    '',                                                // 14
    'end',                                             // 15
    '',
  ].join('\n'), 'utf8')
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  /* At the end of the line: whitespace before a command belongs to the command before it,
     so a caret in the indentation would show the previous line's command. */
  const caret = line => {
    const end = doc.lineAt(line).text.length
    editor.selection = new vscode.Selection(line, end, line, end)
  }

  await vscode.commands.executeCommand('isabelle.infoview')
  caret(5)
  await until('the extended backend', s => s.mode === 'extended', 240000)
  pass('the infoview found the extended server')

  // --- goals and messages, apart ----------------------------------------------------
  let s = await until('the goals after rule conjI',
    s => s.live?.line === 5 && /2 subgoals/.test(text(s.live.goals)), 240000)
  assert.strictEqual(s.live.command, 'apply')
  assert.ok(/rule conjI/.test(s.live.source), `source: ${s.live.source}`)
  assert.ok(!/subgoal/.test(text(s.live.messages)),
    `the proof state belongs in goals, not messages: ${text(s.live.messages).slice(0, 120)}`)
  pass('the command at the cursor shows its goals apart from its messages')

  // --- a pin stays put ---------------------------------------------------------------
  await vscode.commands.executeCommand('isabelle.infoviewPin')
  s = await until('the pin', s => s.pins.length === 1 && /2 subgoals/.test(text(s.pins[0].goals)))
  const pinId = s.pins[0].id
  assert.strictEqual(s.pins[0].line, 5)
  caret(13)
  s = await until('the cursor on the second lemma', s => s.live?.line === 13)
  assert.strictEqual(s.pins[0].line, 5)
  assert.ok(/2 subgoals/.test(text(s.pins[0].goals)), 'the pin keeps its own goals')
  pass('a pin keeps its command while the cursor moves on')

  // --- a pin follows the text ---------------------------------------------------------
  // Editing the pinned command replaces it with a new command; the pin must take that one.
  let edit = new vscode.WorkspaceEdit()
  edit.replace(doc.uri, doc.lineAt(5).range, '  apply (intro conjI)')
  assert.ok(await vscode.workspace.applyEdit(edit))
  s = await until('the pin on the edited command',
    s => s.pins.length === 1 && /intro conjI/.test(s.pins[0].source ?? '') &&
      s.pins[0].status === 'finished' && /2 subgoals/.test(text(s.pins[0].goals)))
  assert.strictEqual(s.pins[0].id, pinId)
  assert.strictEqual(s.pins[0].line, 5)
  assert.ok(!s.pins[0].stale)
  pass('a pin takes over the command that replaces its own')

  edit = new vscode.WorkspaceEdit()
  edit.insert(doc.uri, new vscode.Position(3, 0), '\n\n')
  assert.ok(await vscode.workspace.applyEdit(edit))
  s = await until('the pin two lines further down', s => s.pins[0]?.line === 7)
  assert.ok(/intro conjI/.test(s.pins[0].source))
  pass('a pin moves with lines inserted above it')

  // --- pausing -------------------------------------------------------------------------
  s = await until('the live section after the insertion', s => s.live?.line === 15)
  await vscode.commands.executeCommand('isabelle.infoviewTogglePause')
  caret(8)
  s = await until('a change held back while paused', s => s.paused && s.pending)
  assert.strictEqual(s.live.line, 15, 'a paused infoview keeps showing what it showed')
  await vscode.commands.executeCommand('isabelle.infoviewTogglePause')
  s = await until('the cursor again after resuming', s => !s.paused && s.live?.line === 8)
  pass('pausing holds the live section, and resuming catches up')

  // --- hosts and unpinning ---------------------------------------------------------------
  await vscode.commands.executeCommand('isabelle.infoviewOpenInEditor')
  s = await until('the editor tab', s => s.inEditor)
  pass('the infoview opens in an editor tab too')

  await vscode.commands.executeCommand('isabelle.infoviewUnpinAll')
  await until('no pins', s => s.pins.length === 0)
  pass('unpinning removes the pin')

  await vscode.commands.executeCommand('workbench.action.files.revert')
  console.log(`\n${passed} checks passed`)
  console.log('SUITE45_OK')
}

module.exports = { run }
