/* Make a `\<forall>` escape behave like one character for the caret.
 *
 * VS Code has no API to mark a text range atomic, so the motion commands are
 * rebound and delegate to the built-ins whenever the rule does not apply.
 * Scope limit: only a single, empty selection is intercepted. Multi-cursor and
 * existing selections fall through to normal behaviour rather than risking
 * a wrong guess about what the built-in would have done.
 *
 * Word-wise motion (ctrl+arrow) needs none of this - it is handled declaratively by
 * the per-language editor.wordSeparators default in package.json, and double-click
 * selection by the wordPattern in language-configuration.json.
 */

import * as vscode from 'vscode'
import { SYMBOL_RE } from './symbols'

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

/** The escape ending exactly at `pos`, or strictly containing it. */
function escapeBefore(doc: vscode.TextDocument, pos: vscode.Position): vscode.Range | undefined {
  return escapesOnLine(doc, pos.line).find(r =>
    r.end.character === pos.character || (r.start.character < pos.character && pos.character < r.end.character))
}

/** The escape starting exactly at `pos`, or strictly containing it. */
function escapeAfter(doc: vscode.TextDocument, pos: vscode.Position): vscode.Range | undefined {
  return escapesOnLine(doc, pos.line).find(r =>
    r.start.character === pos.character || (r.start.character < pos.character && pos.character < r.end.character))
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
  pick: (doc: vscode.TextDocument, pos: vscode.Position) => vscode.Range | undefined,
  target: 'start' | 'end',
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

  const range = pick(editor.document, pos)
  if (!range) { await vscode.commands.executeCommand(builtin); return }

  const to = target === 'start' ? range.start : range.end
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

export function registerAtomicMotion(context: vscode.ExtensionContext): void {
  const reg = (id: string, fn: () => Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn))

  reg('isabelle.cursorLeft', () => move('cursorLeft', escapeBefore, 'start', false))
  reg('isabelle.cursorRight', () => move('cursorRight', escapeAfter, 'end', false))
  reg('isabelle.cursorLeftSelect', () => move('cursorLeftSelect', escapeBefore, 'start', true))
  reg('isabelle.cursorRightSelect', () => move('cursorRightSelect', escapeAfter, 'end', true))
  reg('isabelle.deleteLeft', () => remove('deleteLeft', escapeBefore))
  reg('isabelle.deleteRight', () => remove('deleteRight', escapeAfter))
}

export const _test = { escapesOnLine, escapeBefore, escapeAfter }
