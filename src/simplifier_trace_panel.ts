/* Interactive simplifier trace, following the jEdit dockable of that name.
 *
 * Flow:
 *   PIDE/simplifier_trace_request                  -> _response {auto_update, pending, question}
 *   PIDE/simplifier_trace_reply {serial, answer}   (answer the pending question)
 *   PIDE/simplifier_trace_auto_update {enabled}
 *   PIDE/simplifier_trace_clear_memory
 *   PIDE/simplifier_trace_show                     -> _full {entries}
 *
 * The full trace is shown as a tree in an editor tab (TraceTreeView below) and kept
 * current while that tab is open: every response -- an answer, a caret move -- asks for
 * the trace again, so the tree grows as you step and follows the command under the caret.
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
import { isabelleCss, openIsabelleLink, scriptNonce } from './webview'
import { TraceAnswer, TraceEntry, TraceQuestion, TraceResponse, answerButtons, statusLine }
  from './simplifier_trace_view'
import { TraceStats, buildTraceTree, renderTraceTree, statsLine, traceStats }
  from './simplifier_trace_tree'

export { TraceAnswer, TraceEntry, TraceQuestion, TraceResponse, answerButtons, statusLine }
  from './simplifier_trace_view'

export class SimplifierTracePanel implements vscode.WebviewViewProvider {
  static readonly viewType = 'isabelle-simplifier-trace'

  private view: vscode.WebviewView | undefined
  private state: TraceResponse | undefined
  private supported = false
  /* Kept so the full trace can be asserted on. It arrives by a different server path
     than the question does -- generate_trace re-assembles from Command.Results rather
     than reading the manager's context -- so it can break on its own. */
  private lastFull: TraceEntry[] | undefined
  /* Counted because some server actions republish state that is identical to what is
     already shown -- clear_memory is the clear case. Without a count there is no way to
     tell "the server accepted the message and refreshed" from "the message went
     nowhere". */
  private responses = 0
  private readonly tree: TraceTreeView

  constructor(
    private readonly client: LanguageClient,
    private readonly log: (m: string) => void,
  ) {
    this.tree = new TraceTreeView(() => this.showTrace())
  }

  register(disposables: vscode.Disposable[]): void {
    disposables.push(
      vscode.window.registerWebviewViewProvider(SimplifierTracePanel.viewType, this,
        { webviewOptions: { retainContextWhenHidden: true } }),
      this.client.onNotification('PIDE/simplifier_trace_response', (p: TraceResponse) => {
        this.supported = true
        this.state = p
        this.responses++
        this.render()
        this.tree.scheduleRefresh()
      }),
      this.client.onNotification('PIDE/simplifier_trace_full',
        (p: { entries: TraceEntry[] }) => {
          this.lastFull = p.entries ?? []
          this.tree.update(this.lastFull, this.state?.question?.serial)
        }),
      this.tree,
      vscode.commands.registerCommand('isabelle.simplifierTrace', async () => {
        await vscode.commands.executeCommand('isabelle-simplifier-trace.focus')
        this.request()
      }),
      /* Test hooks. The reply one goes through the same `reply` the webview button
         posts, so what suite30 drives is the shipped path and not a parallel one. */
      vscode.commands.registerCommand('isabelle.simplifierTraceReply',
        (serial: number, answer: string) => this.reply(serial, answer)),
      vscode.commands.registerCommand('isabelle.simplifierTraceAutoUpdate',
        (enabled: boolean) => this.setAutoUpdate(enabled)),
      vscode.commands.registerCommand('isabelle.simplifierTraceClearMemory',
        () => this.clearMemory()),
      vscode.commands.registerCommand('isabelle.simplifierTraceShow',
        () => this.openTree()),
      vscode.commands.registerCommand('isabelle.simplifierTraceState', () => ({
        supported: this.supported,
        autoUpdate: this.state?.auto_update,
        pending: this.state?.pending ?? 0,
        serial: this.state?.question?.serial,
        answers: this.state?.question?.answers.map(a => a.name) ?? [],
        full: this.lastFull?.length,
        kinds: [...new Set(this.lastFull?.map(e => e.kind))],
        tree: this.tree.lastStats,
        responses: this.responses,
      })),
    )
    this.request()
  }

  get serverSupported(): boolean { return this.supported }

  private request(): void {
    void this.client.sendNotification('PIDE/simplifier_trace_request', {})
      .catch(err => this.log(`simplifier_trace_request failed: ${err}`))
  }

  private setAutoUpdate(enabled: boolean): void {
    void this.client.sendNotification('PIDE/simplifier_trace_auto_update', { enabled })
      .catch(err => this.log(`simplifier_trace_auto_update failed: ${err}`))
  }

  private clearMemory(): void {
    void this.client.sendNotification('PIDE/simplifier_trace_clear_memory', {})
      .catch(err => this.log(`simplifier_trace_clear_memory failed: ${err}`))
  }

  private showTrace(): void {
    void this.client.sendNotification('PIDE/simplifier_trace_show', {})
      .catch(err => this.log(`simplifier_trace_show failed: ${err}`))
  }

  private openTree(): void {
    this.tree.open()
    this.showTrace()
  }

  private reply(serial: number, answer: string): void {
    this.log(`simplifier trace reply: ${answer} for ${serial}`)
    void this.client.sendNotification('PIDE/simplifier_trace_reply', { serial, answer })
      .catch(err => this.log(`simplifier_trace_reply failed: ${err}`))
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.onDidReceiveMessage((msg: { type: string; serial?: number; answer?: string; enabled?: boolean; link?: string }) => {
      switch (msg.type) {
        case 'answer':
          if (msg.serial !== undefined && msg.answer !== undefined) this.reply(msg.serial, msg.answer)
          break
        case 'update': this.request(); break
        case 'autoUpdate': this.setAutoUpdate(msg.enabled === true); break
        case 'clearMemory': this.clearMemory(); break
        case 'showTrace': this.openTree(); break
        case 'open': if (msg.link) void openIsabelleLink(msg.link); break
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
       the full document rather than the fragment this used to return.

       It arrives already wrapped in <pre class="source"> from HTML.source, carrying
       Isabelle's markup classes and entity links, so it needs no wrapper of its own here
       -- isabelleCss() styles both, and a <div> around it would only undo the pre. */
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
      pre.caption { margin-bottom: 0.3rem; font-weight: bold; }
    </style>
</head><body>
    <div class="controls">
      <button class="secondary" id="update">Update</button>
      <button class="secondary" id="showTrace">Show trace tree</button>
      <button class="secondary" id="clearMemory">Clear memory</button>
      <label><input type="checkbox" id="auto" ${state?.auto_update !== false ? 'checked' : ''}> Auto update</label>
    </div>
    <div class="status">${escapeHtml(statusLine(state))}</div>
    ${question ? `<pre class="caption">${escapeHtml(question.text)}</pre>${question.content}` : ''}
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
      // Entity links, as make_html emits them: file:...#line back to the definition.
      document.addEventListener('click', e => {
        const a = e.target.closest('a')
        if (a && a.getAttribute('href')) {
          e.preventDefault()
          vscode.postMessage({ type: 'open', link: a.getAttribute('href') })
        }
      })
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

/**
 * The full trace as a tree, in an editor tab.
 *
 * A tab rather than the side panel: a trace is long and deep, and it is read next to the
 * theory while the side panel is busy asking questions. The page is set up once and fed
 * the tree by message, so re-rendering on every step keeps the scroll position, the
 * filter text and whatever the user opened or closed -- a page rebuilt from scratch on
 * each answer would snap shut under the reader.
 */
class TraceTreeView implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined
  private entries: TraceEntry[] = []
  private pending: number | undefined
  private timer: NodeJS.Timeout | undefined
  /** Test hook: what the last render counted. */
  lastStats: TraceStats | undefined

  constructor(private readonly refresh: () => void) {}

  open(): void {
    if (this.panel) { this.panel.reveal(undefined, true); return }
    const panel = vscode.window.createWebviewPanel('isabelle-simplifier-trace-tree',
      'Simplifier Trace', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true })
    this.panel = panel
    panel.webview.html = treePageHtml()
    panel.webview.onDidReceiveMessage((msg: { type: string; link?: string }) => {
      switch (msg.type) {
        case 'ready': this.post(); break
        case 'refresh': this.refresh(); break
        case 'open': if (msg.link) void openIsabelleLink(msg.link); break
      }
    })
    const theme = vscode.window.onDidChangeActiveColorTheme(() => {
      panel.webview.html = treePageHtml()
    })
    panel.onDidChangeViewState(e => { if (e.webviewPanel.visible) this.refresh() })
    panel.onDidDispose(() => {
      theme.dispose()
      if (this.timer) clearTimeout(this.timer)
      this.panel = undefined
    })
  }

  update(entries: TraceEntry[], pending: number | undefined): void {
    this.entries = entries
    this.pending = pending
    this.post()
  }

  /* Debounced because "Continue (without asking)" turns one click into a burst of
     responses, and each would otherwise re-assemble the whole trace on the server. */
  scheduleRefresh(): void {
    if (!this.panel) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.refresh(), 400)
  }

  private post(): void {
    const roots = buildTraceTree(this.entries)
    const stats = traceStats(roots)
    this.lastStats = stats
    if (!this.panel) return
    const pending = this.pending
    const summary = roots.length === 0 ? '' :
      statsLine(stats) + (pending !== undefined ? ' · ⏸ waiting for your answer' : '')
    void this.panel.webview.postMessage({
      type: 'tree', html: renderTraceTree(roots, pending), summary, pending,
    })
  }

  dispose(): void { this.panel?.dispose() }
}

function treePageHtml(): string {
  const nonce = scriptNonce()
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${isabelleCss()}
  body { background-color: var(--vscode-editor-background); padding: 0 0.8rem 2rem; }
  .ui { font-family: var(--vscode-font-family); font-size: 12px; }
  .toolbar { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; gap: 0.35rem;
             align-items: center; padding: 0.5rem 0 0.4rem;
             background-color: var(--vscode-editor-background); }
  .toolbar button { font: inherit; padding: 0.2rem 0.6rem; cursor: pointer; border: none;
                    color: var(--vscode-button-secondaryForeground);
                    background: var(--vscode-button-secondaryBackground); }
  .toolbar input[type=search] { flex: 1 1 14rem; min-width: 8rem; padding: 0.2rem 0.4rem; font: inherit;
                    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
                    border: 1px solid var(--vscode-input-border, transparent); }
  .legend, #summary { opacity: 0.8; margin: 0.15rem 0; }
  #summary { font-weight: 600; }
  .empty { font-family: var(--vscode-font-family); opacity: 0.8; }
  ul.trace-tree, ul.trace-tree ul { list-style: none; margin: 0; }
  ul.trace-tree { padding: 0.3rem 0 0; }
  ul.trace-tree ul { padding-left: 0.9rem; margin-left: 0.45rem;
    border-left: 1px solid var(--vscode-tree-indentGuidesStroke, rgba(128,128,128,0.4)); }
  summary { display: flex; gap: 0.45rem; align-items: baseline; cursor: pointer;
            list-style: none; white-space: nowrap; padding: 1px 3px; border-radius: 3px; }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: '▸'; flex: none; width: 0.8em; opacity: 0.7; }
  details[open] > summary::before { content: '▾'; }
  summary:hover { background: var(--vscode-list-hoverBackground); }
  .badge { flex: none; width: 1.1em; text-align: center; font-weight: bold; }
  .outcome-rewrote > details > summary .badge { color: var(--vscode-testing-iconPassed, #3fb950); }
  .outcome-failed > details > summary .badge { color: var(--vscode-testing-iconFailed, #f85149); }
  .outcome-none > details > summary { opacity: 0.7; }
  .outcome-pending > details > summary { background: var(--vscode-editor-findMatchHighlightBackground);
    outline: 1px solid var(--vscode-focusBorder); }
  .label { flex: none; font-weight: 600; font-family: var(--vscode-font-family); }
  .kind-recurse > details > summary .label { color: var(--vscode-textLink-foreground); }
  .rule { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; padding: 0 0.35em;
          border-radius: 3px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
  .term { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; opacity: 0.9; }
  .stats { flex: none; opacity: 0.65; font-family: var(--vscode-font-family); font-size: 11px; }
  .detail, .outcome { margin: 0.2rem 0 0.4rem 1.6rem; }
  .outcome { padding-left: 0.5rem; }
  .outcome.rewrote { border-left: 2px solid var(--vscode-testing-iconPassed, #3fb950); }
  .outcome.failed { border-left: 2px solid var(--vscode-testing-iconFailed, #f85149); }
  .outcome .caption { display: block; font-family: var(--vscode-font-family); font-size: 11px;
                      opacity: 0.75; text-transform: uppercase; letter-spacing: 0.04em; }
</style>
</head><body>
<div class="toolbar ui">
  <button id="refresh">Refresh</button>
  <button id="expand">Expand all</button>
  <button id="collapse">Collapse all</button>
  <button id="goto" title="Open and scroll to the step the simplifier is waiting at">Go to pending</button>
  <input id="filter" type="search" placeholder="Filter by rule name or term">
  <label title="Rules that matched but did not apply, outside any traced step. Failures of traced steps are always shown.">
    <input type="checkbox" id="failed" checked> Failed attempts</label>
</div>
<div class="legend ui">✓ rewrote · ✗ matched but did not apply · ⏸ waiting for your answer · · no outcome (skipped, or tracing switched off) — hover a row for details</div>
<div id="summary" class="ui"></div>
<div id="tree"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const tree = $('tree');
  // What the user opened or closed, by serial, so it survives every re-render.
  const toggled = new Map();
  let lastPending;

  const detailsOf = li => li.querySelector(':scope > details');

  tree.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (a && a.getAttribute('href')) {
      e.preventDefault();
      vscode.postMessage({ type: 'open', link: a.getAttribute('href') });
      return;
    }
    const summary = e.target.closest('summary');
    // Runs before the default action flips the details, so the new state is the opposite.
    if (summary) toggled.set(summary.parentElement.parentElement.dataset.serial, !summary.parentElement.open);
  });

  function setAll(open) {
    for (const li of tree.querySelectorAll('li[data-serial]')) {
      detailsOf(li).open = open;
      toggled.set(li.dataset.serial, open);
    }
  }

  function openAncestors(el) {
    for (let p = el.parentElement; p && p !== tree; p = p.parentElement)
      if (p.tagName === 'DETAILS') p.open = true;
  }

  function revealPending() {
    const li = tree.querySelector('li.outcome-pending');
    if (!li) return;
    openAncestors(li);
    detailsOf(li).open = true;
    li.scrollIntoView({ block: 'center' });
  }

  // Children before parents, so a parent stays visible when any descendant matches.
  function applyFilter() {
    const q = $('filter').value.trim().toLowerCase();
    const showFailed = $('failed').checked;
    const items = Array.from(tree.querySelectorAll('li[data-serial]')).reverse();
    const visible = new Set();
    for (const li of items) {
      let show = !q || li.dataset.search.includes(q);
      if (!show)
        for (const c of li.querySelectorAll(':scope > details > ul > li'))
          if (visible.has(c)) { show = true; break; }
      if (!showFailed && li.classList.contains('kind-hint') && li.classList.contains('outcome-failed'))
        show = false;
      li.hidden = !show;
      if (show) visible.add(li);
    }
    if (q) for (const li of visible) if (li.dataset.search.includes(q)) openAncestors(li);
  }

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type !== 'tree') return;
    const y = window.scrollY;
    tree.innerHTML = m.html;
    $('summary').textContent = m.summary;
    const bySerial = new Map();
    for (const li of tree.querySelectorAll('li[data-serial]')) bySerial.set(li.dataset.serial, li);
    for (const [serial, open] of toggled) {
      const li = bySerial.get(serial);
      if (li) detailsOf(li).open = open;
    }
    applyFilter();
    window.scrollTo(0, y);
    // Follow the simplifier: a new question means it moved, and the reader wants to see where.
    if (m.pending !== undefined && m.pending !== lastPending) revealPending();
    lastPending = m.pending;
  });

  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('expand').addEventListener('click', () => setAll(true));
  $('collapse').addEventListener('click', () => setAll(false));
  $('goto').addEventListener('click', revealPending);
  $('filter').addEventListener('input', applyFilter);
  $('failed').addEventListener('change', applyFilter);
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`
}
