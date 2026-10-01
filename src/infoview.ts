/* The infoview: goals and messages of the command at the cursor, and of pinned commands,
 * in one view. It replaces the State and Output panels, after Lean's infoview.
 *
 * Two backends, because the server decides what a pin can be:
 *
 *   extended  PIDE/infoview_request, _pin, _unpin, _set_margin
 *             -> PIDE/infoview_response { live?, pins }
 *             The server splits each command's results into goals and messages, and
 *             anchors a pin to a place in the text: when an edit replaces the pinned
 *             command, the command that takes its place becomes the pin's.
 *
 *   stock     PIDE/dynamic_output for the messages at the cursor, and one State_Panel
 *             instance (PIDE/state_*) for its goals and one more for each pin, with
 *             auto-update off. That is all a released server offers: a pin holds on to
 *             the command, shows only its proof state, and stops following the text at
 *             the first edit to that command.
 *
 * Which one is decided by asking: the infoview sends PIDE/infoview_request, which a server
 * that does not know it logs and ignores. With the extended server configured it waits for
 * the answer, and after HANDSHAKE_MS without one the stock backend takes over -- the
 * setting alone is not enough, since a jar built for another release falls back to the
 * stock server. Otherwise the stock backend starts at once and gives way if an answer comes
 * after all, which is how a hand-patched distribution (ISABELLE_PATCHED_HOME) is found.
 *
 * Two hosts show the same model, as with the Graph view: the view, which can sit in the
 * bottom panel or either side bar, and optionally an editor tab beside the theory. The
 * page is loaded once per host and later bodies are posted into it, so an update keeps
 * the scroll position and which blocks are collapsed.
 *
 * Both hosts outlive any one server, and are registered at activation: VS Code restores
 * the view and the editor tab on a reload or a restart, and a view without a provider
 * stays blank while one without a serializer is dropped. Each client is bound in turn
 * once it runs, and until then the page says it is waiting.
 */

import * as vscode from 'vscode'
import { LanguageClient } from 'vscode-languageclient/node'
import { isabelleCss, MARGIN_SCRIPT, openIsabelleLink, scriptNonce } from './webview'
import { INFOVIEW_CSS, InfoSection, InfoviewMode, InfoviewModel, infoviewBody } from './infoview_view'

export { infoviewBody } from './infoview_view'

const HANDSHAKE_MS = 10000

type WebviewMessage = { command?: string; arg?: string; link?: string; margin?: number }

interface Backend {
  start(): Promise<void>
  pin(editor: vscode.TextEditor): Promise<void>
  unpin(id: number): void
  reveal(id: number | 'live'): Promise<void>
  setMargin(margin: number): void
  dispose(): void
}

export class Infoview implements vscode.WebviewViewProvider {
  static readonly viewType = 'isabelle-infoview'
  static readonly editorViewType = 'isabelle-infoview-editor'

  private view: vscode.WebviewView | undefined
  private editorPanel: vscode.WebviewPanel | undefined
  private viewMargin: number | undefined
  private editorMargin: number | undefined

  private client: LanguageClient | undefined
  private mode: InfoviewMode = 'waiting'
  private backend: Backend | undefined
  private latest: InfoSection | undefined
  private frozen: InfoSection | undefined
  private pins: InfoSection[] = []
  private paused = false
  private pending = false
  private renderScheduled = false
  private lastEditor: vscode.TextEditor | undefined

  constructor(private readonly log: (m: string) => void) {
    const editor = vscode.window.activeTextEditor
    if (editor?.document.languageId === 'isabelle') this.lastEditor = editor
  }

