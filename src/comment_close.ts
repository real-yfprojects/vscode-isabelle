/* `(*` closes itself with `*)`, and a `*)` typed at the end of the comment goes over it.
 *
 * VS Code's own auto-closing cannot do this: it types over a closer of one character only,
 * so with `(*` as a pair in language-configuration.json, `(* x *)` came out `(* x *)*)`.
 * Here the comment grows out of the pair VS Code does close: a `*` typed between a `(`
 * and the `)` it just closed turns that `)` into `*)`, giving `(*|*)`. A `)` typed after a
 * `*` just before such a closer removes it, and Backspace on the `*` of `(*|*)` leaves
 * `(|)`. The closers put in are remembered, as VS Code remembers its own, so a `*)` in
 * front of one somebody typed by hand stays.
 */

import * as vscode from 'vscode'
import { inLiteral } from './theory_lexer'

/** Where each closer we put in starts (its `*`), per document, kept up with every edit. */
const closers = new Map<vscode.TextDocument, number[]>()

/** The `)` of the `()` VS Code inserted last, valid for the very next keystroke only. */
let paren: { doc: vscode.TextDocument; version: number; offset: number } | undefined

/** Edits made but not yet applied; the tests wait for none. */
let inFlight = 0

export function commentEditsInFlight(): number {
  return inFlight
}

export function registerCommentClosing(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => void onChange(e)),
    vscode.workspace.onDidCloseTextDocument(doc => closers.delete(doc)),
  )
}

/** Move the closers past `change`; one that it touches is gone. */
function shift(list: number[], change: vscode.TextDocumentContentChangeEvent): number[] {
  const { rangeOffset: start, rangeLength: length, text } = change
  return list.flatMap(k => {
    if (start + length <= k) return [k + text.length - length]
    if (start < k + 2 && start + length > k) return []
    return [k]
  })
}

async function onChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
  const doc = event.document
  if (doc.languageId !== 'isabelle' || event.contentChanges.length === 0) return
  const before = closers.get(doc) ?? []
  const last = paren
  paren = undefined

  // Several cursors, or an edit from elsewhere: forget the closers rather than guess.
  if (event.contentChanges.length !== 1) { closers.delete(doc); return }
  const change = event.contentChanges[0]
  const after = shift(before, change)
  if (after.length) closers.set(doc, after)
  else closers.delete(doc)

  const { rangeOffset: at, rangeLength, text } = change
  const char = (offset: number) => doc.getText(
    new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + 1)))
  const isCloser = (offset: number) => after.includes(offset) && char(offset) === '*' && char(offset + 1) === ')'

  if (text === '()' && rangeLength === 0) {
    paren = { doc, version: doc.version, offset: at + 1 }
    return
  }

  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document !== doc || editor.selections.length !== 1) return

  // `(` + `*` before the `)` VS Code just closed: that `)` becomes the comment's `*)`.
  if (text === '*' && rangeLength === 0 && last && last.doc === doc &&
      last.version + 1 === doc.version && last.offset === at &&
      char(at - 1) === '(' && char(at + 1) === ')' && !inLiteral(doc.getText(), at - 1)) {
    const caret = doc.positionAt(at + 1)
    const ok = await edit(editor, doc, new vscode.Range(caret, caret.translate(0, 1)), '*)')
    if (!ok) return
    closers.set(doc, [...(closers.get(doc) ?? []), at + 1])
    // The `*)` went in where the caret was; whether the caret moved along differs.
    const sel = editor.selection
    if (sel.isEmpty && sel.active.isEqual(caret.translate(0, 2))) {
      editor.selection = new vscode.Selection(caret, caret)
    }
    return
  }

  // `*)` typed just before one of our closers: the typed one ends the comment. The `*` of
  // `(*)` opens it instead, so `)` straight after `(*` is just a `)`.
  if (text === ')' && rangeLength === 0 && char(at - 1) === '*' && char(at - 2) !== '(' &&
      isCloser(at + 1)) {
    const end = doc.positionAt(at + 1)
    await edit(editor, doc, new vscode.Range(end, end.translate(0, 2)), '')
    return
  }

  // Backspace on the `*` of `(*|*)`: the comment goes back to the `()` it came from.
  if (text === '' && rangeLength === 1 && char(at - 1) === '(' && isCloser(at)) {
    const start = doc.positionAt(at)
    await edit(editor, doc, new vscode.Range(start, start.translate(0, 1)), '')
  }
}

/** Replace `range`, merged into the keystroke's undo step; false if the edit lost a race. */
async function edit(editor: vscode.TextEditor, doc: vscode.TextDocument,
                    range: vscode.Range, text: string): Promise<boolean> {
  if (editor.document !== doc) return false
  inFlight++
  try {
    return await editor.edit(b => b.replace(range, text), { undoStopBefore: false, undoStopAfter: false })
  } finally {
    inFlight--
  }
}
