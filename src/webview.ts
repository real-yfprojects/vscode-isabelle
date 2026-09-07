/* Shared scaffolding for the Output and State panels.
 *
 * With vscode_html_output=true the server hands us ready-made HTML using Isabelle's
 * own markup classes (keyword1, free, bound, writeln_message, ...). We supply the
 * stylesheet. $ISABELLE_HOME/etc/isabelle.css exists but hardcodes a white page, so
 * instead the classes are coloured from the same palette the editor decorations use
 * and the page itself inherits the VS Code theme.
 *
 * Setting vscode_html_output=true also sidesteps an Isabelle2025-2 bug: the non-HTML
 * branch attaches decorations, and LSP.Dynamic_Output.apply serialises them via an
 * unapplied method, producing "Bad JSON value: ...$$Lambda" on every output event.
 */

import * as vscode from 'vscode'
import { ISABELLE_COLORS, colorOf } from './colors'

/** Isabelle markup classes that carry a message background rather than a text colour. */
const MESSAGE_BACKGROUNDS: Record<string, string> = {
  writeln_message: 'writeln',
  information_message: 'information',
  tracing_message: 'information',
  warning_message: 'warning',
  legacy_message: 'warning',
  error_message: 'error',
}

function isLight(): boolean {
  const kind = vscode.window.activeColorTheme.kind
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
}

export function isabelleCss(): string {
  const light = isLight()
  const overrides = vscode.workspace.getConfiguration('isabelle')
    .get<Record<string, string>>('textColorOverrides') ?? {}
  const rules: string[] = []

  for (const name of Object.keys(ISABELLE_COLORS)) {
    const color = colorOf(name, light, overrides)
    if (color) rules.push(`.${name} { color: ${color}; }`)
  }
  // Backgrounds win over the text colour of the same name.
  for (const [cls, palette] of Object.entries(MESSAGE_BACKGROUNDS)) {
    const color = colorOf(palette, light, overrides)
    if (color) rules.push(`.${cls} { background-color: ${color}; display: block; padding: 2px 4px; }`)
  }

  return `
    body {
      color: var(--vscode-editor-foreground);
      background-color: var(--vscode-editor-background);
      font-family: 'Isabelle DejaVu Sans Mono', var(--vscode-editor-font-family), monospace;
      font-size: var(--vscode-editor-font-size);
      margin: 0; padding: 6px;
    }
    pre, .source { margin: 0; white-space: pre-wrap; word-break: break-word;
                   font-family: inherit; direction: ltr; unicode-bidi: bidi-override; }
    a { color: inherit; text-decoration: none; border-bottom: 1px dotted currentColor; cursor: pointer; }
    .bold { font-weight: bold; }
    .hidden { display: none; }
    ${rules.join('\n    ')}
  `
}

/**
 * Wrap server HTML in a themed document. Scripts are enabled only to forward link
 * clicks back to the extension; the CSP pins them to a single nonce.
 *
 * `body` is markup produced by Isabelle's own Browser_Info and has to be inserted as
 * markup -- that is the whole point of vscode_html_output. It can contain text echoed
 * from theory files, so the CSP is what keeps that safe: `default-src 'none'` blocks
 * every external load, and `script-src 'nonce-...'` means an injected <script> cannot
 * run. The webview is also sandboxed from the extension host, whose only channel is the
 * postMessage handler below.
 */
export function panelHtml(webview: vscode.Webview, body: string): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36)
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${isabelleCss()}</style>
</head><body>
<div id="content">${body}</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
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
</script>
</body></html>`
}

/**
 * Open a link from panel HTML. Isabelle emits `file:/C:/path/Thy.thy#123`, where the
 * fragment is a 1-based line number.
 */
export async function openIsabelleLink(link: string): Promise<void> {
  const m = /^file:\/{1,3}(.*?)(?:#(\d+))?$/.exec(link)
  if (!m) return
  let filePath = decodeURIComponent(m[1])
  if (!/^[A-Za-z]:/.test(filePath) && !filePath.startsWith('/')) filePath = '/' + filePath
  const line = m[2] ? Math.max(0, parseInt(m[2], 10) - 1) : 0
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
    const editor = await vscode.window.showTextDocument(doc, { preview: true })
    const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0)
    editor.selection = new vscode.Selection(pos, pos)
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
  } catch {
    void vscode.window.showWarningMessage(`Cannot open ${filePath}`)
  }
}
