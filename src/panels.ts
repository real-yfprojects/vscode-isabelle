/* The Output and State panels, as webviews over PIDE messages the server already sends. */

import * as vscode from 'vscode'
import { LanguageClient } from 'vscode-languageclient/node'
import { openIsabelleLink, panelHtml } from './webview'

const TOOLBAR_CSS = `
  <style>
    #toolbar { display: flex; gap: 6px; align-items: center; margin-bottom: 6px;
               font-family: var(--vscode-font-family); font-size: 12px; }
    #toolbar button { background: var(--vscode-button-secondaryBackground, #3a3d41);
                      color: var(--vscode-button-secondaryForeground, #fff);
                      border: none; padding: 2px 8px; cursor: pointer; border-radius: 2px; }
    #toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
    #toolbar .on { background: var(--vscode-button-background, #0e639c);
                   color: var(--vscode-button-foreground, #fff); }
  </style>`

abstract class HtmlPanel implements vscode.WebviewViewProvider {
  protected view: vscode.WebviewView | undefined
  protected content = '<p style="opacity:.6">Waiting for Isabelle…</p>'

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.onDidReceiveMessage(msg => void this.onMessage(msg))
    // The palette is baked into the stylesheet at render time, so a theme switch needs
    // a re-render or the panel keeps the previous theme's colours.
    const themeListener = vscode.window.onDidChangeActiveColorTheme(() => this.render())
    view.onDidDispose(() => {
      themeListener.dispose()
      this.view = undefined
      this.onDispose()
    })
    this.render()
    this.onResolved()
  }

  protected render(): void {
    if (this.view) this.view.webview.html = panelHtml(this.view.webview, this.body())
  }

  protected body(): string { return this.content }
  protected onResolved(): void { /* nothing by default */ }
  protected onDispose(): void { /* nothing by default */ }

  protected async onMessage(msg: { command?: string; link?: string; arg?: string }): Promise<void> {
    if (msg.command === 'open' && msg.link) await openIsabelleLink(msg.link)
  }

  setContent(html: string): void {
    this.content = html || '<p style="opacity:.6">(empty)</p>'
    this.render()
  }

  /** Test hook: the raw HTML the server last sent. */
  get rawContent(): string { return this.content }
}

/** Output panel: whatever PIDE reports for the command under the caret. */
export class OutputPanel extends HtmlPanel {
  static readonly viewType = 'isabelle-output'
  private client: LanguageClient | undefined

  register(disposables: vscode.Disposable[], client: LanguageClient): void {
    this.client = client
    disposables.push(
      vscode.window.registerWebviewViewProvider(OutputPanel.viewType, this,
        { webviewOptions: { retainContextWhenHidden: true } }),
      client.onNotification('PIDE/dynamic_output', (p: { content: string }) => {
        this.setContent(p.content)
      }),
    )
  }

  protected async onMessage(msg: { command?: string; link?: string; margin?: number }): Promise<void> {
    if (msg.command === 'resize' && msg.margin && this.client) {
      await this.client.sendNotification('PIDE/output_set_margin', { margin: msg.margin })
      return
    }
    await super.onMessage(msg)
  }
}

/**
 * State panel: the proof state.
 *
 * The server allocates one panel instance per PIDE/state_init request and tags every
 * PIDE/state_output with that id, so several panels can coexist. Isabelle's Counter
 * decrements, so the first id is -1 -- negative ids are normal, not an error.
 */
export class StatePanel extends HtmlPanel {
  static readonly viewType = 'isabelle-state'
  private stateId: number | undefined
  private autoUpdate = true

  constructor(
    private readonly client: LanguageClient,
    private readonly log: (m: string) => void,
  ) { super() }

  register(disposables: vscode.Disposable[]): void {
    disposables.push(
      vscode.window.registerWebviewViewProvider(StatePanel.viewType, this,
        { webviewOptions: { retainContextWhenHidden: true } }),
      this.client.onNotification('PIDE/state_output',
        (p: { id: number; content: string; auto_update?: boolean }) => {
          if (this.stateId !== undefined && p.id !== this.stateId) return
          if (typeof p.auto_update === 'boolean') this.autoUpdate = p.auto_update
          this.setContent(p.content)
        }),
      vscode.commands.registerCommand('isabelle.stateUpdate', () => this.update()),
      vscode.commands.registerCommand('isabelle.stateToggleAutoUpdate', () => this.toggleAuto()),
    )
  }

  protected onResolved(): void { void this.init() }

  private async init(): Promise<void> {
    if (this.stateId !== undefined) return
    try {
      const res = await this.client.sendRequest<{ state_id: number }>('PIDE/state_init', {})
      this.stateId = res?.state_id
      this.log(`state panel id = ${this.stateId}`)
      await this.client.sendNotification('PIDE/state_auto_update',
        { id: this.stateId, enabled: this.autoUpdate })
      await this.update()
    } catch (err) {
      this.log(`state_init failed: ${err}`)
    }
  }

  private async update(): Promise<void> {
    if (this.stateId === undefined) return
    await this.client.sendNotification('PIDE/state_update', { id: this.stateId })
  }

  private async toggleAuto(): Promise<void> {
    if (this.stateId === undefined) return
    this.autoUpdate = !this.autoUpdate
    await this.client.sendNotification('PIDE/state_auto_update',
      { id: this.stateId, enabled: this.autoUpdate })
    this.render()
  }

  protected body(): string {
    return `${TOOLBAR_CSS}
      <div id="toolbar">
        <button data-command="update">Update</button>
        <button data-command="auto" class="${this.autoUpdate ? 'on' : ''}">Auto ${this.autoUpdate ? 'on' : 'off'}</button>
        <button data-command="locate">Locate</button>
      </div>${this.content}`
  }

  protected async onMessage(msg: { command?: string; link?: string; margin?: number }): Promise<void> {
    switch (msg.command) {
      case 'resize':
        if (msg.margin && this.stateId !== undefined) {
          await this.client.sendNotification('PIDE/state_set_margin',
            { id: this.stateId, margin: msg.margin })
        }
        break
      case 'update': await this.update(); break
      case 'auto': await this.toggleAuto(); break
      case 'locate':
        if (this.stateId !== undefined) {
          await this.client.sendNotification('PIDE/state_locate', { id: this.stateId })
        }
        break
      default: await super.onMessage(msg)
    }
  }

  protected onDispose(): void {
    if (this.stateId !== undefined) {
      void this.client.sendNotification('PIDE/state_exit', { id: this.stateId })
      this.stateId = undefined
    }
  }

  /** Test hook. */
  get id(): number | undefined { return this.stateId }
}
