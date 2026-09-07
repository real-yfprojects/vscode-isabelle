/* Symbols palette: click a glyph to insert its ASCII escape at the caret.
 *
 * The official extension's equivalent is symbol_panel.ts, which reads its table from
 * symbols.json inside the patched VSCodium. This one uses the table parsed from
 * $ISABELLE_HOME/etc/symbols, so it needs no fork.
 */

import * as vscode from 'vscode'
import { SymbolTable } from './symbols'
import { isabelleCss } from './webview'

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export class SymbolsPanel implements vscode.WebviewViewProvider {
  static readonly viewType = 'isabelle-symbols'
  private view: vscode.WebviewView | undefined

  constructor(private readonly table: SymbolTable) {}

  register(disposables: vscode.Disposable[]): void {
    disposables.push(
      vscode.window.registerWebviewViewProvider(SymbolsPanel.viewType, this,
        { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.window.onDidChangeActiveColorTheme(() => this.render()),
    )
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    view.webview.onDidReceiveMessage(async (msg: { command?: string; arg?: string }) => {
      if (msg.command === 'insert' && msg.arg) await insertSymbol(msg.arg)
    })
    this.render()
  }

  private render(): void {
    if (this.view) this.view.webview.html = this.html()
  }

  private html(): string {
    const groups = new Map<string, string[]>()
    for (const entry of this.table.entries) {
      if (!entry.glyph) continue // nothing to show for a symbol with no codepoint
      const group = entry.groups[0] ?? 'other'
      const label = escapeHtml(entry.glyph)
      const title = escapeHtml(
        entry.name + (entry.abbrevs.length ? `   (${entry.abbrevs.join(' ')})` : ''))
      const cell =
        `<button class="sym" title="${title}" data-name="${escapeHtml(entry.name)}" ` +
        `data-search="${escapeHtml((entry.name + ' ' + entry.abbrevs.join(' ')).toLowerCase())}">${label}</button>`
      const list = groups.get(group) ?? []
      list.push(cell)
      groups.set(group, list)
    }

    const sections = [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([group, cells]) =>
        `<section><h3>${escapeHtml(group)}</h3><div class="grid">${cells.join('')}</div></section>`)
      .join('')

    const nonce = Math.random().toString(36).slice(2)
    return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
${isabelleCss()}
  #filter { width: 100%; box-sizing: border-box; margin-bottom: 8px; padding: 4px;
            font-family: var(--vscode-font-family);
            color: var(--vscode-input-foreground); background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, transparent); }
  h3 { font-family: var(--vscode-font-family); font-size: 11px; text-transform: uppercase;
       opacity: .6; margin: 10px 0 4px; }
  .grid { display: flex; flex-wrap: wrap; gap: 2px; }
  button.sym { font-family: inherit; font-size: 15px; line-height: 1.4; min-width: 26px;
               background: transparent; color: var(--vscode-editor-foreground);
               border: 1px solid transparent; border-radius: 3px; cursor: pointer; }
  button.sym:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
  section.hidden, button.sym.hidden { display: none; }
</style>
</head><body>
<input id="filter" type="text" placeholder="Filter symbols…" autocomplete="off">
${sections}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', e => {
    const b = e.target.closest('button.sym');
    if (b) vscode.postMessage({ command: 'insert', arg: b.getAttribute('data-name') });
  });
  document.getElementById('filter').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    for (const section of document.querySelectorAll('section')) {
      let visible = 0;
      for (const b of section.querySelectorAll('button.sym')) {
        const hit = !q || b.getAttribute('data-search').includes(q);
        b.classList.toggle('hidden', !hit);
        if (hit) visible++;
      }
      section.classList.toggle('hidden', visible === 0);
    }
  });
</script>
</body></html>`
  }
}

async function insertSymbol(name: string): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    void vscode.window.showInformationMessage('Open a theory first.')
    return
  }
  await editor.edit(b => {
    for (const sel of editor.selections) b.replace(sel, name)
  })
  // Clicking in the panel moves focus out of the editor; put it back.
  await vscode.window.showTextDocument(editor.document, editor.viewColumn)
}
