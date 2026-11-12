// Waiting for a state instead of sleeping a fixed time. A fixed sleep is both too long (every
// run pays it) and too short (a loaded CI machine, two suites at a time, misses it): these
// return as soon as what they wait for holds, and only a deadline that nothing working ever
// reaches bounds them.
const vscode = require('vscode')

const wait = ms => new Promise(r => setTimeout(r, ms))

/** Reads `read` until `done` holds of its value, for up to `ms`, and returns the last value,
    which the caller asserts on as before, so a wrong state still fails with its message. */
async function settled(read, done, ms = 10000) {
  let value
  for (const deadline = Date.now() + ms; ; await wait(50)) {
    value = await read()
    if (done(value) || Date.now() > deadline) return value
  }
}

/** Until the decorations have followed the last change: they refresh on a short timer after
    a selection or an edit, and isabelle.decorationRanges says whether one is pending. */
const decorationsSettled = () =>
  settled(() => vscode.commands.executeCommand('isabelle.decorationRanges'), r => !r || !r.pending)

/** Sets the selection and waits until VS Code reports it back, then for the decorations. The
    extension follows the selection in its own listeners for that event -- the context keys,
    the step over a rendered symbol -- registered at activation and so run before this one:
    once the event arrives here, they have all seen it. A selection already set raises no
    event, and needs none. */
async function select(editor, selection) {
  if (editor.selection.isEqual(selection)) return
  const uri = editor.document.uri.toString()
  const seen = new Promise(resolve => {
    const done = ok => { sub.dispose(); clearTimeout(timer); resolve(ok) }
    const sub = vscode.window.onDidChangeTextEditorSelection(e => {
      if (e.textEditor.document.uri.toString() === uri && e.selections[0].isEqual(selection)) done(true)
    })
    const timer = setTimeout(() => done(false), 10000)
  })
  editor.selection = selection
  if (!await seen) throw new Error(`the selection ${JSON.stringify(selection)} was never reported back`)
  await decorationsSettled()
}

const setCaret = (editor, line, col) => select(editor, new vscode.Selection(line, col, line, col))

/** Until the shorthand rewriter is done with the last keystroke in `doc`: it answers one with
    an edit of its own, and so may the comment closer, a round trip that takes much longer on
    a loaded machine. Typing on before it lands makes VS Code drop its edit as stale. Settled
    means no edit in flight and the document unchanged across two looks. */
async function rewriterSettled(doc, ms = 10000) {
  let version = -1
  const quiet = await settled(async () => {
    const s = await vscode.commands.executeCommand('isabelle.shorthandsState')
    const still = s.rewritesInFlight === 0 && s.commentEditsInFlight === 0 && doc.version === version
    version = doc.version
    return still
  }, still => still, ms)
  if (!quiet) throw new Error(`the shorthand rewriter did not settle within ${ms / 1000} s`)
}

module.exports = { wait, settled, decorationsSettled, select, setCaret, rewriterSettled }
