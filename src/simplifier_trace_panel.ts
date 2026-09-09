/* Interactive simplifier trace, following the jEdit dockable of that name.
 *
 * Flow:
 *   PIDE/simplifier_trace_request                  -> _response {auto_update, pending, question}
 *   PIDE/simplifier_trace_reply {serial, answer}   (answer the pending question)
 *   PIDE/simplifier_trace_auto_update {enabled}
 *   PIDE/simplifier_trace_clear_memory
 *   PIDE/simplifier_trace_show                     -> _full {entries}
 *
 * This panel is unlike the others here. Everything else displays what the prover has
 * already said; this one *answers* it. With [[simp_trace_new]] enabled the simplifier
 * suspends at a rewrite step and waits, so the buttons are not commands to run -- they
 * are the thing the proof is blocked on. A question carries a serial that the reply must
 * quote, because by the time you click, the trace may have moved on.
 *
 * Only the first question is answerable: the simplifier is suspended at exactly one
 * point and the rest are queued behind it. The count is shown so a queue does not look
 * like the trace being finished.
 */

import * as vscode from 'vscode'
import { LanguageClient } from 'vscode-languageclient/node'
import { isabelleCss, scriptNonce } from './webview'
import { TraceAnswer, TraceEntry, TraceQuestion, TraceResponse, answerButtons, statusLine }
  from './simplifier_trace_view'

export { TraceAnswer, TraceEntry, TraceQuestion, TraceResponse, answerButtons, statusLine }
  from './simplifier_trace_view'

export class SimplifierTracePanel implements vscode.WebviewViewProvider {
  static readonly viewType = 'isabelle-simplifier-trace'

  private view: vscode.WebviewView | undefined
  private state: TraceResponse | undefined
  private supported = false

  constructor(
    private readonly client: LanguageClient,
    private readonly log: (m: string) => void,
  ) {}

  register(disposables: vscode.Disposable[]): void {
    disposables.push(
      vscode.window.registerWebviewViewProvider(SimplifierTracePanel.viewType, this,
        { webviewOptions: { retainContextWhenHidden: true } }),
      this.client.onNotification('PIDE/simplifier_trace_response', (p: TraceResponse) => {
        this.supported = true
        this.state = p
        this.render()
      }),
      this.client.onNotification('PIDE/simplifier_trace_full',
        (p: { entries: TraceEntry[] }) => void this.showFullTrace(p.entries ?? [])),
      vscode.commands.registerCommand('isabelle.simplifierTrace', async () => {
        await vscode.commands.executeCommand('isabelle-simplifier-trace.focus')
        this.request()
      }),
      /* Test hooks. The reply one goes through the same `reply` the webview button
         posts, so what suite30 drives is the shipped path and not a parallel one. */
      vscode.commands.registerCommand('isabelle.simplifierTraceReply',
        (serial: number, answer: string) => this.reply(serial, answer)),
      vscode.commands.registerCommand('isabelle.simplifierTraceState', () => ({
        supported: this.supported,
        pending: this.state?.pending ?? 0,
        serial: this.state?.question?.serial,
        answers: this.state?.question?.answers.map(a => a.name) ?? [],
      })),
    )
    this.request()
  }

  get serverSupported(): boolean { return this.supported }

  private request(): void {
    void this.client.sendNotification('PIDE/simplifier_trace_request', {})
      .catch(err => this.log(`simplifier_trace_request failed: ${err}`))
  }

  private reply(serial: number, answer: string): void {
    this.log(`simplifier trace reply: ${answer} for ${serial}`)
    void this.client.sendNotification('PIDE/simplifier_trace_reply', { serial, answer })
      .catch(err => this.log(`simplifier_trace_reply failed: ${err}`))
  }

