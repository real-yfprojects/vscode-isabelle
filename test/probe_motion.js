// Diagnostic: where does the caret land moving across glyphs, for several constructs?
const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const wait = ms => new Promise(r => setTimeout(r, ms))

const LINES = [
  'lemma a: "A \\<and> B"',
  '  \\<forall>x. P x',
  'lemma b: "x\\<^sub>1 = y"',
  'text \\<open>hi\\<close>',
  'lemma c: "\\<lambda>x. x"',
]

async function run() {
  const ext = vscode.extensions.getExtension('spike.isabelle-pide-stock')
  await ext.activate()
  const ws = vscode.workspace.workspaceFolders[0].uri.fsPath
  const file = path.join(ws, 'Motion.thy')
  const head = ['theory Motion', '  imports Main', 'begin', '']
  fs.writeFileSync(file, head.concat(LINES).concat(['', 'end', '']).join('\n'), 'utf8')
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  await wait(1500)

  for (let i = 0; i < LINES.length; i++) {
    const L = head.length + i
    const line = LINES[i]
    console.log('')
    console.log(`line ${i}: ${JSON.stringify(line)}`)
    for (const [dir, cmd] of [['left', 'isabelle.cursorLeft'], ['right', 'isabelle.cursorRight']]) {
      const start = dir === 'left' ? line.length : 0
      editor.selection = new vscode.Selection(L, start, L, start)
      await wait(120)
      const seen = [start]
      for (let n = 0; n < line.length + 2; n++) {
        await vscode.commands.executeCommand(cmd)
        await wait(45)
        const c = editor.selection.active
        if (c.line !== L) break
        if (c.character === seen[seen.length - 1]) break
        seen.push(c.character)
      }
      // Show which offsets were skipped in one press.
      const jumps = []
      for (let n = 1; n < seen.length; n++) {
        const step = Math.abs(seen[n] - seen[n - 1])
        if (step > 1) jumps.push(`${seen[n - 1]}->${seen[n]} (${step}) [${JSON.stringify(line.slice(Math.min(seen[n], seen[n - 1]), Math.max(seen[n], seen[n - 1])))}]`)
      }
      console.log(`  ${dir}: ${seen.join(' ')}`)
      for (const j of jumps) console.log(`    jump ${j}`)
    }
  }
  console.log('PROBE_DONE')
}
module.exports = { run }
