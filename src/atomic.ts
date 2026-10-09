/* Make a `\<forall>` escape behave like one character for the caret.
 *
 * VS Code has no API to mark a text range atomic, so the motion commands are
 * rebound and delegate to the built-ins whenever the rule does not apply.
 * Scope limit: only a single, empty selection is intercepted. Multi-cursor and
 * existing selections fall through to normal behaviour rather than risking
 * a wrong guess about what the built-in would have done.
 *
 * Word motion (Ctrl+arrow, Ctrl+Backspace/Delete) is rebound the same way, because
 * editor.wordSeparators classifies single characters and cannot tell `\<alpha>`, which
 * belongs inside a name, from `\<open>`, which does not (see words.ts). Moves that cross
 * a line break are ours too; deletions that would join lines stay with the built-ins.
 *
 * A rebound key is only bound where it changes the result: next to a rendered symbol, and
 * for word motion on lines with `\`, `<` or `>`. Context keys say where that is. Bound
 * everywhere, every Backspace made a round trip through the extension host while letters
 * went straight into the editor, so a Backspace typed before a letter often ran after it
 * and deleted that letter instead. A key can lag behind the caret too: a native Backspace
 * or Delete then cuts a symbol in half, and `repairCut` deletes the rest; a native arrow
 * steps into one, and `repairStep` moves on to its other edge.
 */

import * as vscode from 'vscode'
import { SYMBOL_RE, SymbolTable } from './symbols'
import { Unit, deleteWordLeftFrom, deleteWordRightTo, separatorClassifier, symbolClass,
         toUnits, wordEndRight, wordLeft } from './words'

let table: SymbolTable | undefined

/** All symbol escapes on the given line. */
function escapesOnLine(doc: vscode.TextDocument, line: number): vscode.Range[] {
  const text = doc.lineAt(line).text
  const out: vscode.Range[] = []
  SYMBOL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SYMBOL_RE.exec(text)) !== null) {
    out.push(new vscode.Range(line, m.index, line, m.index + m[0].length))
  }
  return out
}

/**
 * Only escapes that are actually drawn as a glyph behave atomically. Navigation must
 * match what the user sees: an escape shown as raw text - because etc/symbols gives it
 * no codepoint (`\<notasymbol>`, and 140 of List.thy's 5097 occurrences), or because the
 * caret is inside it and it has been revealed - must be walked one character at a time,
 * or it would be visible but unreachable.
 */
function isRendered(doc: vscode.TextDocument, range: vscode.Range, caret: vscode.Position): boolean {
  if (!table?.glyphOf(doc.getText(range))) return false
  if (range.start.isBefore(caret) && caret.isBefore(range.end)) return false
  return true
}

/** The escape ending exactly at `pos`, or strictly containing it. */
function escapeBefore(doc: vscode.TextDocument, pos: vscode.Position): vscode.Range | undefined {
  return escapesOnLine(doc, pos.line).find(r =>
    (r.end.character === pos.character || (r.start.character < pos.character && pos.character < r.end.character)) &&
    isRendered(doc, r, pos))
}

/** The escape starting exactly at `pos`, or strictly containing it. */
function escapeAfter(doc: vscode.TextDocument, pos: vscode.Position): vscode.Range | undefined {
  return escapesOnLine(doc, pos.line).find(r =>
    (r.start.character === pos.character || (r.start.character < pos.character && pos.character < r.end.character)) &&
    isRendered(doc, r, pos))
}

/**
 * The line as word units, each rendered symbol one of them. Every line goes through here,
 * not just those with symbols, so `\`, `<` and `>` separate the same way on all of them.
 */
function lineUnits(doc: vscode.TextDocument, line: number, caret: vscode.Position): Unit[] {
  const atoms = escapesOnLine(doc, line).filter(r => isRendered(doc, r, caret))
  const separators = vscode.workspace.getConfiguration('editor', doc).get<string>('wordSeparators') ?? ''
  return toUnits(
    doc.lineAt(line).text,
    atoms.map(r => ({ start: r.start.character, end: r.end.character, cls: symbolClass(doc.getText(r)) })),
    separatorClassifier(separators))
}

/** Ctrl+Left. At a line start the built-in steps to the previous line's end first. */
function wordLeftTarget(doc: vscode.TextDocument, pos: vscode.Position): vscode.Position | undefined {
  let line = pos.line
  let ch = pos.character
  if (ch === 0) {
    if (line === 0) return undefined
    line--
    ch = doc.lineAt(line).text.length
  }
  return new vscode.Position(line, wordLeft(lineUnits(doc, line, pos), ch))
}

