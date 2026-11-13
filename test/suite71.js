// Active markup end to end: a dialog answered and a sendback taken from the infoview.
//
// Isabelle2026's server takes a click on either as PIDE/markup_action, and answers a
// sendback with PIDE/document_edit (src/markup_action.ts). This suite does what a click
// does -- isabelle.infoviewClickActive posts the message the page's click handler would
// for the element shown -- and checks what comes of it:
//
//   - an ML command opens a dialog (Active.dialog_text) and waits for it; choosing "left"
//     lets it go on, and it says what it got;
//   - try0 below it offers its proof as a sendback; taking it puts the proof under try0
//     (Markup.padding_command), with the caret after it, and the lemma then checks.
//
// First against the stock server, whose YXML the client renders itself (pide_html.ts),
// then against the extended server when its jar is built (test/server_target.js), whose
// infoview HTML makes the same spans server-side. Isabelle2025-2 has neither message, so
// the suite skips there.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const target_ = require('./server_target')
const { findIsabelleHome } = require('../out/isabelle.js')

const EXT_ID = 'yfprojects.vscode-isabelle'
const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

const infoview = () => vscode.commands.executeCommand('isabelle.infoviewState')
const active = () => vscode.commands.executeCommand('isabelle.infoviewActive')
const text = html => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

/** Polls until `fn` gives something, and says what it last saw if it never does. */
async function until(what, fn, timeoutMs = 120000, show = () => undefined) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v) return v
    } catch { /* not registered yet */ }
    await wait(1000)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}; last: ` +
    JSON.stringify(await show()))
}

const lastSeen = async () => {
  const s = await infoview()
  return { mode: s?.mode, messages: text(s?.live?.messages).slice(0, 200),
    goals: text(s?.live?.goals).slice(0, 120), active: await active() }
}

const errors = uri => vscode.languages.getDiagnostics(uri)
  .filter(d => d.severity === vscode.DiagnosticSeverity.Error)

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
  let identifier = ''
  try {
    identifier = fs.readFileSync(path.join(findIsabelleHome(), 'etc', 'ISABELLE_IDENTIFIER'),
      'utf8').trim()
  } catch { /* no Isabelle found: the start below says so */ }
  if (identifier === 'Isabelle2025-2') {
    console.log('SKIP: Isabelle2025-2 has no PIDE/markup_action')
    console.log('SUITE71_OK')
    return
  }

  const cfg = vscode.workspace.getConfiguration('isabelle')
  await cfg.update('autoStart', true, vscode.ConfigurationTarget.Workspace)
  await cfg.update('extendedServer', false, vscode.ConfigurationTarget.Workspace)
  await vscode.extensions.getExtension(EXT_ID).activate()
  await vscode.commands.executeCommand('isabelle.restartServer')
  await phase('stock', 'Active_Stock')

  const target = target_.resolve()
  if (!target) {
    console.log('SKIP (extended): ' + target_.skipReason())
  } else {
    console.log(target.label)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    await target_.apply(target, vscode.ConfigurationTarget.Workspace)
    await vscode.commands.executeCommand('isabelle.restartServer')
    await phase('extended', 'Active_Extended')
  }

  console.log(`\n${passed} checks passed`)
  console.log('SUITE71_OK')
}

async function phase(mode, theory) {
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, `${theory}.thy`)
  fs.writeFileSync(file, [
    `theory ${theory}`,                                                      // 0
    '  imports Main',                                                        // 1
    'begin',                                                                 // 2
    '',                                                                      // 3
    'ML \\<open>',                                                           // 4
    '  val (choice, answer) = Active.dialog_text ();',                       // 5
    '  val _ = writeln ("Pick " ^ choice "left" ^ " or " ^ choice "right");', // 6
    '  val _ = writeln ("picked " ^ Future.join answer)',                    // 7
    '\\<close>',                                                             // 8
    '',                                                                      // 9
    'lemma "rev (rev xs) = (xs::nat list)"',                                 // 10
    '  try0',                                                                // 11
    '',                                                                      // 12
    'end',                                                                   // 13
    '',
  ].join('\n'), 'utf8')
  const ML = 5, TRY0 = 11

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  await vscode.commands.executeCommand('isabelle-infoview.focus')
  await vscode.window.showTextDocument(doc, { preview: false })
  editor.selection = new vscode.Selection(ML, 4, ML, 4)

  // --- the dialog ---
  const choices = await until(`the dialog's choices (${mode})`, async () => {
    const s = await infoview()
    if (s?.mode !== mode) return undefined
    const a = await active()
    return a && a.filter(e => e.name === 'dialog').length >= 2 ? a : undefined
  }, 240000, lastSeen)
  assert.deepStrictEqual(choices.filter(e => e.name === 'dialog').map(e => e.text), ['left', 'right'])
  const shown = await infoview()
  const all = JSON.stringify([shown.live, shown.pins])
  assert.ok(!/\\u0005|\\u0006/.test(all), 'the infoview shows no raw YXML')
  assert.match(text(shown.live.messages), /Pick left or right/)
  pass(`${mode}: the infoview shows a dialog's choices as active elements`)

  const clicked = await vscode.commands.executeCommand('isabelle.infoviewClickActive', '^left$')
  assert.deepStrictEqual(clicked, { name: 'dialog', text: 'left' })
  await until(`"picked left" (${mode})`, async () =>
    /picked left/.test(text((await infoview())?.live?.messages)), 60000, lastSeen)
  assert.ok(!doc.isDirty, 'answering a dialog does not edit the theory')
  pass(`${mode}: choosing in the dialog lets the waiting command go on with the choice`)

  // --- the sendback ---
  editor.selection = new vscode.Selection(TRY0, 4, TRY0, 4)
  const proofs = await until(`try0's proofs (${mode})`, async () => {
    const a = await active()
    return a && a.some(e => e.name === 'sendback') ? a : undefined
  }, 180000, lastSeen)
  const proof = proofs.find(e => e.name === 'sendback').text
  console.log(`  try0 offers: ${proofs.filter(e => e.name === 'sendback').map(e => e.text).join(' | ')}`)
  const taken = await vscode.commands.executeCommand('isabelle.infoviewClickActive',
    '^' + proof.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')
  assert.strictEqual(taken && taken.name, 'sendback')
  await until(`the proof under try0 (${mode})`,
    () => doc.lineAt(TRY0 + 1).text === '  ' + proof, 30000,
    () => doc.getText(new vscode.Range(TRY0 - 1, 0, TRY0 + 3, 0)))
  assert.strictEqual(doc.lineAt(TRY0).text, '  try0', 'try0 stays (padding_command)')
  const caret = vscode.window.activeTextEditor.selection.active
  assert.deepStrictEqual([caret.line, caret.character], [TRY0 + 1, 2 + proof.length],
    'the caret is after the inserted proof')
  pass(`${mode}: taking try0's proof "${proof}" puts it under try0, with the caret after it`)

  /* Without the proof, `end` is an error (the lemma is still open); give the edit time to
     reach the prover, so an empty list in between is not taken for the answer. */
  await wait(5000)
  await until(`the lemma to check with the proof (${mode})`,
    () => errors(doc.uri).length === 0, 90000,
    () => errors(doc.uri).map(d => `${d.range.start.line}: ${d.message}`))
  // Saved, so that closing the editors before the next phase asks nothing.
  await doc.save()
  pass(`${mode}: the theory checks with the proof in`)
}

module.exports = { run }
