/* Guarantee that whatever reaches disk is valid Isabelle ASCII.
 *
 * `isabelle build` rejects literal Unicode outright ("Inner lexical error"), so any
 * Unicode that leaks into the buffer - pasted from a paper, typed with an OS input
 * method, or inserted by a server code action when vscode_unicode_symbols_edits is on -
 * must be rewritten to `\<name>` before saving.
 *
 * This is what the server's own Content.recode_symbols computes, except that method is
 * dead code upstream and never exposed over LSP, so we do it here.
 *
 * onWillSaveTextDocument is preferred over a formatter: it always runs, whereas a
 * formatter needs editor.formatOnSave and can be displaced by editor.defaultFormatter.
 * The transformation must be idempotent - a save participant can fire more than once
 * per save, and encoding already-ASCII text is a no-op, which is what makes it terminate.
 */

import * as vscode from 'vscode'
import { SymbolTable } from './symbols'

/** Minimal per-line edits rewriting Unicode glyphs back to `\<name>` escapes. */
export function encodeEdits(doc: vscode.TextDocument, table: SymbolTable): vscode.TextEdit[] {
  const edits: vscode.TextEdit[] = []
  for (let i = 0; i < doc.lineCount; i++) {
    const line = doc.lineAt(i)
    const encoded = table.encode(line.text)
    if (encoded !== line.text) edits.push(vscode.TextEdit.replace(line.range, encoded))
  }
  return edits
}

export function registerNormalizer(
  context: vscode.ExtensionContext,
  table: SymbolTable,
  log: (msg: string) => void,
): void {
  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument(event => {
      if (event.document.languageId !== 'isabelle') return
      if (!vscode.workspace.getConfiguration('isabelle').get<boolean>('normalizeOnSave', true)) return
      const edits = encodeEdits(event.document, table)
      if (edits.length > 0) {
        log(`normalising ${edits.length} line(s) of Unicode to ASCII escapes before save`)
        event.waitUntil(Promise.resolve(edits))
      }
    }),

    vscode.commands.registerCommand('isabelle.normalizeDocument', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor || editor.document.languageId !== 'isabelle') {
        void vscode.window.showInformationMessage('No Isabelle theory is active.')
        return
      }
      const edits = encodeEdits(editor.document, table)
      if (edits.length === 0) {
        void vscode.window.showInformationMessage('Already pure ASCII - nothing to normalize.')
        return
      }
      const workspaceEdit = new vscode.WorkspaceEdit()
      workspaceEdit.set(editor.document.uri, edits)
      await vscode.workspace.applyEdit(workspaceEdit)
      void vscode.window.showInformationMessage(`Normalized ${edits.length} line(s) to ASCII escapes.`)
    }),
  )
}