/** Ctrl+Right. At a line end the built-in steps to the next line's start first. */
function wordRightTarget(doc: vscode.TextDocument, pos: vscode.Position): vscode.Position | undefined {
  let line = pos.line
  let ch = pos.character
  if (ch === doc.lineAt(line).text.length) {
    if (line === doc.lineCount - 1) return undefined
    line++
    ch = 0
  }
  return new vscode.Position(line, wordEndRight(lineUnits(doc, line, pos), ch))
}

const isBlank = (c: string | undefined) => c === ' ' || c === '\t'

/**
 * Ctrl+Backspace. Joining lines, and the built-in's rule that two or more blanks before
 * the caret are deleted on their own, involve no symbol and stay with the built-in.
 */
function wordLeftDeletion(doc: vscode.TextDocument, pos: vscode.Position): vscode.Range | undefined {
  if (pos.character === 0) return undefined
  const text = doc.lineAt(pos.line).text
  if (isBlank(text[pos.character - 1]) && isBlank(text[pos.character - 2])) return undefined
  const from = deleteWordLeftFrom(lineUnits(doc, pos.line, pos), pos.character)
  return new vscode.Range(pos.line, from, pos.line, pos.character)
}

/** Ctrl+Delete. Blanks after the caret are deleted on their own, as by the built-in. */
function wordRightDeletion(doc: vscode.TextDocument, pos: vscode.Position): vscode.Range | undefined {
  const text = doc.lineAt(pos.line).text
  if (pos.character === text.length || isBlank(text[pos.character])) return undefined
  const to = deleteWordRightTo(lineUnits(doc, pos.line, pos), pos.character)
  return new vscode.Range(pos.line, pos.character, pos.line, to)
}

function singleEmptySelection(editor: vscode.TextEditor): vscode.Position | undefined {
  if (editor.selections.length !== 1) return undefined
  const sel = editor.selections[0]
  return sel.isEmpty ? sel.active : undefined
}

/* isabelle.renderSymbols, read when it changes rather than on every keystroke. */
let symbolsRendered = true
const readEnabled = () => {
  symbolsRendered = vscode.workspace.getConfiguration('isabelle').get<boolean>('renderSymbols', true)
}

function enabled(): boolean {
  return symbolsRendered
}

async function move(
  builtin: string,
  target: (doc: vscode.TextDocument, pos: vscode.Position) => vscode.Position | undefined,
  select: boolean,
): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.languageId !== 'isabelle' || !enabled()) {
    await vscode.commands.executeCommand(builtin); return
  }
  const pos = select
    ? (editor.selections.length === 1 ? editor.selections[0].active : undefined)
    : singleEmptySelection(editor)
  if (!pos) { await vscode.commands.executeCommand(builtin); return }

  const to = target(editor.document, pos)
  if (!to) { await vscode.commands.executeCommand(builtin); return }

  const anchor = select ? editor.selections[0].anchor : to
  editor.selection = new vscode.Selection(anchor, to)
  editor.revealRange(new vscode.Range(to, to))
}

async function remove(
  builtin: string,
  pick: (doc: vscode.TextDocument, pos: vscode.Position) => vscode.Range | undefined,
): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.languageId !== 'isabelle' || !enabled()) {
    await vscode.commands.executeCommand(builtin); return
  }
  const pos = singleEmptySelection(editor)
  if (!pos) { await vscode.commands.executeCommand(builtin); return }

  const range = pick(editor.document, pos)
  if (!range) { await vscode.commands.executeCommand(builtin); return }

  await editor.edit(b => b.delete(range))
}

/* Context keys of the keybindings in package.json: where a rebound key does anything. */
const KEYS = {
  left: 'isabelle.atomicLeft',
  right: 'isabelle.atomicRight',
  words: 'isabelle.atomicWords',
} as const
type Key = keyof typeof KEYS
const keyState: Record<Key, boolean | undefined> = { left: undefined, right: undefined, words: undefined }

/** The characters that words.ts separates but the Isabelle default wordSeparators do not. */
const hasWordSymbols = (text: string) => /[\\<>]/.test(text)

