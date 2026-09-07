/* Theory preview: the rendered document view, as jEdit offers via "Preview".
 *
 *   PIDE/preview_request  { uri, column }
 *   PIDE/preview_response { uri, column, label, content }
 *
 * The reply echoes the column, so the server decides nothing about placement -- it just
 * hands the rendered HTML back for whichever editor column asked. Previews therefore live
 * in editor tabs rather than the side bar, one per column, reused on refresh.
 */

import * as vscode from 'vscode'
import { LanguageClient } from 'vscode-languageclient/node'
import { openIsabelleLink, panelHtml } from './webview'

interface PreviewResponse { uri: string; column: number; label: string; content: string }

export class PreviewPanels {
  private panels = new Map<number, vscode.WebviewPanel>()
  private lastLabel = ''

  constructor(
    private readonly client: LanguageClient,
    private readonly log: (m: string) => void,
  ) {}

  register(disposables: vscode.Disposable[]): void {
    disposables.push(
      this.client.onNotification('PIDE/preview_response',
        (p: PreviewResponse) => this.show(p)),
      vscode.commands.registerCommand('isabelle.preview', () => this.request(false)),
      vscode.commands.registerCommand('isabelle.previewSplit', () => this.request(true)),
      { dispose: () => { for (const p of this.panels.values()) p.dispose(); this.panels.clear() } },
    )
  }

  private async request(split: boolean): Promise<void> {
    const editor = vscode.window.activeTextEditor
    if (!editor || editor.document.languageId !== 'isabelle') {
      void vscode.window.showInformationMessage('Open an Isabelle theory to preview.')
      return
    }
    const current = editor.viewColumn ?? vscode.ViewColumn.One
    const column = split ? current + 1 : current
    await this.client.sendNotification('PIDE/preview_request', {
      uri: this.client.code2ProtocolConverter.asUri(editor.document.uri),
      column,
    })
    this.log(`preview requested for column ${column}`)
  }

  private show(p: PreviewResponse): void {
    const column: vscode.ViewColumn = p.column > 0 ? p.column : vscode.ViewColumn.One
    this.lastLabel = p.label ?? ''

    let panel = this.panels.get(column)
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        'isabelle-preview', p.label || 'Isabelle Preview', column,
        { enableScripts: true, retainContextWhenHidden: true })
      panel.onDidDispose(() => this.panels.delete(column))
      panel.webview.onDidReceiveMessage(async (m: { command?: string; link?: string }) => {
        if (m.command === 'open' && m.link) await openIsabelleLink(m.link)
      })
      this.panels.set(column, panel)
    }
    panel.title = p.label || 'Isabelle Preview'
    panel.webview.html = panelHtml(panel.webview, p.content ?? '')
  }

  /** Test hooks. */
  get openColumns(): number[] { return [...this.panels.keys()] }
  get label(): string { return this.lastLabel }
}
