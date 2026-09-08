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

/**
 * Message styling, from VS Code's own semantic colours rather than Isabelle's palette.
 *
 * The palette's `writeln`/`information`/`warning`/`error` entries are *not* background
 * colours: upstream uses them for dotted underlines and overview-ruler marks. They also
 * carry the same value for light and dark (writeln is rgba(192,192,192,1) in both), so
 * using them as backgrounds paints every message solid light grey and then writes the
 * theme foreground on top -- illegible in a dark theme, and sledgehammer output is
 * entirely writeln_message.
 */
const MESSAGE_STYLES: Record<string, string> = {
  writeln_message:
    'background-color: transparent;',
  information_message:
    'background-color: var(--vscode-textBlockQuote-background);' +
    'border-left: 3px solid var(--vscode-textLink-foreground);',
  tracing_message:
    'background-color: var(--vscode-textBlockQuote-background);' +
    'border-left: 3px solid var(--vscode-textLink-foreground);',
  warning_message:
    'background-color: var(--vscode-inputValidation-warningBackground);' +
    'border-left: 3px solid var(--vscode-inputValidation-warningBorder);',
  legacy_message:
    'background-color: var(--vscode-inputValidation-warningBackground);' +
    'border-left: 3px solid var(--vscode-inputValidation-warningBorder);',
  error_message:
    'background-color: var(--vscode-inputValidation-errorBackground);' +
    'border-left: 3px solid var(--vscode-inputValidation-errorBorder);',
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
  for (const [cls, style] of Object.entries(MESSAGE_STYLES)) {
    rules.push(`.${cls} { display: block; padding: 2px 6px; margin: 2px 0; ${style} }`)
  }

  return `
    body {
      color: var(--vscode-foreground);
      /* Transparent, so the host container supplies the background: these views live
         both in the side bar and in the bottom panel, which are coloured differently. */
      background-color: transparent;
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
/**
 * Reduce a whole HTML document to what can be embedded in a themed page.
 *
 * The Preview response is not a fragment: Browser_Info returns a complete document whose
 * head inlines $ISABELLE_HOME/etc/isabelle.css, which hardcodes a white page (`body
 * { color: #000000; background-color: #FFFFFF }`) along with light-theme syntax colours.
 * Nested inside our page that stylesheet lands *after* ours, so it wins the cascade and
 * the preview stays light whatever the VS Code theme is. The classes it styles are the
 * same ones isabelleCss() already colours from the theme, so dropping it loses nothing.
 */
export function documentBody(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)
  let inner = body ? body[1] : html
  // Also drop anything that survived outside a <head>, and stylesheet links: the CSP
  // blocks those anyway, so they can only fail silently.
  inner = inner.replace(/<style[\s\S]*?<\/style>/gi, '')
  inner = inner.replace(/<link\b[^>]*>/gi, '')
  return inner
}

export type PanelOptions = {
  /** Editor-tab webviews have no host container behind them, so they need a real
      background; side-bar and bottom-panel views must stay transparent to pick up
      whichever container they happen to be docked in. */
  background?: string
}

export function panelHtml(
  webview: vscode.Webview,
  body: string,
  options: PanelOptions = {},
): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36)
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${isabelleCss()}
${options.background ? `body { background-color: ${options.background}; }` : ''}</style>
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

  // Isabelle pretty-prints server-side to a fixed margin in characters, so the panel has
  // to tell it how wide it actually is or output wraps at the wrong column.
  var lastMargin = 0;
  function measureMargin() {
    var probe = document.createElement('span');
    probe.style.cssText =
      'position:absolute;visibility:hidden;white-space:pre;font-family:inherit;font-size:inherit';
    probe.textContent = new Array(81).join('0');
    document.body.appendChild(probe);
    var charWidth = probe.getBoundingClientRect().width / 80;
    probe.remove();
    if (!charWidth) return 0;
    return Math.max(20, Math.floor(document.body.clientWidth / charWidth));
  }
  function reportMargin() {
    var m = measureMargin();
    if (m && m !== lastMargin) {
      lastMargin = m;
      vscode.postMessage({ command: 'resize', margin: m });
    }
  }
  window.addEventListener('resize', reportMargin);
  setTimeout(reportMargin, 250);
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