/** Can word motion from `pos` end up anywhere else than the built-in's? Also across a line break. */
function wordsDiffer(doc: vscode.TextDocument, pos: vscode.Position): boolean {
  const text = doc.lineAt(pos.line).text
  if (hasWordSymbols(text)) return true
  if (pos.character === 0 && pos.line > 0) return hasWordSymbols(doc.lineAt(pos.line - 1).text)
  if (pos.character === text.length && pos.line < doc.lineCount - 1) {
    return hasWordSymbols(doc.lineAt(pos.line + 1).text)
  }
  return false
}

/** Set the context keys for the caret of `editor`, sending only those that changed. */
function updateKeys(editor: vscode.TextEditor | undefined): void {
  const next: Record<Key, boolean> = { left: false, right: false, words: false }
  if (editor && editor.document.languageId === 'isabelle' && enabled() &&
      editor.selections.length === 1) {
    const doc = editor.document
    const pos = editor.selection.active
    next.left = escapeBefore(doc, pos) !== undefined
    next.right = escapeAfter(doc, pos) !== undefined
    next.words = wordsDiffer(doc, pos)
  }
  for (const key of Object.keys(KEYS) as Key[]) {
    if (keyState[key] === next[key]) continue
    keyState[key] = next[key]
    void vscode.commands.executeCommand('setContext', KEYS[key], next[key])
  }
}

/** The caret's line as of the last event, to tell what a later deletion removed. */
let snapshot: { uri: string; version: number; line: number; text: string; caret: number } | undefined

function takeSnapshot(editor: vscode.TextEditor | undefined): void {
  snapshot = undefined
  if (!editor || editor.document.languageId !== 'isabelle') return
  const pos = singleEmptySelection(editor)
  if (!pos) return
  const doc = editor.document
  snapshot = {
    uri: doc.uri.toString(), version: doc.version, line: pos.line,
    text: doc.lineAt(pos.line).text, caret: pos.character,
  }
}

/**
 * A native Backspace or Delete that took one character off a rendered symbol, because
 * the context key had not caught up with the caret yet: delete the rest of it, as the
 * rebound key would have. Only a deletion of the symbol's last character with the caret
 * at its end, or of its first with the caret at its start, qualifies, against the line as
 * it was just before -- never undo or redo. The edit joins the deletion's undo step, and
 * VS Code drops it if more typing has changed the document in the meantime.
 */
function repairCut(e: vscode.TextDocumentChangeEvent): void {
  const snap = snapshot
  if (!snap || e.reason !== undefined || e.contentChanges.length !== 1 || !enabled()) return
  const change = e.contentChanges[0]
  const doc = e.document
  if (change.text !== '' || change.rangeLength !== 1 || change.range.start.line !== snap.line ||
      doc.uri.toString() !== snap.uri || doc.version !== snap.version + 1) return
  const at = change.range.start.character

  SYMBOL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SYMBOL_RE.exec(snap.text)) !== null) {
    const start = m.index
    const end = start + m[0].length
    const backspace = snap.caret === end && at === end - 1
    const del = snap.caret === start && at === start
    if (!(backspace || del) || !table?.glyphOf(m[0])) continue
    const rest = new vscode.Range(snap.line, start, snap.line, end - 1)
    if (doc.getText(rest) !== (backspace ? m[0].slice(0, -1) : m[0].slice(1))) return
    const editor = vscode.window.visibleTextEditors.find(ed => ed.document === doc)
    void editor?.edit(b => b.delete(rest), { undoStopBefore: false, undoStopAfter: false })
    return
  }
}

/**
 * The same for the arrows: a native Left or Right (or Shift+) that stepped from a rendered
 * symbol's edge one character into it moves on to its other edge, as the rebound key
 * would have. Only from the edge the caret was at before, with no edit in between, and
 * not for a click, which may well mean to go inside.
 */
function repairStep(e: vscode.TextEditorSelectionChangeEvent): void {
  const snap = snapshot
  const editor = e.textEditor
  const doc = editor.document
  if (!snap || e.kind === vscode.TextEditorSelectionChangeKind.Mouse || !enabled() ||
      e.selections.length !== 1 || doc.uri.toString() !== snap.uri || doc.version !== snap.version) return
  const { anchor, active } = e.selections[0]
  if (active.line !== snap.line || Math.abs(active.character - snap.caret) !== 1) return

  SYMBOL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SYMBOL_RE.exec(snap.text)) !== null) {
    const start = m.index
    const end = start + m[0].length
    const left = snap.caret === end && active.character === end - 1
    const right = snap.caret === start && active.character === start + 1
    if (!(left || right) || !table?.glyphOf(m[0])) continue
    const to = new vscode.Position(snap.line, left ? start : end)
    editor.selection = new vscode.Selection(anchor.isEqual(active) ? to : anchor, to)
    return
  }
}

