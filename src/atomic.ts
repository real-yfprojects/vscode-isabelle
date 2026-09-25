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

function enabled(): boolean {
  return vscode.workspace.getConfiguration('isabelle').get<boolean>('renderSymbols', true)
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

export function registerAtomicMotion(context: vscode.ExtensionContext, symbols: SymbolTable): void {
  table = symbols
  const reg = (id: string, fn: () => Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn))

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
