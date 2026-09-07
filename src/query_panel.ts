/* Query panel: find_theorems and find_consts, mirroring Isabelle/jEdit's Query dockable.
 *
 * These need server support that released Isabelle does not have. jEdit reaches them by
 * building a Query_Operation directly in-process; the language server uses exactly the
 * same class for Sledgehammer but never exposed the other operation names, so no LSP
 * client can run them. The missing half is the `vscode-query-panel` branch of
 * mirror-isabelle, which adds:
 *
 *   PIDE/query_operations_request -> _response { operations }
 *   PIDE/query_request  { operation, args }
 *   PIDE/query_cancel   { operation }
 *   PIDE/query_locate   { operation }
 *   PIDE/query_status   { operation, message }
 *   PIDE/query_output   { operation, content }
 *
 * The panel is therefore off by default (`isabelle.queryPanel`), rather than shipping a
 * view that silently does nothing against a stock distribution.
 */

import * as vscode from 'vscode'
import { LanguageClient } from 'vscode-languageclient/node'
import { isabelleCss } from './webview'

const FIND_THEOREMS = 'find_theorems'
const FIND_CONSTS = 'find_consts'

export class QueryPanel implements vscode.WebviewViewProvider {
  static readonly viewType = 'isabelle-query'

  private view: vscode.WebviewView | undefined
  private supported: boolean | undefined
  private status = ''
  private output = ''

  constructor(
    private readonly client: LanguageClient,
    private readonly log: (m: string) => void,
  ) {}

  register(disposables: vscode.Disposable[]): void {
    disposables.push(
      vscode.window.registerWebviewViewProvider(QueryPanel.viewType, this,
        { webviewOptions: { retainContextWhenHidden: true } }),
      this.client.onNotification('PIDE/query_operations_response',
        (p: { operations: string[] }) => {
          this.supported = Array.isArray(p.operations) && p.operations.length > 0
          this.log(`query operations: ${JSON.stringify(p.operations)}`)
          this.post({ type: 'supported', supported: this.supported })
        }),
      this.client.onNotification('PIDE/query_status',
        (p: { operation: string; message: string }) => {
          this.status = p.message ?? ''
          this.post({ type: 'status', operation: p.operation, message: this.status })
        }),
      this.client.onNotification('PIDE/query_output',
        (p: { operation: string; content: string }) => {
          this.output = p.content ?? ''
          this.post({ type: 'output', operation: p.operation, content: this.output })
        }),
      vscode.commands.registerCommand('isabelle.findTheorems', async () => {
        await vscode.commands.executeCommand('isabelle-query.focus')
      }),
    )
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.onDidReceiveMessage(async (m: any) => {
      switch (m?.command) {
        case 'apply':
          await this.client.sendNotification('PIDE/query_request',
            { operation: m.operation, args: m.args })
          break
        case 'cancel':
          await this.client.sendNotification('PIDE/query_cancel', { operation: m.operation })
          break
        case 'locate':
          await this.client.sendNotification('PIDE/query_locate', { operation: m.operation })
          break
      }
    })
    const themeListener = vscode.window.onDidChangeActiveColorTheme(() => {
      view.webview.html = this.html()
    })
    view.onDidDispose(() => { themeListener.dispose(); this.view = undefined })
    view.webview.html = this.html()

    // Probe for server support. Released Isabelle never replies, and the panel says so.
    void this.client.sendNotification('PIDE/query_operations_request', {})
    setTimeout(() => {
      if (this.supported === undefined) {
        this.supported = false
        this.post({ type: 'supported', supported: false })
      }
    }, 8000)
  }

  private post(message: unknown): void { void this.view?.webview.postMessage(message) }

  /** Test hooks. */
  get serverSupported(): boolean | undefined { return this.supported }
  get lastOutput(): string { return this.output }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2)
    return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