  /** The hosts and commands, for the extension's lifetime; see the header. */
  register(disposables: vscode.Disposable[]): void {
    disposables.push(
      vscode.window.registerWebviewViewProvider(Infoview.viewType, this,
        { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.window.registerWebviewPanelSerializer(Infoview.editorViewType, {
        deserializeWebviewPanel: async panel => this.adoptEditorPanel(panel),
      }),
      vscode.commands.registerCommand('isabelle.infoview',
        () => vscode.commands.executeCommand(`${Infoview.viewType}.focus`)),
      vscode.commands.registerCommand('isabelle.infoviewPin', () => this.pin()),
      vscode.commands.registerCommand('isabelle.infoviewTogglePause', () => this.togglePause()),
      vscode.commands.registerCommand('isabelle.infoviewUnpinAll', () => this.unpinAll()),
      vscode.commands.registerCommand('isabelle.infoviewOpenInEditor', () => this.openInEditor()),
      // Test hook.
      vscode.commands.registerCommand('isabelle.infoviewState', () => ({
        mode: this.mode,
        paused: this.paused,
        pending: this.pending,
        live: this.shownLive,
        pins: this.pins,
        inEditor: this.editorPanel !== undefined,
      })),
      vscode.window.onDidChangeTextEditorSelection(e => {
        if (e.textEditor.document.languageId === 'isabelle') this.lastEditor = e.textEditor
      }),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor?.document.languageId === 'isabelle') this.lastEditor = editor
      }),
      // The palette is baked into the stylesheet, so a theme switch reloads the pages.
      vscode.window.onDidChangeActiveColorTheme(() => this.reload()),
      { dispose: () => { this.unbind(); this.editorPanel?.dispose() } },
    )
  }

  /** A client that has started. It asks whether the server speaks PIDE/infoview_*
      whenever `tryExtended` is set; it may still be the stock one, if the jar does not fit
      the distribution. Unbound when `disposables` are. */
  bind(client: LanguageClient, tryExtended: boolean, disposables: vscode.Disposable[]): void {
    this.unbind()
    this.client = client
    disposables.push({ dispose: () => { if (this.client === client) this.unbind() } })
    void this.start(client, tryExtended)
  }

  /* The server is gone, and its pins with it: back to waiting for the next one. */
  private unbind(): void {
    this.backend?.dispose()
    this.backend = undefined
    this.client = undefined
    this.mode = 'waiting'
    this.latest = undefined
    this.frozen = undefined
    this.pins = []
    this.paused = false
    this.pending = false
    this.scheduleRender()
  }

  /* Every step after an await checks that the client is still the bound one: a restart
     within the handshake's wait must not hand the old client a backend. */
  private async start(client: LanguageClient, tryExtended: boolean): Promise<void> {
    const answered = this.handshake(client, tryExtended)
    if (!tryExtended) this.use('stock', new StockBackend(client, this.log, this))
    const extended = await answered
    if (this.client !== client) return
    if (extended) this.use('extended', new ExtendedBackend(client, this.log, this))
    else if (this.mode === 'waiting') this.use('stock', new StockBackend(client, this.log, this))
  }

  /* Resolves true with the first PIDE/infoview_response, whose content is shown at once.

     The listener is gone before this resolves, and has to be: the client keeps one handler
     per method, and disposing a registration deletes whichever handler holds the method at
     the time -- so a later dispose would take the extended backend's own with it. */
  private handshake(client: LanguageClient, tryExtended: boolean): Promise<boolean> {
    return new Promise(resolve => {
      let listener: vscode.Disposable | undefined
      const timer = setTimeout(() => {
        listener?.dispose()
        if (tryExtended && this.client === client) {
          this.log('infoview: no answer to PIDE/infoview_request; using the State and Output messages')
        }
        resolve(false)
      }, tryExtended ? HANDSHAKE_MS : 4 * HANDSHAKE_MS)
      listener = client.onNotification('PIDE/infoview_response',
        (p: { live?: InfoSection; pins?: InfoSection[] }) => {
          clearTimeout(timer)
          listener?.dispose()
          if (this.client === client) this.setExtended(p)
          resolve(true)
        })
      void client.sendNotification('PIDE/infoview_request', {})
        .catch(err => this.log(`infoview_request failed: ${err}`))
    })
  }

  /** Whether `backend` is the one in use, for a backend's output that arrives late. */
  isCurrent(backend: Backend): boolean {
    return this.backend === backend
  }

  private use(mode: InfoviewMode, backend: Backend): void {
    /* Pins made on the stock backend do not carry over; the switch happens within moments
       of the server starting, so there are rarely any. */
    this.backend?.dispose()
    this.pins = []
    this.mode = mode
    this.backend = backend
    this.log(`infoview: ${mode} backend`)
    void backend.start().catch(err => this.log(`infoview: ${mode} backend failed: ${err}`))
    const margin = this.margin()
    if (margin) backend.setMargin(margin)
    this.scheduleRender()
  }

  /* model */

  private get shownLive(): InfoSection | undefined {
    return this.paused ? this.frozen : this.latest
  }

  /** The extended server's whole view. */
  setExtended(p: { live?: InfoSection; pins?: InfoSection[] }): void {
    this.setLive(p.live)
    this.pins = p.pins ?? []
    this.scheduleRender()
  }

  setLive(live: InfoSection | undefined): void {
    if (this.paused && !sameSection(live, this.frozen)) this.pending = true
    this.latest = live
    this.scheduleRender()
  }

  get live(): InfoSection | undefined { return this.latest }

  get pinned(): readonly InfoSection[] { return this.pins }

  setPins(pins: InfoSection[]): void {
    this.pins = pins
    this.scheduleRender()
  }

  /** Where the cursor is, for a pin and for the stock backend's live header. */
  get caretEditor(): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor
    if (active?.document.languageId === 'isabelle') return active
    if (this.lastEditor && !this.lastEditor.document.isClosed) return this.lastEditor
    return undefined
  }

  /* actions */

  private async pin(): Promise<void> {
    const editor = this.caretEditor
    if (!editor) {
      void vscode.window.showInformationMessage('Put the cursor in an Isabelle theory to pin its command.')
      return
    }
    await this.backend?.pin(editor)
  }

  private togglePause(): void {
    this.paused = !this.paused
    this.pending = false
    if (this.paused) this.frozen = this.latest
    this.scheduleRender()
  }

  private unpinAll(): void {
    for (const pin of [...this.pins]) if (pin.id !== undefined) this.backend?.unpin(pin.id)
  }

  private openInEditor(): void {
    if (this.editorPanel) { this.editorPanel.reveal(undefined, true); return }
    this.adoptEditorPanel(vscode.window.createWebviewPanel(Infoview.editorViewType, 'Isabelle Infoview',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }))
  }

  /* A new tab, or one VS Code restored after a reload. Its page is replaced either way,
     and scripts are switched on here so the restored one does not depend on what VS Code
     kept of the options. */
  private adoptEditorPanel(panel: vscode.WebviewPanel): void {
    if (this.editorPanel) { panel.dispose(); return }
    this.editorPanel = panel
    panel.webview.options = { enableScripts: true }
    panel.webview.onDidReceiveMessage((msg: WebviewMessage) => this.onMessage(msg, 'editor'))
    panel.onDidDispose(() => {
      this.editorPanel = undefined
      this.editorMargin = undefined
      this.marginChanged()
    })
    panel.webview.html = this.pageHtml(true)
  }

  private async onMessage(msg: WebviewMessage, host: 'view' | 'editor'): Promise<void> {
    switch (msg.command) {
      case 'ready': this.post(host); break
      case 'resize':
        if (msg.margin) {
          if (host === 'view') this.viewMargin = msg.margin
          else this.editorMargin = msg.margin
          this.marginChanged()
        }
        break
      case 'pin': await this.pin(); break
      case 'togglePause': this.togglePause(); break
      case 'unpinAll': this.unpinAll(); break
      case 'unpin': if (msg.arg) this.backend?.unpin(Number(msg.arg)); break
      case 'reveal':
        if (msg.arg) await this.backend?.reveal(msg.arg === 'live' ? 'live' : Number(msg.arg))
        break
      case 'revealLine': if (msg.arg) await this.revealLine(msg.arg); break
      case 'open': if (msg.link) await openIsabelleLink(msg.link); break
    }
  }

  /** `uri#line`, from an enclosing goal's header; the uri is the server's. */
  private async revealLine(arg: string): Promise<void> {
    const hash = arg.lastIndexOf('#')
    if (hash < 0 || !this.client) return
    try {
      await revealLine(this.client.protocol2CodeConverter.asUri(arg.slice(0, hash)),
        Number(arg.slice(hash + 1)))
    } catch (err) {
      this.log(`infoview: cannot reveal ${arg}: ${err}`)
    }
  }

  /* Isabelle formats to one margin, and the editor tab, when there is one, is the wider
     and the one being read. */
  private margin(): number | undefined {
    return this.editorPanel ? this.editorMargin ?? this.viewMargin : this.viewMargin
  }

  private marginChanged(): void {
    const margin = this.margin()
    if (margin) this.backend?.setMargin(margin)
  }

  /* rendering */

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.onDidReceiveMessage((msg: WebviewMessage) => this.onMessage(msg, 'view'))
    view.onDidDispose(() => { this.view = undefined; this.viewMargin = undefined })
    view.webview.html = this.pageHtml(false)
  }

  private reload(): void {
    if (this.view) this.view.webview.html = this.pageHtml(false)
    if (this.editorPanel) this.editorPanel.webview.html = this.pageHtml(true)
  }

  /* Notifications come in bursts -- a caret move alone produces one per backend message --
     so bodies are posted once per turn of the event loop. */
  private scheduleRender(): void {
    if (this.renderScheduled) return
    this.renderScheduled = true
    setTimeout(() => {
      this.renderScheduled = false
      this.post('view')
      this.post('editor')
    }, 0)
  }

  private model(): InfoviewModel {
    return {
      mode: this.mode,
      live: this.shownLive,
      pins: this.pins,
      paused: this.paused,
      pending: this.pending,
    }
  }

  private post(host: 'view' | 'editor'): void {
    const webview = host === 'view' ? this.view?.webview : this.editorPanel?.webview
    if (!webview) return
    void webview.postMessage({ type: 'body', html: infoviewBody(this.model()) })
  }

  private pageHtml(inEditor: boolean): string {
    const nonce = scriptNonce()
    return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${isabelleCss()}${INFOVIEW_CSS}
${inEditor ? 'body { background-color: var(--vscode-editor-background); }' : ''}</style>
</head><body>
<div id="content">${infoviewBody(this.model())}</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const content = document.getElementById('content');
  /* Which blocks the reader closed, by key, so a new body does not reopen them. */
  const closed = new Set((vscode.getState() || {}).closed || []);
  function applyClosed() {
    for (const d of content.querySelectorAll('details[data-key]')) {
      if (closed.has(d.getAttribute('data-key'))) d.removeAttribute('open');
    }
  }
  applyClosed();
  document.addEventListener('toggle', e => {
    const key = e.target.getAttribute && e.target.getAttribute('data-key');
    if (!key) return;
    if (e.target.open) closed.delete(key); else closed.add(key);
    vscode.setState({ closed: [...closed] });
  }, true);
  /* Server HTML, inserted as markup like every panel's (see panelHtml): what keeps that
     safe is the CSP, under which neither an inserted <script> nor an inline handler runs. */
  window.addEventListener('message', e => {
    if (e.data && e.data.type === 'body') {
      content.innerHTML = e.data.html;
      applyClosed();
    }
  });
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-command]');
    if (btn) {
      e.preventDefault();
      vscode.postMessage({ command: btn.getAttribute('data-command'), arg: btn.getAttribute('data-arg') });
      return;
    }
    const a = e.target.closest('a');
    if (a && a.getAttribute('href')) {
      e.preventDefault();
      vscode.postMessage({ command: 'open', link: a.getAttribute('href') });
    }
  });
