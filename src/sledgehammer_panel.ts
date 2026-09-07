/* Sledgehammer control panel.
 *
 * Flow:
 *   PIDE/sledgehammer_provers_request  -> _provers_response {provers}   (prefill)
 *   PIDE/sledgehammer_request {provers, isar, try0}                     (run)
 *   PIDE/sledgehammer_status {message} / _output {content}              (progress, results)
 *   PIDE/sledgehammer_sendback {text}  -> _insert {uri, line, character, text}
 *
 * The results are raw XML (VSCode_Sledgehammer uses XML.string_of_body, so this is not
 * affected by vscode_html_output). Proof suggestions arrive as <sendback> *elements*,
 * not as a CSS class, so the webview rewrites those into buttons.
 *
 * Note that sendback also reaches the editor as ordinary LSP code actions, which need
 * no code at all; this panel is about driving the search rather than applying a result.
 */

import * as vscode from 'vscode'
import { LanguageClient } from 'vscode-languageclient/node'
import { isabelleCss } from './webview'

interface InsertParams { uri: string; line: number; character: number; text: string }

export class SledgehammerPanel implements vscode.WebviewViewProvider {
  static readonly viewType = 'isabelle-sledgehammer'

  private view: vscode.WebviewView | undefined
  private provers = ''
  private status = ''
  private output = ''

  constructor(
    private readonly client: LanguageClient,
    private readonly log: (m: string) => void,
  ) {}

  register(disposables: vscode.Disposable[]): void {
    disposables.push(
      vscode.window.registerWebviewViewProvider(SledgehammerPanel.viewType, this,
        { webviewOptions: { retainContextWhenHidden: true } }),
      this.client.onNotification('PIDE/sledgehammer_provers_response',
        (p: { provers: string }) => { this.provers = p.provers ?? ''; this.post({ type: 'provers', provers: this.provers }) }),
      this.client.onNotification('PIDE/sledgehammer_status',
        (p: { message: string }) => { this.status = p.message ?? ''; this.post({ type: 'status', message: this.status }) }),
      this.client.onNotification('PIDE/sledgehammer_output',
        (p: { content: string }) => { this.output = p.content ?? ''; this.post({ type: 'output', content: this.output }) }),
      this.client.onNotification('PIDE/sledgehammer_insert',
        (p: InsertParams) => void this.applyInsert(p)),
      vscode.commands.registerCommand('isabelle.sledgehammer', async () => {
        await vscode.commands.executeCommand('isabelle-sledgehammer.focus')
        await this.run(this.provers, false, true)
      }),
    )
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.onDidReceiveMessage(async (m: any) => {
      switch (m?.command) {
        case 'run': await this.run(m.provers ?? '', !!m.isar, !!m.try0); break
        case 'cancel': await this.client.sendNotification('PIDE/sledgehammer_cancel', {}); break
        case 'locate': await this.client.sendNotification('PIDE/sledgehammer_locate', {}); break
        case 'sendback':
          await this.client.sendNotification('PIDE/sledgehammer_sendback', { text: m.text })
          break
      }
    })
    view.webview.html = this.html()
    // Ask the server for the configured prover list to prefill the input.
    void this.client.sendNotification('PIDE/sledgehammer_provers_request', {})
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message)
  }

  private async run(provers: string, isar: boolean, try0: boolean): Promise<void> {
    this.status = 'Starting…'
    this.post({ type: 'status', message: this.status })
    await this.client.sendNotification('PIDE/sledgehammer_request', { provers, isar, try0 })
  }

  /** The server tells us where the proof method should go; apply it there. */
  private async applyInsert(p: InsertParams): Promise<void> {
    try {
      const uri = vscode.Uri.parse(p.uri)
      const doc = await vscode.workspace.openTextDocument(uri)
      const editor = await vscode.window.showTextDocument(doc, { preview: false })
      const pos = new vscode.Position(p.line, p.character)
      await editor.edit(b => b.insert(pos, p.text))
      this.log(`sledgehammer inserted ${JSON.stringify(p.text)} at ${p.line}:${p.character}`)
    } catch (err) {
      this.log(`sledgehammer insert failed: ${err}`)
    }
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2)
    return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
