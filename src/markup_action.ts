/* Active markup: the parts of prover output that do something when clicked.
 *
 * Isabelle2026's language server takes them in one generic message, as its own output view
 * sends it (upstream 88bb197c42, "support active markup (sendback and dialog) in language
 * server"):
 *
 *   PIDE/markup_action { active, text }      active: the clicked element, as YXML
 *
 * - A *sendback* (a proof from try0 or Sledgehammer, a proof outline) carries the id of the
 *   command that printed it. The server edits that command's text, as the sendback code
 *   action would, and answers with the edit for the client to apply:
 *
 *     PIDE/document_edit { uri, version?, edit: {range, newText}, line, character }
 *
 *   `line`/`character` is where the inserted text ends, for the caret.
 * - A *dialog* (the choices of "Tracing paused. Stop, or continue with next 100, ...")
 *   carries its own id, serial and result; the server passes the result on to the prover
 *   thread that waits for it, and nothing comes back.
 *
 * The element travels whole, so the server needs no state about what the client shows.
 * Isabelle2025-2 has neither message: a click there is logged and ignored by the server.
 */

import * as vscode from 'vscode'
import { LanguageClient } from 'vscode-languageclient/node'
import { decodeActive } from './pide_html'
import { content, parseYxmlFailsafe } from './yxml'

export interface DocumentEdit {
  uri: string
  version?: number
  edit: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }
  line: number
  character: number
}

/** Pass a click on active markup to the server. */
export function sendMarkupAction(
  client: LanguageClient, active: string, text: string, log: (m: string) => void,
): void {
  void client.sendNotification('PIDE/markup_action', { active, text })
    .catch(err => log(`markup_action failed: ${err}`))
}

/**
 * A click in output the client rendered (pide_html.ts), or that the extended server made
 * the same way: active markup, or a link the server resolves and answers with
 * PIDE/caret_update (caret.ts). The goto messages are Isabelle2026's (upstream's own
 * output view sends them); the definition's file is the server's to map, since `def_file`
 * may be a symbolic path like `~~/src/HOL/Nat.thy`.
 * Returns false for a command that is none of these.
 */
export async function outputCommand(
  client: LanguageClient, command: string, arg: string, log: (m: string) => void,
): Promise<boolean> {
  const notify = (method: string, params: object) =>
    void client.sendNotification(method, params).catch(err => log(`${method} failed: ${err}`))
  switch (command) {
    case 'markupAction': {
      const active = decodeActive(arg)
      sendMarkupAction(client, active, content(parseYxmlFailsafe(active)), log)
      return true
    }
    case 'gotoSource': {
      const p = JSON.parse(arg) as { file: string; line: number; offset: number }
      notify('PIDE/goto_source_file', { name: p.file, line: p.line, offset: p.offset })
      return true
    }
    case 'gotoCommand': {
      const p = JSON.parse(arg) as { id: number; offset: number }
      notify('PIDE/goto_command', { id: p.id, offset: p.offset })
      return true
    }
    case 'gotoFile':
      notify('PIDE/goto_file', { name: arg })
      return true
    case 'openUrl':
      if (/^https?:/i.test(arg)) await vscode.env.openExternal(vscode.Uri.parse(arg))
      return true
  }
  return false
}

/**
 * Apply an edit the server sends for a sendback. The edit is for the document version the
 * server knew; if the text has changed since, its range may no longer be the command's,
 * so it is dropped rather than applied in the wrong place.
 */
export async function applyDocumentEdit(
  p: DocumentEdit, log: (m: string) => void,
): Promise<boolean> {
  try {
    const uri = vscode.Uri.parse(p.uri)
    const doc = await vscode.workspace.openTextDocument(uri)
    if (p.version !== undefined && p.version !== null && doc.version !== p.version) {
      log(`document_edit for ${uri.fsPath} v${p.version} dropped: the document is at v${doc.version}`)
      return false
    }
    const r = p.edit.range
    const range = new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character)
    const edit = new vscode.WorkspaceEdit()
    edit.replace(uri, range, p.edit.newText)
    if (!await vscode.workspace.applyEdit(edit)) {
      log(`document_edit for ${uri.fsPath} was refused`)
      return false
    }
    const editor = await vscode.window.showTextDocument(doc, { preview: false })
    const end = new vscode.Position(p.line, p.character)
    editor.selection = new vscode.Selection(end, end)
    editor.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    return true
  } catch (err) {
    log(`document_edit failed: ${err}`)
    return false
  }
}

export function registerDocumentEdits(
  scope: vscode.Disposable[], client: LanguageClient, log: (m: string) => void,
): void {
  scope.push(client.onNotification('PIDE/document_edit',
    (p: DocumentEdit) => void applyDocumentEdit(p, log)))
}
