/* Graph display, following the Graphview dockable of Isabelle/jEdit.
 *
 * Flow:
 *   PIDE/graphview_request  -> _response { graph?: {nodes, edges}, error? }
 *
 * This one is pull, not push: nothing appears unless a theory asks for it with thy_deps,
 * class_deps, locale_deps, thm_deps or code_deps. jEdit opens the dockable when the user
 * clicks an active area in the output, but Active is jEdit-only, so the server finds the
 * `graphview` markup in the current command's output instead and this panel shows
 * whatever the caret's command produced.
 *
 * Drawn as inline SVG rather than with a graph library: the CSP here forbids remote
 * script, the layout is ours (graphview_layout.ts) because Isabelle's is Swing-bound, and
 * a dependency DAG of this size needs boxes and lines rather than a physics engine.
 */

import * as vscode from 'vscode'
import { LanguageClient } from 'vscode-languageclient/node'
import { isabelleCss, scriptNonce } from './webview'
import { layoutGraph } from './graphview_layout'
import { GraphviewResponse, emptyMessage, escapeHtml, graphSvg } from './graphview_panel_view'

export { GraphviewResponse, emptyMessage, graphSvg } from './graphview_panel_view'

export class GraphviewPanel implements vscode.WebviewViewProvider {
  static readonly viewType = 'isabelle-graphview'

  private view: vscode.WebviewView | undefined
  private state: GraphviewResponse | undefined
  private supported = false

  constructor(
    private readonly client: LanguageClient,
    private readonly log: (m: string) => void,
  ) {}

  register(disposables: vscode.Disposable[]): void {
    disposables.push(
      vscode.window.registerWebviewViewProvider(GraphviewPanel.viewType, this,
        { webviewOptions: { retainContextWhenHidden: true } }),
      this.client.onNotification('PIDE/graphview_response', (p: GraphviewResponse) => {
        this.supported = true
        this.state = p
        this.render()
      }),
      vscode.commands.registerCommand('isabelle.graphview', async () => {
        await vscode.commands.executeCommand('isabelle-graphview.focus')
        this.request()
      }),
      // Test hook.
      vscode.commands.registerCommand('isabelle.graphviewState', () => ({
        supported: this.supported,
        nodes: this.state?.graph?.nodes.length ?? 0,
        edges: this.state?.graph?.edges.length ?? 0,
        error: this.state?.error,
      })),
    )
    this.request()
  }

  get serverSupported(): boolean { return this.supported }

  private request(): void {
    void this.client.sendNotification('PIDE/graphview_request', {})
      .catch(err => this.log(`graphview_request failed: ${err}`))
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.onDidReceiveMessage((msg: { type: string }) => {
      if (msg.type === 'update') this.request()
    })
    this.render()
  }

  private render(): void {
    if (this.view === undefined) return
    this.view.webview.html = this.html()
  }

  private html(): string {
    const graph = this.state?.graph
    const svg = graph !== undefined && graph.nodes.length > 0
      ? graphSvg(layoutGraph(graph))
      : ''
    const nonce = scriptNonce()

    return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${isabelleCss()}
  body { padding: 0.5rem; }
  .controls { margin-bottom: 0.5rem; }
  .empty { opacity: 0.8; }
  .scroll { overflow: auto; max-width: 100%; }
  button { font: inherit; padding: 0.2rem 0.6rem; cursor: pointer;
           color: var(--vscode-button-secondaryForeground);
           background: var(--vscode-button-secondaryBackground); border: none; }
  .node:hover rect { stroke: var(--vscode-focusBorder); }
</style>
</head><body>
<div class="controls">
  <button id="update">Update</button>
  ${graph ? `<span class="empty"> ${graph.nodes.length} nodes, ${graph.edges.length} edges</span>` : ''}
</div>
${svg ? `<div class="scroll">${svg}</div>` : `<div class="empty">${escapeHtml(emptyMessage(this.state))}</div>`}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi()
  document.getElementById('update').addEventListener('click', () => vscode.postMessage({ type: 'update' }))
</script>
</body></html>`
  }
}

