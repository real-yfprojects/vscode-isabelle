// The Get Started walkthrough's commands, and the tutorial theory they open.
//
// The tutorial is the one theory every new user checks first, so it has to go through
// cleanly -- on a stock Isabelle and on the extended server -- and do what its text
// promises: a proof that breaks when "x + 1" becomes "x - 1". The references inside the
// walkthrough are checked without an editor, in suite46.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const target_ = require('./server_target')
const { anchorPosition } = require('../out/tutorial.js')

const EXT_ID = 'yfprojects.vscode-isabelle'
const wait = ms => new Promise(r => setTimeout(r, ms))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

const text = html => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

async function until(what, probe, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    const status = await vscode.commands.executeCommand('isabelle.serverState')
    if (status.state === 'StartFailed') {
      throw new Error(`language client failed while waiting for ${what}: ${status.lastError}`)
    }
    try { last = await probe(); if (last) return last } catch { /* not ready */ }
    await wait(1000)
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

const errors = uri => vscode.languages.getDiagnostics(uri)
  .filter(d => d.severity === vscode.DiagnosticSeverity.Error)

/**
 * Open the tutorial at its last command and wait for find_theorems' output: the prover
 * gets there only after checking everything above it, so no error by then means none.
 */
async function checkTutorial(label) {
  await vscode.commands.executeCommand('isabelle.openTutorial', 'facts')
  const editor = vscode.window.activeTextEditor
  await until(`find_theorems output (${label})`, async () => {
    const state = await vscode.commands.executeCommand('isabelle.infoviewState')
    return /found \d+ theorem/.test(text(state?.live?.messages)) && state
  })
  const found = errors(editor.document.uri)
  assert.deepStrictEqual(found.map(d => `${d.range.start.line + 1}: ${d.message}`), [],
    `the tutorial checks without errors (${label})`)
  pass(`the tutorial checks without errors (${label})`)
  return editor
}

const WRITTEN = ['extendedServer', 'autoStart']

async function run() {
  try { await drive() }
  finally {
    const cfg = vscode.workspace.getConfiguration('isabelle')
    for (const key of WRITTEN) {
      try { await cfg.update(key, undefined, vscode.ConfigurationTarget.Workspace) } catch { /* see suite45 */ }
    }
  }
}

async function drive() {
  const ext = vscode.extensions.getExtension(EXT_ID)
  const cfg = vscode.workspace.getConfiguration('isabelle')
  await cfg.update('autoStart', true, vscode.ConfigurationTarget.Workspace)
  await ext.activate()

  // --- setup commands ----------------------------------------------------------------
  await vscode.commands.executeCommand('isabelle.checkInstallation')
  await vscode.commands.executeCommand('isabelle.useIsabelleFont')
  const font = vscode.workspace.getConfiguration('editor', { languageId: 'isabelle' })
  assert.match(String(font.inspect('fontFamily').globalLanguageValue), /^'Isabelle DejaVu Sans Mono'/)
  assert.doesNotMatch(String(vscode.workspace.getConfiguration('editor').inspect('fontFamily').globalValue),
    /Isabelle/, 'only theories get the font')
  await font.update('fontFamily', undefined, vscode.ConfigurationTarget.Global, true)
  pass('useIsabelleFont sets the font for theories only')

  const tabs = () => vscode.window.tabGroups.all.flatMap(g => g.tabs).length
  const before = tabs()
  await vscode.commands.executeCommand('isabelle.gettingStarted')
  await wait(1000)
  assert.ok(tabs() > before, 'the walkthrough opens in a tab')
  pass('isabelle.gettingStarted opens the walkthrough')

  // --- the tutorial --------------------------------------------------------------------
  await vscode.commands.executeCommand('isabelle.openTutorial', 'goals')
  let editor = vscode.window.activeTextEditor
  assert.ok(editor.document.uri.fsPath.endsWith('Tutorial.thy'), editor.document.uri.fsPath)
  assert.ok(!editor.document.uri.fsPath.startsWith(ext.extensionPath), 'opens a copy, not the shipped file')
  const at = anchorPosition(editor.document.getText(), 'goals')
  assert.deepStrictEqual([editor.selection.active.line, editor.selection.active.character],
    [at.line, at.character])
  assert.strictEqual(editor.document.lineAt(at.line).text.trim(), 'case (Cons x xs)')
  pass('Show Me opens the tutorial with the cursor on the anchor')

  editor = await checkTutorial('stock server')

  // The tutorial's first exercise: its proof must fail.
  const doc = editor.document
  const line = doc.getText().split('\n').findIndex(l => l.includes('x \\<le> x + 1'))
  const col = doc.lineAt(line).text.indexOf('x + 1')
  await editor.edit(e => e.replace(new vscode.Range(line, col, line, col + 5), 'x - 1'))
  editor.selection = new vscode.Selection(line, 0, line, 0)
  await until('the broken proof to be reported', async () =>
    errors(doc.uri).some(d => d.range.start.line === line + 1))
  pass('changing "x + 1" to "x - 1" breaks the proof below it, as the tutorial says')

  // A second open keeps the user's copy, edits and all.
  await doc.save()
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
  await vscode.commands.executeCommand('isabelle.openTutorial')
  editor = vscode.window.activeTextEditor
  assert.ok(editor.document.getText().includes('x - 1'), 'the edited copy was replaced')
  await editor.edit(e => e.replace(new vscode.Range(line, col, line, col + 5), 'x + 1'))
  await editor.document.save()
  assert.ok(fs.readFileSync(editor.document.uri.fsPath, 'utf8').includes('x \\<le> x + 1'))
  pass('opening the tutorial again keeps the edited copy')

  // --- again on the extended server -----------------------------------------------------
  const target = target_.resolve()
  if (!target?.extended) {
    console.log('SKIP extended server: no jar for this Isabelle')
  } else {
    await cfg.update('extendedServer', true, vscode.ConfigurationTarget.Workspace)
    await vscode.commands.executeCommand('isabelle.restartServer')
    await until('the extended server', async () => {
      const s = await vscode.commands.executeCommand('isabelle.serverState')
      return s.state === 'Running' && s.runningJar
    })
    await checkTutorial('extended server')
  }

  console.log(passed + ' checks passed')
  console.log('SUITE47_OK')
}

module.exports = { run }