${isabelleCss()}
  #controls { font-family: var(--vscode-font-family); font-size: 12px; margin-bottom: 8px; }
  #controls label { display: block; margin: 4px 0 2px; }
  #controls input[type=text], #controls select { width: 100%; box-sizing: border-box; padding: 3px;
       color: var(--vscode-input-foreground); background: var(--vscode-input-background);
       border: 1px solid var(--vscode-input-border, transparent); font-family: inherit; }
  #row { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
  #row input[type=number] { width: 70px; padding: 3px;
       color: var(--vscode-input-foreground); background: var(--vscode-input-background);
       border: 1px solid var(--vscode-input-border, transparent); }
  #buttons { display: flex; gap: 6px; margin: 8px 0; font-family: var(--vscode-font-family); }
  #buttons button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
                    border: none; padding: 3px 10px; border-radius: 2px; cursor: pointer; font-size: 12px; }
  #buttons button.secondary { background: var(--vscode-button-secondaryBackground);
                              color: var(--vscode-button-secondaryForeground); }
  #status { font-family: var(--vscode-font-family); font-size: 12px; opacity: .75; }
  #unsupported { display: none; font-family: var(--vscode-font-family); font-size: 12px;
       background: var(--vscode-inputValidation-warningBackground);
       border-left: 3px solid var(--vscode-inputValidation-warningBorder);
       padding: 6px; margin-bottom: 8px; }
  .theorems-only { display: block; }
</style>
</head><body>
<div id="unsupported">
  This Isabelle does not expose query operations over LSP. It needs the
  <code>vscode-query-panel</code> branch of mirror-isabelle, which adds the
  <code>PIDE/query_*</code> messages.
</div>
<div id="controls">
  <label for="operation">Operation</label>
  <select id="operation">
    <option value="${FIND_THEOREMS}">Find Theorems</option>
    <option value="${FIND_CONSTS}">Find Constants</option>
  </select>
  <label for="query">Find</label>
  <input id="query" type="text" autocomplete="off"
         placeholder='e.g. "_ = _" (+) name: Group -name: monoid'>
  <div id="row" class="theorems-only">
    <label for="limit" style="margin:0">Limit</label>
    <input id="limit" type="number" value="40" min="0">
    <label style="margin:0"><input id="dups" type="checkbox"> Duplicates</label>
  </div>
</div>
<div id="buttons">
  <button id="apply">Apply</button>
  <button id="cancel" class="secondary">Cancel</button>
  <button id="locate" class="secondary">Locate</button>
</div>
<div id="status"></div>
<pre id="out" class="source"></pre>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const operation = () => $('operation').value;

  function syncFields() {
    const theorems = operation() === '${FIND_THEOREMS}';
    for (const el of document.querySelectorAll('.theorems-only')) {
      el.style.display = theorems ? 'flex' : 'none';
    }
  }
  $('operation').addEventListener('change', syncFields);
  syncFields();

  function argsFor(op) {
    // Argument lists match Isabelle/jEdit's Query_Dockable exactly.
    return op === '${FIND_THEOREMS}'
      ? [$('limit').value || '40', $('dups').checked ? 'true' : 'false', $('query').value]
      : [$('query').value];
  }

  $('apply').addEventListener('click', () =>
    vscode.postMessage({ command: 'apply', operation: operation(), args: argsFor(operation()) }));
  $('cancel').addEventListener('click', () =>
    vscode.postMessage({ command: 'cancel', operation: operation() }));
  $('locate').addEventListener('click', () =>
    vscode.postMessage({ command: 'locate', operation: operation() }));
  $('query').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      vscode.postMessage({ command: 'apply', operation: operation(), args: argsFor(operation()) });
    }
  });

  // Results are XML, as for Sledgehammer; rebuild as nodes rather than assigning innerHTML.
  function renderOutput(xml) {
    const out = $('out');
    out.textContent = '';
    let parsed;
    try { parsed = new DOMParser().parseFromString('<root>' + xml + '</root>', 'application/xml'); }
    catch (e) { out.textContent = xml; return; }
    if (!parsed || parsed.getElementsByTagName('parsererror').length) { out.textContent = xml; return; }
    const walk = (node, into) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) into.appendChild(document.createTextNode(child.nodeValue));
        else if (child.nodeType === 1) {
          const span = document.createElement('span');
          span.className = child.nodeName;
          walk(child, span);
          into.appendChild(span);
        }
      }
    };
    walk(parsed.documentElement, out);
  }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'status') $('status').textContent = m.message;
    else if (m.type === 'output') renderOutput(m.content);
    else if (m.type === 'supported') {
      $('unsupported').style.display = m.supported ? 'none' : 'block';
      for (const b of document.querySelectorAll('#buttons button')) b.disabled = !m.supported;
    }
  });
</script>
</body></html>`
  }
}
