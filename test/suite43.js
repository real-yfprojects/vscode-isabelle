// A stale heap image, noticed in a real editor: the file-system watcher for changes on
// disk, open buffers for unsaved edits, and what the status bar and the list make of them.
// No prover -- the baseline a server start takes is taken through a test hook instead,
// which is the only part of the path that differs.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

const heapState = () => vscode.commands.executeCommand('isabelle.heapWatchState')

/** Poll for a condition rather than sleeping through a worst case. */
async function until(what, seconds, probe) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await wait(200)
  }
  throw new Error(`timed out: ${what}`)
}

async function run() {
  const ext = vscode.extensions.getExtension('yfprojects.vscode-isabelle')
  await ext.activate()
  const commands = await vscode.commands.getCommands(true)
  if (!commands.includes('isabelle.heapWatchCapture')) {
    // Activation stops before the session commands when no Isabelle is installed.
    console.log('SKIP: no Isabelle distribution, so the extension did not fully activate')
    console.log('SUITE43_SKIPPED')
    return
  }

  // Lib is built into App's requirements image; App's own theory stays live.
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const lib = path.join(ws, 'heaplib', 'Lib.thy')
  const app = path.join(ws, 'heapapp', 'App.thy')
  fs.mkdirSync(path.dirname(lib), { recursive: true })
  fs.mkdirSync(path.dirname(app), { recursive: true })
  fs.writeFileSync(path.join(ws, 'heaplib', 'ROOT'), 'session Lib = HOL +\n  theories\n    Lib\n')
  fs.writeFileSync(path.join(ws, 'heapapp', 'ROOT'), 'session App = Lib +\n  theories\n    App\n')
  const libText = 'theory Lib\n  imports Main\nbegin\n\nlemma l: True by simp\n\nend\n'
  fs.writeFileSync(lib, libText)
  fs.writeFileSync(app, 'theory App\n  imports Lib\nbegin\n\nend\n')

  await vscode.commands.executeCommand('isabelle.heapWatchCapture', 'App', true)
  let s = await heapState()
  assert.strictEqual(s.watched, 1, 'only Lib.thy is in the image')
  assert.deepStrictEqual(s.stale, [])
  pass('the baseline holds the image\'s workspace files and nothing is stale yet')

  // --- on disk -----------------------------------------------------------------------
  fs.writeFileSync(lib, libText.replace('True', 'True \\<and> True'))
  s = await until('the watcher reporting the change', 15,
    async () => { const h = await heapState(); return h.stale.length > 0 ? h : undefined })
  assert.strictEqual(s.stale[0].change, 'modified')
  assert.ok(s.stale[0].label.endsWith('Lib.thy'), s.stale[0].label)
  const bar = await vscode.commands.executeCommand('isabelle.statusBarState')
  assert.strictEqual(bar.stale.length, 1, 'the status bar receives the list')
  pass('a change on disk makes the image stale')

  fs.writeFileSync(lib, libText)
  await until('putting the text back clearing it', 15,
    async () => (await heapState()).stale.length === 0)
  pass('putting the old text back clears it')

  // A live theory is not in the image: changing it is ordinary editing.
  fs.writeFileSync(app, 'theory App\n  imports Lib\nbegin\n\nlemma a: True by simp\n\nend\n')
  await wait(1500)
  assert.deepStrictEqual((await heapState()).stale, [])
  pass('editing the session\'s own theory is not staleness')

  // --- in a buffer ---------------------------------------------------------------------
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(lib))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  await editor.edit(e => e.insert(new vscode.Position(3, 0), '(* edit *)\n'))
  s = await until('the unsaved edit counting', 15,
    async () => { const h = await heapState(); return h.stale.length > 0 ? h : undefined })
  assert.strictEqual(s.stale[0].change, 'unsaved')
  pass('an unsaved edit to a heap theory counts')

  await vscode.commands.executeCommand('undo')
  await until('undo clearing it', 15, async () => (await heapState()).stale.length === 0)
  pass('undoing the edit clears it')

  // --- the list -------------------------------------------------------------------------
  await editor.edit(e => e.insert(new vscode.Position(3, 0), '(* again *)\n'))
  await doc.save()
  s = await until('the saved edit counting as modified', 15, async () => {
    const h = await heapState()
    return h.stale.length > 0 && h.stale[0].change === 'modified' ? h : undefined
  })
  await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  await vscode.commands.executeCommand('isabelle.showStaleFiles', s.stale[0].file)
  const opened = vscode.window.activeTextEditor
  assert.ok(opened && opened.document.uri.fsPath.toLowerCase() === lib.toLowerCase(),
    'the tooltip link opens the file it names')
  pass('a saved edit is stale, and its link opens it')

  // A new start is a new image: nothing is stale against it.
  await vscode.commands.executeCommand('isabelle.heapWatchCapture', 'App', true)
  assert.deepStrictEqual((await heapState()).stale, [])
  pass('the next server start begins from a clean slate')

  console.log(passed + ' checks passed')
  console.log('SUITE43_OK')
}

module.exports = { run }
