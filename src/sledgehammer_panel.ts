/* Sledgehammer control panel.
 *
 * On the extended server, each run is a job (sledgehammer_jobs.ts): it goes on while the
 * theory is edited, several run at once, and the panel lists them -- where each one runs,
 * how far it is, and what it found, a proof to click in. The controls are the parameters
 * of the next run.
 *
 * On a stock server the panel drives the classic query operation, one run at a time:
 *   PIDE/sledgehammer_provers_request  -> _provers_response {provers}   (prefill)
 *   PIDE/sledgehammer_request {provers, isar, try0}                     (run)
 *   PIDE/sledgehammer_status {message} / _output {content}              (progress, results)
 *   PIDE/sledgehammer_sendback {text}  -> _insert {uri, line, character, text}
 *
 * The results are raw XML (VSCode_Sledgehammer uses XML.string_of_body, so this is not
 * affected by vscode_html_output). Proof suggestions arrive as <sendback> *elements*,
 * not as a CSS class, so the webview rewrites those into buttons.
 */

import * as vscode from 'vscode'
import { LanguageClient } from 'vscode-languageclient/node'
import { markupText, renderMarkup } from './markup_render'
import { HammerOptions, isActive, SledgehammerJobs } from './sledgehammer_jobs'
import { SLEDGEHAMMER_RAN } from './walkthrough'
import { isabelleCss, scriptNonce } from './webview'

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
    /** The jobs, when the server runs them; otherwise the classic single run. */
    readonly jobs?: SledgehammerJobs,
  ) {}

  register(disposables: vscode.Disposable[]): void {
    disposables.push(
      vscode.window.registerWebviewViewProvider(SledgehammerPanel.viewType, this,
        { webviewOptions: { retainContextWhenHidden: true } }),
      this.client.onNotification('PIDE/sledgehammer_provers_response',
        (p: { provers: string }) => {
          this.provers = p.provers ?? ''
          if (this.jobs && !this.jobs.options.provers) this.jobs.options.provers = this.provers
          this.post({ type: 'provers', provers: this.provers })
          this.postOptions()
        }),
      this.client.onNotification('PIDE/sledgehammer_status',
        (p: { message: string }) => { this.status = p.message ?? ''; this.post({ type: 'status', message: this.status }) }),
      this.client.onNotification('PIDE/sledgehammer_output',
        (p: { content: string }) => { this.output = p.content ?? ''; this.post({ type: 'output', content: this.output }) }),
      this.client.onNotification('PIDE/sledgehammer_insert',
        (p: InsertParams) => void this.applyInsert(p)),
      vscode.commands.registerCommand('isabelle.sledgehammer', async () => {
        await vscode.commands.executeCommand('isabelle-sledgehammer.focus')
        if (this.jobs) {
          void vscode.commands.executeCommand('setContext', SLEDGEHAMMER_RAN, true)
          await this.jobs.runAtCursor()
        } else {
          await this.run(this.provers, false, true)
        }
      }),
      // Test hook: the panel's Cancel button, which with jobs cancels them all.
      vscode.commands.registerCommand('isabelle.sledgehammerCancel', () => {
        if (this.jobs) this.jobs.cancelAll()
        else void this.client.sendNotification('PIDE/sledgehammer_cancel', {})
      }),
    )
    if (this.jobs) {
      disposables.push(this.jobs.onDidChange(() => this.postJobs()))
      // The prover list fills the options even before the view is first shown.
      void this.client.sendNotification('PIDE/sledgehammer_provers_request', {})
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    const fill = () => {
      this.post({ type: 'mode', jobs: !!this.jobs })
      this.post({ type: 'provers', provers: this.provers })
      this.postOptions()
      this.post({ type: 'status', message: this.status })
      if (this.output) this.post({ type: 'output', content: this.output })
      this.postJobs()
    }
    // Re-render on theme change: the stylesheet embeds the resolved palette.
    const themeListener = vscode.window.onDidChangeActiveColorTheme(() => {
      view.webview.html = this.html()
      fill()
    })
    view.onDidDispose(() => { themeListener.dispose(); this.view = undefined })
    view.webview.onDidReceiveMessage(async (m: any) => {
      const jobs = this.jobs
      switch (m?.command) {
        case 'ready': fill(); break
        case 'run':
          if (jobs) {
            void vscode.commands.executeCommand('setContext', SLEDGEHAMMER_RAN, true)
            await jobs.runAtCursor(this.lastEditor())
          } else {
            await this.run(m.provers ?? '', !!m.isar, !!m.try0)
          }
          break
        case 'sorries': if (jobs) await jobs.runSorries(this.lastEditor()); break
        case 'options': if (jobs) jobs.options = { ...jobs.options, ...(m.options as Partial<HammerOptions>) }; break
        case 'cancel':
          if (jobs) jobs.cancelAll()
          else await this.client.sendNotification('PIDE/sledgehammer_cancel', {})
          break
        case 'clear': jobs?.clearFinished(); break
        case 'locate':
          if (jobs && m.id) await jobs.locate(m.id)
          else await this.client.sendNotification('PIDE/sledgehammer_locate', {})
          break
        case 'apply': if (jobs) await jobs.apply(m.id, m.text); break
        case 'cancelJob': jobs?.cancel(m.id); break
        case 'retry': jobs?.retry(m.id); break
        case 'dismiss': jobs?.dismiss(m.id); break
        case 'sendback':
          await this.client.sendNotification('PIDE/sledgehammer_sendback', { text: m.text })
          break
      }
    })
    view.webview.html = this.html()
    // Ask the server for the configured prover list to prefill the input.
    void this.client.sendNotification('PIDE/sledgehammer_provers_request', {})
  }

  /** The editor the panel's buttons mean: focus is in the panel by the time they are clicked. */
  private lastEditor(): vscode.TextEditor | undefined {
    return vscode.window.activeTextEditor ??
      vscode.window.visibleTextEditors.find(e => e.document.languageId === 'isabelle')
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message)
  }

  private postOptions(): void {
    if (this.jobs) this.post({ type: 'options', options: this.jobs.options })
  }

  private postJobs(): void {
    if (!this.jobs || !this.view) return
    const docs = vscode.workspace.textDocuments
    this.post({
      type: 'jobs',
      now: Date.now(),
      jobs: this.jobs.visible().map(job => {
        const doc = docs.find(d => d.uri.toString() === job.uri)
        const line = doc ? doc.positionAt(job.start).line + 1 : undefined
        const name = vscode.Uri.parse(job.uri).path.split('/').pop()
        return {
          id: job.id,
          where: line === undefined ? name : `${name}:${line}`,
          label: job.label,
          kind: job.kind,
          status: job.status,
          active: isActive(job),
          falsified: job.falsified,
          proofs: job.proofs.length,
          messages: job.messages,
          error: job.error,
          elapsed: ((job.endedAt ?? Date.now()) - job.startedAt),
          running: isActive(job),
        }
      }),
    })
  }

  private async run(provers: string, isar: boolean, try0: boolean): Promise<void> {
    // Completes the walkthrough's step; merely seeing the view, which shares a container
    // with the Symbols panel, did so before.
    void vscode.commands.executeCommand('setContext', SLEDGEHAMMER_RAN, true)
    this.status = 'Starting…'
    this.post({ type: 'status', message: this.status })
    await this.client.sendNotification('PIDE/sledgehammer_request', { provers, isar, try0 })
  }

  /**
   * The server tells us where the proof method should go; apply it there.
   *
   * The position is the end of the command's core range, so inserting the text bare
   * yields `apply (rule impI)by simp`. As upstream does, prefix a newline whenever the
   * target line is not blank -- and additionally carry the line's indentation across, so
   * the method lines up with the proof instead of starting at column 0.
   */
  private async applyInsert(p: InsertParams): Promise<void> {
    try {
      const uri = vscode.Uri.parse(p.uri)
      const doc = await vscode.workspace.openTextDocument(uri)
      const editor = await vscode.window.showTextDocument(doc, { preview: false })
      const pos = new vscode.Position(p.line, p.character)
      const lineText = doc.lineAt(pos.line).text
      const indent = lineText.slice(0, lineText.length - lineText.trimStart().length)
      const text = lineText.trim() === '' ? p.text : `\n${indent}${p.text}`
      await editor.edit(b => b.insert(pos, text))
      this.log(`sledgehammer inserted ${JSON.stringify(text)} at ${p.line}:${p.character}`)
    } catch (err) {
      this.log(`sledgehammer insert failed: ${err}`)
    }
  }

  private html(): string {
    const nonce = scriptNonce()
    return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
${isabelleCss()}
  body { font-family: var(--vscode-font-family); font-size: 12px; }
  .grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 6px; align-items: center;
          margin-bottom: 8px; }
  input[type=text], input[type=number], select { width: 100%; box-sizing: border-box; padding: 3px;
       color: var(--vscode-input-foreground); background: var(--vscode-input-background);
       border: 1px solid var(--vscode-input-border, transparent); font-family: inherit; }
  details { margin-bottom: 8px; }
  summary { cursor: pointer; opacity: .85; margin-bottom: 4px; }
  .checks { display: flex; flex-wrap: wrap; gap: 2px 12px; margin-bottom: 6px; }
  .checks label { white-space: nowrap; }
  .buttons { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: none; padding: 3px 10px; border-radius: 2px; cursor: pointer; font-size: 12px;
           font-family: inherit; }
  button.secondary { background: var(--vscode-button-secondaryBackground);
                     color: var(--vscode-button-secondaryForeground); }
  button.link { background: none; color: var(--vscode-textLink-foreground); padding: 0 4px; }
  #status { opacity: .75; margin-bottom: 6px; }
  .job { border-left: 3px solid var(--vscode-panel-border, #8884); padding: 4px 0 4px 8px;
         margin-bottom: 10px; }
  .job.proved { border-left-color: var(--vscode-testing-iconPassed, #3c3); }
  .job.falsified, .job.error { border-left-color: var(--vscode-editorWarning-foreground, #c90); }
  .job.active { border-left-color: var(--vscode-progressBar-background, #08f); }
  .head { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
  .where { cursor: pointer; text-decoration: underline dotted; }
  .label { opacity: .8; font-family: var(--vscode-editor-font-family); overflow: hidden;
           text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .state { opacity: .75; }
  .job pre { margin: 4px 0 0 0; white-space: pre-wrap; }
  pre button.sendback { display: block; margin: 3px 0; text-align: left; cursor: pointer;
       font-family: inherit; font-size: inherit;
       background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
       border: 1px solid var(--vscode-focusBorder); border-radius: 3px; padding: 2px 6px; }
  pre button.sendback:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .hidden { display: none; }
</style>
</head><body>
<div id="classic" class="hidden">
  <div class="grid">
    <label for="c-provers">Provers</label><input id="c-provers" type="text" autocomplete="off">
    <label for="c-isar">Isar proofs</label><input id="c-isar" type="checkbox">
    <label for="c-try0">try0</label><input id="c-try0" type="checkbox" checked>
  </div>
  <div class="buttons">
    <button id="c-run">Run</button>
    <button id="c-cancel" class="secondary">Cancel</button>
    <button id="c-locate" class="secondary">Locate</button>
  </div>
  <div id="status"></div>
  <pre id="out" class="source"></pre>
</div>
<div id="jobs-ui" class="hidden">
  <div class="buttons">
    <button id="run" title="Sledgehammer the sorry or the command at the cursor">Run at Cursor</button>
    <button id="sorries" class="secondary" title="One run for each sorry of the selection, or of the lemma at the cursor">Hammer sorrys</button>
    <button id="cancel" class="secondary" title="Stop every run">Cancel All</button>
    <button id="clear" class="secondary" title="Hide the finished runs">Clear</button>
  </div>
  <div class="grid">
    <label for="provers">Provers</label><input id="provers" type="text" autocomplete="off">
    <label for="timeout">Timeout (s)</label><input id="timeout" type="number" min="1">
  </div>
  <div class="checks">
    <label title="Stop at the first proof found, freeing the provers for the next run"><input id="stopAtFirst" type="checkbox"> stop at first proof</label>
    <label title="Also look for facts the goal contradicts: a false step shows early"><input id="falsify" type="checkbox"> falsify</label>
    <label title="Try standard proof methods (simp, auto, blast, ...) too"><input id="try0" type="checkbox"> try0</label>
  </div>
  <details>
    <summary>More options</summary>
    <div class="grid">
      <label for="isar">Isar proofs</label>
      <select id="isar"><option value="false">off</option><option value="smart">smart</option><option value="true">on</option></select>
      <label for="subgoal">Subgoal</label><input id="subgoal" type="number" min="1">
      <label for="facts" title="As in sledgehammer (...): add: foo_def del: bar, or bare facts to use only those">Facts</label>
      <input id="facts" type="text" autocomplete="off" placeholder="add: foo_def  del: bar  (or only: bare facts)">
    </div>
    <div class="checks">
      <label title="Ask E for a missing assumption that would make the goal provable"><input id="abduce" type="checkbox"> suggest missing assumptions</label>
      <label title="Let the relevance filter use induction rules instantiated for the goal"><input id="induction" type="checkbox"> consider induction</label>
    </div>
  </details>
  <div id="list"></div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);

  /* classic */
  $('c-run').addEventListener('click', () => vscode.postMessage({
    command: 'run', provers: $('c-provers').value, isar: $('c-isar').checked, try0: $('c-try0').checked }));
  $('c-cancel').addEventListener('click', () => vscode.postMessage({ command: 'cancel' }));
  $('c-locate').addEventListener('click', () => vscode.postMessage({ command: 'locate' }));

  /* jobs */
  for (const [id, command] of [['run', 'run'], ['sorries', 'sorries'], ['cancel', 'cancel'], ['clear', 'clear']]) {
    $(id).addEventListener('click', () => vscode.postMessage({ command }));
  }
  const fields = {
    provers: e => e.value, timeout: e => Number(e.value) || 30, isar: e => e.value,
    subgoal: e => Math.max(1, Number(e.value) || 1), facts: e => e.value,
    stopAtFirst: e => e.checked, falsify: e => e.checked, try0: e => e.checked,
    abduce: e => e.checked, induction: e => e.checked,
  };
  for (const [name, read] of Object.entries(fields)) {
    $(name).addEventListener('change', () =>
      vscode.postMessage({ command: 'options', options: { [name]: read($(name)) } }));
  }
  function showOptions(o) {
    for (const name of Object.keys(fields)) {
      const e = $(name);
      if (e.type === 'checkbox') e.checked = !!o[name];
      else if (document.activeElement !== e) e.value = o[name];
    }
  }

  ${markupText}
  ${renderMarkup}
  function renderXml(xml, into, sendback) {
    let parsed;
    try { parsed = new DOMParser().parseFromString('<root>' + xml + '</root>', 'application/xml'); }
    catch (e) { into.textContent = xml; return; }
    if (!parsed || parsed.getElementsByTagName('parsererror').length) { into.textContent = xml; return; }
    renderMarkup(parsed.documentElement, into, document, sendback);
  }

  const seconds = ms => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
  function stateOf(j) {
    if (j.active) return j.status === 'running' ? 'running' : j.status;
    if (j.status === 'cancelled') return 'cancelled';
    if (j.status === 'error') return 'error: ' + (j.error || '');
    if (j.proofs) return 'proved';
    if (j.falsified) return 'falsified';
    return 'no proof';
  }
  function button(text, cls, onClick) {
    const b = document.createElement('button');
    b.textContent = text; b.className = cls; b.addEventListener('click', onClick);
    return b;
  }
  let shown = [];
  let shownAt = 0;
  function renderJobs(jobs) {
    const list = $('list');
    list.textContent = '';
    for (const j of jobs) {
      const state = stateOf(j);
      const card = document.createElement('div');
      card.className = 'job ' + (j.active ? 'active' : j.proofs ? 'proved' : j.falsified ? 'falsified' : j.status);
      const head = document.createElement('div');
      head.className = 'head';
      const where = document.createElement('span');
      where.className = 'where'; where.textContent = j.where; where.title = 'Go there';
      where.addEventListener('click', () => vscode.postMessage({ command: 'locate', id: j.id }));
      const st = document.createElement('span');
      st.className = 'state'; st.dataset.id = j.id;
      st.textContent = state + ' · ' + seconds(j.elapsed);
      head.append(where, st);
      if (j.active) head.append(button('Cancel', 'link', () => vscode.postMessage({ command: 'cancelJob', id: j.id })));
      else {
        if (!j.proofs) head.append(button('Retry', 'link', () => vscode.postMessage({ command: 'retry', id: j.id })));
        head.append(button('Dismiss', 'link', () => vscode.postMessage({ command: 'dismiss', id: j.id })));
      }
      const label = document.createElement('div');
      label.className = 'label'; label.textContent = j.label;
      card.append(head, label);
      if (j.messages.length) {
        const out = document.createElement('pre');
        out.className = 'source';
        for (const m of j.messages) {
          const line = document.createElement('div');
          renderXml(m, line, text => vscode.postMessage({ command: 'apply', id: j.id, text }));
          out.append(line);
        }
        card.append(out);
      }
      list.append(card);
    }
    if (!jobs.length) {
      const empty = document.createElement('div');
      empty.className = 'state';
      empty.textContent = 'Put the cursor on a step or a sorry and run Sledgehammer. Runs go on while you edit, several at once.';
      list.append(empty);
    }
  }
  // Running times tick here, without a message for every second.
  setInterval(() => {
    const now = Date.now();
    for (const j of shown) {
      if (!j.active) continue;
      const st = document.querySelector('.state[data-id="' + j.id + '"]');
      if (st) st.textContent = stateOf(j) + ' · ' + seconds(j.elapsed + (now - shownAt));
    }
  }, 1000);

  /* classic output */
  function renderOutput(xml) {
    const out = $('out');
    out.textContent = '';
    renderXml(xml, out, text => vscode.postMessage({ command: 'sendback', text }));
  }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'mode') {
      $('classic').classList.toggle('hidden', m.jobs);
      $('jobs-ui').classList.toggle('hidden', !m.jobs);
    }
    else if (m.type === 'provers') $('c-provers').value = m.provers;
    else if (m.type === 'options') showOptions(m.options);
    else if (m.type === 'status') $('status').textContent = m.message;
    else if (m.type === 'output') renderOutput(m.content);
    else if (m.type === 'jobs') { shown = m.jobs; shownAt = Date.now(); renderJobs(m.jobs); }
  });
  vscode.postMessage({ command: 'ready' });
</script>
</body></html>`
  }

  /** Test hooks: with jobs, the newest one stands in for the classic single run. */
  get lastStatus(): string {
    const job = this.jobs?.latest()
    if (!this.jobs) return this.status
    if (!job) return ''
    if (job.status === 'queued' || job.status === 'starting') return 'Waiting for evaluation of context ...'
    return isActive(job) ? 'Sledgehammering ...' : 'Finished'
  }
  get lastOutput(): string {
    return this.jobs ? (this.jobs.latest()?.messages.join('\n') ?? '') : this.output
  }
  get proverList(): string { return this.provers }
}