export function registerAtomicMotion(context: vscode.ExtensionContext, symbols: SymbolTable): void {
  table = symbols
  readEnabled()
  const reg =(id: string, fn: () => Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn))

  const follow = (editor: vscode.TextEditor | undefined) => {
    updateKeys(editor)
    takeSnapshot(editor)
  }
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(e => {
      if (e.textEditor !== vscode.window.activeTextEditor) return
      repairStep(e)
      follow(e.textEditor)
    }),
    vscode.window.onDidChangeActiveTextEditor(follow),
    /* Delete leaves the caret where it is, so no selection event follows it, yet what
       sits next to the caret has changed. Only then: after any other edit the selection
       here is still the one from before it, and following that too made the keys flip
       back and forth on every keystroke, one message to the window each. */
    vscode.workspace.onDidChangeTextDocument(e => {
      repairCut(e)
      const editor = vscode.window.activeTextEditor
      if (editor?.document === e.document && e.contentChanges.every(c =>
          c.text === '' && c.range.start.isEqual(editor.selection.active))) {
        follow(editor)
      }
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('isabelle.renderSymbols')) return
      readEnabled()
      follow(vscode.window.activeTextEditor)
    }),
    // Test hook: the context keys as last set.
    vscode.commands.registerCommand('isabelle.atomicContext', () => ({ ...keyState })),
  )
  follow(vscode.window.activeTextEditor)

  // Test hook: report the decision (jump or delegate) without moving anything.
  // Asserting on a built-in's *effect* is unreliable when the test window is unfocused;
  // this exposes the logic that is actually ours.
  context.subscriptions.push(
    vscode.commands.registerCommand('isabelle.atomicProbe', (direction: 'left' | 'right') => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return undefined
      const caret = editor.selection.active
      const range = direction === 'left'
        ? escapeBefore(editor.document, caret)
        : escapeAfter(editor.document, caret)
      return range
        ? {
            delegate: false,
            target: direction === 'left' ? range.start.character : range.end.character,
            text: editor.document.getText(range),
          }
        : { delegate: true }
    }),
  )
  // The same for word motion: where Ctrl+Left/Right would land, or that it delegates.
  context.subscriptions.push(
    vscode.commands.registerCommand('isabelle.wordProbe', (direction: 'left' | 'right') => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return undefined
      const caret = editor.selection.active
      const to = direction === 'left'
        ? wordLeftTarget(editor.document, caret)
        : wordRightTarget(editor.document, caret)
      return to ? { delegate: false, line: to.line, target: to.character } : { delegate: true }
    }),
  )

  const charLeft = (doc: vscode.TextDocument, pos: vscode.Position) => escapeBefore(doc, pos)?.start
  const charRight = (doc: vscode.TextDocument, pos: vscode.Position) => escapeAfter(doc, pos)?.end
  reg('isabelle.cursorLeft', () => move('cursorLeft', charLeft, false))
  reg('isabelle.cursorRight', () => move('cursorRight', charRight, false))
  reg('isabelle.cursorLeftSelect', () => move('cursorLeftSelect', charLeft, true))
  reg('isabelle.cursorRightSelect', () => move('cursorRightSelect', charRight, true))
  reg('isabelle.deleteLeft', () => remove('deleteLeft', escapeBefore))
  reg('isabelle.deleteRight', () => remove('deleteRight', escapeAfter))

  reg('isabelle.cursorWordLeft', () => move('cursorWordLeft', wordLeftTarget, false))
  reg('isabelle.cursorWordEndRight', () => move('cursorWordEndRight', wordRightTarget, false))
  reg('isabelle.cursorWordLeftSelect', () => move('cursorWordLeftSelect', wordLeftTarget, true))
  reg('isabelle.cursorWordEndRightSelect', () => move('cursorWordEndRightSelect', wordRightTarget, true))
  reg('isabelle.deleteWordLeft', () => remove('deleteWordLeft', wordLeftDeletion))
  reg('isabelle.deleteWordRight', () => remove('deleteWordRight', wordRightDeletion))
}

export const _test = { escapesOnLine, escapeBefore, escapeAfter }