${isabelleCss()}
  #controls { display: grid; grid-template-columns: auto 1fr; gap: 4px 6px; align-items: center;
              font-family: var(--vscode-font-family); font-size: 12px; margin-bottom: 8px; }
  #controls input[type=text] { width: 100%; box-sizing: border-box; padding: 3px;
       color: var(--vscode-input-foreground); background: var(--vscode-input-background);
       border: 1px solid var(--vscode-input-border, transparent); font-family: inherit; }
  #buttons { display: flex; gap: 6px; margin-bottom: 8px; font-family: var(--vscode-font-family); }
  #buttons button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
                    border: none; padding: 3px 10px; border-radius: 2px; cursor: pointer; font-size: 12px; }
  #buttons button.secondary { background: var(--vscode-button-secondaryBackground);
                              color: var(--vscode-button-secondaryForeground); }
  #status { font-family: var(--vscode-font-family); font-size: 12px; opacity: .75; margin-bottom: 6px; }
  #out button.sendback { display: block; margin: 3px 0; text-align: left; cursor: pointer;
       font-family: inherit; font-size: inherit;
       background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
       border: 1px solid var(--vscode-focusBorder); border-radius: 3px; padding: 2px 6px; }
  #out button.sendback:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
</style>
</head><body>
<div id="controls">
  <label for="provers">Provers</label><input id="provers" type="text" autocomplete="off">
  <label for="isar">Isar proofs</label><input id="isar" type="checkbox">
  <label for="try0">try0</label><input id="try0" type="checkbox" checked>
</div>
<div id="buttons">
  <button id="run">Run</button>
  <button id="cancel" class="secondary">Cancel</button>
  <button id="locate" class="secondary">Locate</button>
</div>
<div id="status"></div>
<pre id="out" class="source"></pre>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);

  $('run').addEventListener('click', () => vscode.postMessage({
    command: 'run', provers: $('provers').value, isar: $('isar').checked, try0: $('try0').checked }));
  $('cancel').addEventListener('click', () => vscode.postMessage({ command: 'cancel' }));
  $('locate').addEventListener('click', () => vscode.postMessage({ command: 'locate' }));

  // Results arrive as XML; <sendback> elements are the clickable proof suggestions.
  // Parsed as data and rebuilt with createElement/createTextNode rather than assigned
  // to innerHTML: the text can include content echoed from theory files, and this way
  // nothing in it is ever interpreted as markup.
  function renderOutput(xml) {
    const out = $('out');
    out.textContent = '';
    let parsed;
    try { parsed = new DOMParser().parseFromString('<root>' + xml + '</root>', 'application/xml'); }
    catch (e) { out.textContent = xml; return; }
    if (!parsed || parsed.getElementsByTagName('parsererror').length) { out.textContent = xml; return; }

    const walk = (node, into) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          into.appendChild(document.createTextNode(child.nodeValue));
        } else if (child.nodeType === 1) {
          if (child.nodeName === 'sendback') {
            const text = child.textContent.trim();
            const button = document.createElement('button');
            button.className = 'sendback';
            button.textContent = text;
            button.addEventListener('click', () => vscode.postMessage({ command: 'sendback', text }));
            into.appendChild(button);
          } else {
            const span = document.createElement('span');
            span.className = child.nodeName;
            walk(child, span);
            into.appendChild(span);
          }
        }
      }
    };
    walk(parsed.documentElement, out);
  }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'provers') $('provers').value = m.provers;
    else if (m.type === 'status') $('status').textContent = m.message;
    else if (m.type === 'output') renderOutput(m.content);
  });
</script>
</body></html>`
  }

  /** Test hooks. */
  get lastStatus(): string { return this.status }
  get lastOutput(): string { return this.output }
  get proverList(): string { return this.provers }
}
