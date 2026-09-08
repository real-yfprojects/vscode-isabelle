/* Incoming caret updates: PIDE/caret_update is bidirectional.
 *
 * The client half was missing, which quietly broke every "Locate" action: the panels
 * send PIDE/sledgehammer_locate or PIDE/query_locate, the server resolves the command
 * to a source position via Editor.hyperlink_command and writes PIDE/caret_update back
 * -- and nothing was listening, so the editor never moved. The same message is how the
 * server answers PIDE/goto_command, so any future panel that navigates to a command
 * gets it from here rather than inventing its own message.
 */

import * as vscode from 'vscode'
import { LanguageClient } from 'vscode-languageclient/node'

export type CaretUpdate = {
  uri: string
  line: number
  character: number
  focus: boolean
}

/** Set while we are moving the caret ourselves, so the echo is not sent back. */
let applying = false

export function isApplyingCaretUpdate(): boolean { return applying }

export async function applyCaretUpdate(
  client: LanguageClient,
  p: CaretUpdate,
  log: (m: string) => void,
): Promise<void> {
  let uri: vscode.Uri
  try {
    uri = client.protocol2CodeConverter.asUri(p.uri)
  } catch (err) {
    log(`caret_update: bad uri ${p.uri}: ${err}`)
    return
  }
  const pos = new vscode.Position(Math.max(0, p.line ?? 0), Math.max(0, p.character ?? 0))

  applying = true
  try {
    const doc = await vscode.workspace.openTextDocument(uri)
    // preserveFocus is the inverse of the server's "focus": the server asks to focus the
    // editor when the user explicitly navigated (Locate), and merely to reveal otherwise.
    const editor = await vscode.window.showTextDocument(doc, {
      preserveFocus: !p.focus,
      preview: false,
    })
    editor.selection = new vscode.Selection(pos, pos)
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
  } catch (err) {
    log(`caret_update failed for ${p.uri}: ${err}`)
  } finally {
    applying = false
  }
}

export function registerCaretUpdates(
  disposables: vscode.Disposable[],
  client: LanguageClient,
  log: (m: string) => void,
): void {
  disposables.push(
    client.onNotification('PIDE/caret_update', (p: CaretUpdate) => {
      log(`caret_update in: ${p?.uri} ${p?.line}:${p?.character} focus=${p?.focus}`)
      void applyCaretUpdate(client, p, log)
    }),
  )
}
