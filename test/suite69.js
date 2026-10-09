// Typing does not scan the workspace for ROOT files.
//
// Each edit of a theory asks whether it sits inside the heap image (session_picker.ts),
// which needs the workspace's sessions. Those were kept only when there were some, so in a
// workspace without a ROOT file every keystroke walked the folders again, synchronously, in
// the extension host. Now one scan serves until a ROOT file or a workspace folder changes.
//
// Needs no prover; runAll starts it with isabelle.autoStart off.
const vscode = require('vscode')
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const wait = ms => new Promise(r => setTimeout(r, ms))
let passed = 0
const pass = m => { passed++; console.log('PASS: ' + m) }
const scans = () => vscode.commands.executeCommand('isabelle.sessionScanCount')

async function type(editor, n) {
  for (let i = 0; i < n; i++) {
    await editor.edit(b => b.insert(editor.selection.active, 'x'))
    await wait(30)
  }
  await wait(300)
}

async function run() {
  const ext = vscode.extensions.getExtension('yfprojects.vscode-isabelle')
  await ext.activate()

  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const root = path.join(ws, 'ROOT')
  assert.ok(!fs.existsSync(root), 'the test workspace must start without a ROOT file')
  const file = path.join(ws, 'Scan.thy')
  fs.writeFileSync(file, 'theory Scan\n  imports Main\nbegin\n\n\n\nend\n', 'utf8')

  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
    const editor = await vscode.window.showTextDocument(doc, { preview: false })
    editor.selection = new vscode.Selection(4, 0, 4, 0)
    await wait(500)

    const before = await scans()
    await type(editor, 20)
    const after = await scans()
    console.log(`  scans during 20 edits without a ROOT file: ${after - before}`)
    assert.ok(after - before <= 1, `20 edits scanned ${after - before} times`)
    pass('edits in a workspace without sessions scan it at most once')

    fs.writeFileSync(root, 'session Scanned = HOL +\n  theories Scan\n', 'utf8')
    await wait(1500)
    const created = await scans()
    await type(editor, 5)
    const rescanned = await scans()
    assert.strictEqual(rescanned - created, 1, 'a new ROOT file makes the next edit scan again')
    await type(editor, 5)
    assert.strictEqual(await scans(), rescanned, 'and only that one')
    pass('a ROOT file that appears is picked up by the next edit, once')
  } finally {
    fs.rmSync(root, { force: true })
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')
    fs.rmSync(file, { force: true })
  }

  console.log(`${passed} checks passed`)
  console.log('SUITE69_OK')
}

module.exports.run = () => run().catch(err => {
  console.error('FAIL: ' + (err && err.stack || err))
  process.exit(1)
})
