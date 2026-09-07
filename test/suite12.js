// jEdit-parity additions: session abbreviations, Documentation panel, Preview, margins.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

async function pollFor(label, fn, timeoutMs, interval = 2500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    console.log(`  ...waiting for ${label} (${Math.round((deadline - Date.now()) / 1000)}s left)`)
    await wait(interval)
  }
  return undefined
}

const parity = () => vscode.commands.executeCommand('isabelle.jEditParityState')

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Parity.thy')
  fs.writeFileSync(file, [
    'theory Parity',
    '  imports Main',
    'begin',
    '',
    'text \\<open>A short document with prose and a lemma.\\<close>',
    '',
    'lemma trivial: "(1::nat) + 1 = 2"',
    '  by simp',
    '',
    'end',
    '',
  ].join('\n'), 'utf8')

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  editor.selection = new vscode.Selection(7, 2, 7, 2)

  // ---------- session abbreviations ----------
  const withAbbrevs = await pollFor('session abbreviations',
    async () => { const s = await parity(); return s && s.abbrevs > 0 ? s : undefined }, 120000)
  assert.ok(withAbbrevs, 'PIDE/abbrevs_response should have arrived')
  console.log(`session abbreviations: ${withAbbrevs.abbrevs}`)
  pass(`session abbreviations loaded (${withAbbrevs.abbrevs} pairs)`)

  // ---------- documentation panel ----------
  await vscode.commands.executeCommand('isabelle-documentation.focus')
  const withDocs = await pollFor('documentation entries',
    async () => { const s = await parity(); return s && s.documentationEntries > 0 ? s : undefined }, 60000)
  assert.ok(withDocs, 'PIDE/documentation_response should have arrived')
  console.log(`documentation entries: ${withDocs.documentationEntries}`)
  assert.ok(withDocs.documentationEntries > 5,
    `expected a real manual index, got ${withDocs.documentationEntries}`)
  pass(`documentation index loaded (${withDocs.documentationEntries} entries)`)

  // ---------- preview ----------
  await vscode.window.showTextDocument(doc, { preview: false })
  await wait(1000)
  await vscode.commands.executeCommand('isabelle.preview')
  const withPreview = await pollFor('preview response',
    async () => { const s = await parity(); return s && s.previewColumns.length > 0 ? s : undefined }, 60000)
  assert.ok(withPreview, 'PIDE/preview_response should have opened a panel')
  console.log(`preview columns: ${JSON.stringify(withPreview.previewColumns)}, label: ${JSON.stringify(withPreview.previewLabel)}`)
  pass(`preview panel opened (label ${JSON.stringify(withPreview.previewLabel)})`)

  // ---------- margins ----------
  // The Output panel reports its width so the server can pretty-print to it. There is no
  // observable reply, so this only checks the notification is accepted without error.
  await vscode.commands.executeCommand('isabelle-output.focus')
  await wait(3000)
  const state = await vscode.commands.executeCommand('isabelle.serverState')
  assert.strictEqual(state.state, 'Running', 'the client must survive the margin notifications')
  pass('panels report their margin without upsetting the server')

  console.log(`\n${passed} checks passed`)
  console.log('SUITE12_OK')
}

module.exports = { run }
