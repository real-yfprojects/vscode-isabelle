/* Documentation panel: the Isabelle manuals, as jEdit's Documentation dockable shows them.
 *
 *   PIDE/documentation_request -> PIDE/documentation_response
 *     { sections: [ { title, important, entries: [ { print_html, platform_path } ] } ] }
 *
 * `platform_path` points at a real file in the distribution -- usually a PDF, sometimes a
 * directory or text file -- so entries are opened (openDoc) rather than rendered here.
 */

import * as vscode from 'vscode'
import { LanguageClient } from 'vscode-languageclient/node'
import { CustomEditorContribution, EditorAssociations, pdfViewerRegistered } from './doc_open'
import { isabelleCss, scriptNonce } from './webview'

interface DocEntry { print_html: string; platform_path: string }
interface DocSection { title: string; important: boolean; entries: DocEntry[] }

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** `print_html` is markup; take only its text, so nothing is injected into the panel. */
function plainText(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
}

export class DocumentationPanel implements vscode.WebviewViewProvider {
  static readonly viewType = 'isabelle-documentation'

  private view: vscode.WebviewView | undefined
  private sections: DocSection[] = []

  constructor(
    private readonly client: LanguageClient,
    private readonly log: (m: string) => void,
  ) {}

  register(disposables: vscode.Disposable[]): void {
    disposables.push(
      vscode.window.registerWebviewViewProvider(DocumentationPanel.viewType, this,
        { webviewOptions: { retainContextWhenHidden: true } }),
      this.client.onNotification('PIDE/documentation_response',
        (p: { sections: DocSection[] }) => {
          this.sections = p.sections ?? []
          this.log(`documentation: ${this.sections.length} sections, ` +
                   `${this.sections.reduce((n, s) => n + (s.entries?.length ?? 0), 0)} entries`)
          this.render()
        }),
      vscode.commands.registerCommand('isabelle.documentation', async () => {
        await vscode.commands.executeCommand('isabelle-documentation.focus')
      }),
    )
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.onDidReceiveMessage(async (m: { command?: string; arg?: string }) => {
      if (m.command === 'open' && m.arg) await openDoc(m.arg)
    })
    const themeListener = vscode.window.onDidChangeActiveColorTheme(() => this.render())
    view.onDidDispose(() => { themeListener.dispose(); this.view = undefined })
    this.render()
    void this.client.sendNotification('PIDE/documentation_request', {})
  }

  private render(): void {
    if (this.view) this.view.webview.html = this.html()
  }

  /** Test hook. */
  get entryCount(): number {
    return this.sections.reduce((n, s) => n + (s.entries?.length ?? 0), 0)
  }

  private html(): string {
    const body = this.sections.length === 0
      ? '<p style="opacity:.6">Waiting for Isabelle…</p>'
      : this.sections.map(section => {
          const entries = (section.entries ?? []).map(entry => {
            const label = escapeHtml(plainText(entry.print_html) || entry.platform_path)
            return `<button class="doc" data-path="${escapeHtml(entry.platform_path)}" ` +
                   `title="${escapeHtml(entry.platform_path)}">${label}</button>`
          }).join('')
          return `<section><h3${section.important ? ' class="important"' : ''}>` +
                 `${escapeHtml(section.title)}</h3>${entries}</section>`
        }).join('')

    const nonce = scriptNonce()
    return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
${isabelleCss()}
  h3 { font-family: var(--vscode-font-family); font-size: 11px; text-transform: uppercase;
       opacity: .6; margin: 10px 0 4px; }
  h3.important { opacity: .9; }
  button.doc { display: block; width: 100%; text-align: left; cursor: pointer;
       font-family: var(--vscode-font-family); font-size: 12px;
       background: transparent; color: var(--vscode-foreground);
       border: 1px solid transparent; border-radius: 3px; padding: 2px 6px; }
  button.doc:hover { background: var(--vscode-list-hoverBackground);
                     border-color: var(--vscode-focusBorder); }
</style>
</head><body>
${body}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', e => {
    const b = e.target.closest('button.doc');
    if (b) vscode.postMessage({ command: 'open', arg: b.getAttribute('data-path') });
  });
</script>
</body></html>`
  }
}

/**
 * PDFs open in VS Code when something there can show them, and in the system's viewer
 * otherwise (see doc_open.ts); anything else opens as a text document.
 */
async function openDoc(platformPath: string): Promise<void> {
  const uri = vscode.Uri.file(platformPath)
  try {
    if (platformPath.toLowerCase().endsWith('.pdf')) {
      const customEditors = vscode.extensions.all.flatMap(
        e => (e.packageJSON?.contributes?.customEditors ?? []) as CustomEditorContribution[])
      const associations = vscode.workspace.getConfiguration('workbench')
        .get<EditorAssociations>('editorAssociations')
      if (pdfViewerRegistered(platformPath, customEditors, associations)) {
        await vscode.commands.executeCommand('vscode.open', uri)
      } else if (!await vscode.env.openExternal(uri)) {
        void vscode.window.showWarningMessage(`No application opened ${platformPath}.`)
      }
    } else {
      const doc = await vscode.workspace.openTextDocument(uri)
      await vscode.window.showTextDocument(doc)
    }
  } catch (err) {
    void vscode.window.showWarningMessage(`Cannot open ${platformPath}: ${err}`)
  }
}