  private async showFullTrace(entries: TraceEntry[]): Promise<void> {
    /* A document rather than a panel: the full trace is long, wants scrolling and
       searching, and is a snapshot rather than live state. */
    const body = entries.length === 0
      ? 'No trace recorded for this command.'
      : entries.map(e => `${e.serial}  ${e.text}\n${e.content.replace(/<[^>]*>/g, '')}`).join('\n\n')
    const doc = await vscode.workspace.openTextDocument({ content: body, language: 'text' })
    await vscode.window.showTextDocument(doc, { preview: true })
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.onDidReceiveMessage((msg: { type: string; serial?: number; answer?: string; enabled?: boolean }) => {
      switch (msg.type) {
        case 'answer':
          if (msg.serial !== undefined && msg.answer !== undefined) this.reply(msg.serial, msg.answer)
          break
        case 'update': this.request(); break
        case 'autoUpdate':
          void this.client.sendNotification('PIDE/simplifier_trace_auto_update',
            { enabled: msg.enabled === true })
          break
        case 'clearMemory':
          void this.client.sendNotification('PIDE/simplifier_trace_clear_memory', {})
          break
        case 'showTrace':
          void this.client.sendNotification('PIDE/simplifier_trace_show', {})
          break
      }
    })
    this.render()
  }

  private render(): void {
    if (this.view === undefined) return
    this.view.webview.html = this.html()
  }

  private html(): string {
    const state = this.state
    const question = state?.question
    const buttons = answerButtons(question)
      .map(a => `<button class="answer" data-answer="${escapeAttr(a.name)}">${escapeHtml(a.label)}</button>`)
      .join('')

    /* question.content is Isabelle's own rendered HTML -- markup is the point of it, so it
       is interpolated rather than escaped, exactly as the Query and Sledgehammer panels do
       with their prover output. What keeps that safe is the CSP: a theory can put markup
       into a trace question, and `script-src 'nonce-...'` means an injected <script> is
       refused because it cannot know the nonce. The meta only binds inside <head>, hence
       the full document rather than the fragment this used to return. */
    const nonce = scriptNonce()
    return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${isabelleCss()}
      body { padding: 0.5rem; }
      .status { opacity: 0.8; margin-bottom: 0.6rem; }
      .answers { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.7rem; }
      button { font: inherit; padding: 0.2rem 0.6rem; cursor: pointer;
               color: var(--vscode-button-foreground);
               background: var(--vscode-button-background); border: none; }
      button.secondary { color: var(--vscode-button-secondaryForeground);
                         background: var(--vscode-button-secondaryBackground); }
      .controls { display: flex; gap: 0.35rem; margin-bottom: 0.6rem; flex-wrap: wrap; }
      pre { white-space: pre-wrap; margin: 0; }
    </style>
</head><body>
    <div class="controls">
      <button class="secondary" id="update">Update</button>
      <button class="secondary" id="showTrace">Show full trace</button>
      <button class="secondary" id="clearMemory">Clear memory</button>
      <label><input type="checkbox" id="auto" ${state?.auto_update !== false ? 'checked' : ''}> Auto update</label>
    </div>
    <div class="status">${escapeHtml(statusLine(state))}</div>
    ${question ? `<pre>${escapeHtml(question.text)}</pre><div>${question.content}</div>` : ''}
    <div class="answers">${buttons}</div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi()
      const serial = ${question ? question.serial : 'undefined'}
      for (const b of document.querySelectorAll('button.answer')) {
        b.addEventListener('click', () => {
          // Disable at once: the question is gone the moment the reply is sent, and a
          // second click would quote a serial the prover has moved past.
          for (const other of document.querySelectorAll('button.answer')) other.disabled = true
          vscode.postMessage({ type: 'answer', serial, answer: b.dataset.answer })
        })
      }
      document.getElementById('update').addEventListener('click', () => vscode.postMessage({ type: 'update' }))
      document.getElementById('showTrace').addEventListener('click', () => vscode.postMessage({ type: 'showTrace' }))
      document.getElementById('clearMemory').addEventListener('click', () => vscode.postMessage({ type: 'clearMemory' }))
      document.getElementById('auto').addEventListener('change', e =>
        vscode.postMessage({ type: 'autoUpdate', enabled: e.target.checked }))
    </script>
</body></html>`
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}
