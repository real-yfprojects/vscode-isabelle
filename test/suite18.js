// VS Code's own symbol search over an Isabelle theory: Ctrl+Shift+O and Ctrl+T.
//
// Both were empty before the outline provider existed, because the language server
// advertises no symbol provider of either kind. This asserts they are wired up, through
// the same commands the editor itself uses.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const wait = ms => new Promise(r => setTimeout(r, ms))

let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Sym.thy')
  fs.writeFileSync(file, [
    'theory Sym', '  imports Main', 'begin', '',
    'section \\<open>Some structure\\<close>', '',
    'definition myconst :: "nat => nat" where "myconst n = n + 1"', '',
    'lemma mylemma: "myconst n = n + 1"', '  unfolding myconst_def by simp', '',
    'end', '',
  ].join('\n'), 'utf8')
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  await vscode.window.showTextDocument(doc, { preview: false })
  await wait(1500)

  const ds = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri)
  const flat = []
  const walk = ss => { for (const s of ss || []) { flat.push(s.name); walk(s.children) } }
  walk(ds)
  console.log('documentSymbol: ' + JSON.stringify(flat))
  assert.ok(flat.includes('theory Sym'), 'the theory itself should be an outline entry')
  assert.ok(flat.includes('Some structure'), 'a section should appear under its heading text')
  assert.ok(flat.includes('definition myconst'), flat.join(', '))
  assert.ok(flat.includes('lemma mylemma'), flat.join(', '))
  pass('Ctrl+Shift+O, the Outline view and breadcrumbs see the theory structure')

  // Folding follows the same tree, which is also what sticky scroll consults.
  const folds = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', doc.uri)
  assert.ok(folds && folds.length > 0, 'the section and its items should be foldable')
  pass('folding ranges come from the same structure')

  for (const [query, expected] of [['mylemma', 'mylemma'], ['myconst', 'myconst']]) {
    const found = await vscode.commands.executeCommand(
      'vscode.executeWorkspaceSymbolProvider', query)
    const names = (found || []).map(s => s.name)
    assert.ok(names.includes(expected),
      `Ctrl+T for ${query} should find it, got ${JSON.stringify(names)}`)
  }
  pass('Ctrl+T finds declarations across the workspace')

  console.log(`${passed} checks passed`)
  console.log('SUITE18_OK')
}

module.exports.run = () => run().catch(err => {
  console.error('FAIL: ' + (err && err.stack || err))
  process.exit(1)
})