${MARGIN_SCRIPT}
  vscode.postMessage({ command: 'ready' });
</script>
</body></html>`
  }
}

function sameSection(a: InfoSection | undefined, b: InfoSection | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function revealLine(uri: vscode.Uri, line: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri)
  const editor = await vscode.window.showTextDocument(doc, { preview: false })
  const pos = new vscode.Position(Math.min(Math.max(0, line), doc.lineCount - 1), 0)
  editor.selection = new vscode.Selection(pos, pos)
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
}

/* The server does the work: see vscode_infoview.scala. Pin ids are chosen here, so a pin
   is a notification rather than a request. */
class ExtendedBackend implements Backend {
  private nextId = 1
  private readonly disposables: vscode.Disposable[] = []

  constructor(
    private readonly client: LanguageClient,
    private readonly log: (m: string) => void,
    private readonly infoview: Infoview,
  ) {}

  async start(): Promise<void> {
    this.disposables.push(this.client.onNotification('PIDE/infoview_response',
      (p: { live?: InfoSection; pins?: InfoSection[] }) => this.infoview.setExtended(p)))
    // The stock backend may have shown something since the handshake's answer.
    await this.client.sendNotification('PIDE/infoview_request', {})
  }

  async pin(editor: vscode.TextEditor): Promise<void> {
    const pos = editor.selection.active
    await this.client.sendNotification('PIDE/infoview_pin', {
      id: this.nextId++,
      uri: this.client.code2ProtocolConverter.asUri(editor.document.uri),
      line: pos.line,
      character: pos.character,
    })
  }

  unpin(id: number): void {
    void this.client.sendNotification('PIDE/infoview_unpin', { id })
      .catch(err => this.log(`infoview_unpin failed: ${err}`))
  }

  /* Moved here rather than by the server, so the move reaches the server as a caret update
     like any other and the live section follows it. */
  async reveal(id: number | 'live'): Promise<void> {
    const target = id === 'live' ? this.infoview.live : this.infoview.pinned.find(p => p.id === id)
    if (!target?.uri || target.line === undefined) return
    try {
      await revealLine(this.client.protocol2CodeConverter.asUri(target.uri), target.line)
    } catch (err) {
      this.log(`infoview: cannot reveal ${target.uri}: ${err}`)
    }
  }

  setMargin(margin: number): void {
    void this.client.sendNotification('PIDE/infoview_set_margin', { margin })
      .catch(err => this.log(`infoview_set_margin failed: ${err}`))
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose()
  }
}

/* A released server's messages, put together: see the header. */
class StockBackend implements Backend {
  private liveId: number | undefined
  private liveGoals: string | undefined
  private liveMessages: string | undefined
  /* Pins by state id, in the order they were made. */
  private readonly pins = new Map<number, InfoSection>()
  /* Output for an instance whose id the state_init reply has not delivered yet: the server
     starts the instance's query before it answers. */
  private readonly early = new Map<number, string>()
  private margin: number | undefined
  private readonly disposables: vscode.Disposable[] = []

  constructor(
    private readonly client: LanguageClient,
    private readonly log: (m: string) => void,
    private readonly infoview: Infoview,
  ) {}

  async start(): Promise<void> {
    this.disposables.push(
      this.client.onNotification('PIDE/dynamic_output', (p: { content: string }) => {
        this.liveMessages = p.content
        this.publishLive()
      }),
      this.client.onNotification('PIDE/state_output', (p: { id: number; content: string }) => {
        if (p.id === this.liveId) {
          this.liveGoals = p.content
          this.publishLive()
        } else {
          const pin = this.pins.get(p.id)
          if (pin) {
            pin.goals = p.content
            this.publishPins()
          } else this.early.set(p.id, p.content)
        }
      }),
    )
    /* Auto-update is on for a new instance, so this one follows the caret. */
    this.liveId = await this.stateInit()
    if (this.margin) this.sendMargin(this.liveId, this.margin)
    const early = this.claimEarly(this.liveId)
    if (early !== undefined) {
      this.liveGoals = early
      this.publishLive()
    }
  }

  private async stateInit(): Promise<number> {
    const res = await this.client.sendRequest<{ state_id: number }>('PIDE/state_init', {})
    return res.state_id
  }

  private claimEarly(id: number): string | undefined {
    const content = this.early.get(id)
    this.early.delete(id)
    return content
  }

  /* The header says where the cursor was when the output came, which is the closest a
     released server comes to saying which command it is. */
  private publishLive(): void {
    // A state_init answered after a restart or the switch to the extended backend.
    if (!this.infoview.isCurrent(this)) return
    const editor = this.infoview.caretEditor
    this.infoview.setLive({
      uri: editor?.document.uri.toString(),
      line: editor?.selection.active.line,
      goals: this.liveGoals ?? '',
      messages: this.liveMessages ?? '',
    })
  }

  private publishPins(): void {
    if (!this.infoview.isCurrent(this)) return
    this.infoview.setPins([...this.pins.values()].map(p => ({ ...p })))
  }

  /* A new instance applies its query to the command at the caret at once; turning
     auto-update off afterwards leaves it there. The label is taken from the editor at the
     same moment, since the server never says which command it is. */
  async pin(editor: vscode.TextEditor): Promise<void> {
    const id = await this.stateInit()
    await this.client.sendNotification('PIDE/state_auto_update', { id, enabled: false })
    if (this.margin) this.sendMargin(id, this.margin)
    const line = editor.selection.active.line
    this.pins.set(id, {
      id,
      uri: editor.document.uri.toString(),
      line,
      source: editor.document.lineAt(line).text.trim().slice(0, 100),
      goals: this.claimEarly(id) ?? this.infoview.live?.goals ?? '',
    })
    this.publishPins()
  }

  unpin(id: number): void {
    if (!this.pins.delete(id)) return
    void this.client.sendNotification('PIDE/state_exit', { id })
      .catch(err => this.log(`state_exit failed: ${err}`))
    this.publishPins()
  }

  /* The server knows where a pin's command is; it moves the caret with PIDE/caret_update. */
  async reveal(id: number | 'live'): Promise<void> {
    if (id === 'live') {
      const live = this.infoview.live
      if (live?.uri && live.line !== undefined) await revealLine(vscode.Uri.parse(live.uri), live.line)
      return
    }
    await this.client.sendNotification('PIDE/state_locate', { id })
  }

  setMargin(margin: number): void {
    this.margin = margin
    void this.client.sendNotification('PIDE/output_set_margin', { margin })
      .catch(err => this.log(`output_set_margin failed: ${err}`))
    if (this.liveId !== undefined) this.sendMargin(this.liveId, margin)
    for (const id of this.pins.keys()) this.sendMargin(id, margin)
  }

  private sendMargin(id: number, margin: number): void {
    void this.client.sendNotification('PIDE/state_set_margin', { id, margin })
      .catch(err => this.log(`state_set_margin failed: ${err}`))
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose()
    const ids = [...this.pins.keys()]
    if (this.liveId !== undefined) ids.push(this.liveId)
    for (const id of ids) {
      void this.client.sendNotification('PIDE/state_exit', { id }).catch(() => { /* server gone */ })
    }
    this.pins.clear()
  }
}
