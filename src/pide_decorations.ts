/* PIDE markup as editor decorations.
 *
 * The server pushes `PIDE/decoration` notifications carrying syntax colouring and
 * processing status (unprocessed / running / bad / error overview marks). This is the
 * feature that makes a theory look like a proof document rather than plain text.
 *
 * Requires the vscode_pide_extensions option; the extension turns it on by default.
 *
 * Ranges arrive in compact form as [startLine, startChar, endLine, endChar]
 * (LSP.Range.compact server-side), not as LSP Position objects.
 *
 * The server sends markup for the *whole* document -- 51,516 ranges on a 9k-line theory --
 * and handing all of that to setDecorations costs ~40ms per keystroke. VS Code renders
 * nothing outside the viewport, so the full set is kept here and only the visible slice
 * (plus a margin) is applied, which is the same trick symbol rendering uses.
 */

import * as vscode from 'vscode'
import { LanguageClient } from 'vscode-languageclient/node'
import { colorOf } from './colors'
import { stickyLines } from './viewport'
import { themeColorsMarkup } from './semantic_tokens'

const BACKGROUND = [
  'unprocessed1', 'running1', 'canceled', 'bad', 'intensify', 'quoted', 'antiquoted',
  'markdown_bullet1', 'markdown_bullet2', 'markdown_bullet3', 'markdown_bullet4',
]
const FOREGROUND = ['quoted', 'antiquoted']
const DOTTED = ['writeln', 'information', 'warning']
const TEXT = [
  'main', 'keyword1', 'keyword2', 'keyword3', 'quasi_keyword', 'improper', 'operator',
  'tfree', 'tvar', 'free', 'skolem', 'bound', 'var', 'inner_numeral', 'inner_quoted',
  'inner_cartouche', 'comment1', 'comment2', 'comment3', 'dynamic', 'class_parameter',
  'antiquote', 'raw_text', 'plain_text',
]
const OVERVIEW = ['unprocessed', 'running', 'error', 'warning']

export interface TypeRanges {
  items: vscode.DecorationOptions[]
  /** Tallest range, so a binary search on start lines cannot miss a tall overlap. */
  maxHeight: number
}

/**
 * The visible slice of a sorted range list. Filtering is O(n) per type per scroll event,
 * which on 51000 ranges across 40 types is the dominant cost; this is O(log n + k).
 */
function sliceFor(entry: TypeRanges, first: number, last: number): vscode.DecorationOptions[] {
  const { items, maxHeight } = entry
  const from = first - maxHeight
  let lo = 0, hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (items[mid].range.start.line < from) lo = mid + 1
    else hi = mid
  }
  const out: vscode.DecorationOptions[] = []
  for (let i = lo; i < items.length && items[i].range.start.line <= last; i++) {
    if (items[i].range.end.line >= first) out.push(items[i])
  }
  return out
}

interface CompactEntry {
  type: string
  content: { range: [number, number, number, number]; hover_message?: unknown }[]
}

export class PideDecorations implements vscode.Disposable {
  private types = new Map<string, vscode.TextEditorDecorationType>()
  /** uri -> decoration type -> ranges, sorted by start line. Per-type updates merge. */
  private perDocument = new Map<string, Map<string, TypeRanges>>()
  /** editor uri -> decoration type -> shape of the last applied slice, to skip
   *  redundant setDecorations round trips. Nested rather than a concatenated key,
   *  which needs no separator that type names or URIs might contain. */
  private lastApplied = new Map<string, Map<string, string>>()
  private disposables: vscode.Disposable[] = []
  private timer: NodeJS.Timeout | undefined
  /** Fires when a document's markup changed, so semantic tokens can be re-requested. */
  private readonly updated = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidUpdate = this.updated.event

  constructor(private readonly log: (m: string) => void) {
    this.createTypes()
  }

  private createTypes(): void {
    const overrides = vscode.workspace.getConfiguration('isabelle')
      .get<Record<string, string>>('textColorOverrides') ?? {}
    const pick = (name: string, light: boolean) => colorOf(name, light, overrides)

    const make = (key: string, options: vscode.DecorationRenderOptions) =>
      this.types.set(key, vscode.window.createTextEditorDecorationType(options))

    for (const c of BACKGROUND) {
      make('background_' + c, {
        light: { backgroundColor: pick(c, true) },
        dark: { backgroundColor: pick(c, false) },
      })
    }
    // Upstream renders foreground_* as a background too, calling it an approximation.
    for (const c of FOREGROUND) {
      make('foreground_' + c, {
        light: { backgroundColor: pick(c, true) },
        dark: { backgroundColor: pick(c, false) },
      })
    }
    for (const c of DOTTED) {
      const border = (light: boolean) =>
        `2px none; border-bottom-style: dotted; border-color: ${pick(c, light)}`
      make('dotted_' + c, { light: { border: border(true) }, dark: { border: border(false) } })
    }
    for (const c of TEXT) {
      make('text_' + c, { light: { color: pick(c, true) }, dark: { color: pick(c, false) } })
    }
    for (const c of OVERVIEW) {
      make('text_overview_' + c, {
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        light: { overviewRulerColor: pick(c, true) },
        dark: { overviewRulerColor: pick(c, false) },
      })
    }
    make('spell_checker', {
      light: { border: `1px none; border-bottom-style: solid; border-color: ${pick('spell_checker', true)}` },
      dark: { border: `1px none; border-bottom-style: solid; border-color: ${pick('spell_checker', false)}` },
    })
  }

  register(scope: vscode.Disposable[], client: LanguageClient): void {
    this.disposables.push(
      client.onNotification('PIDE/decoration', (params: { uri: string; entries: CompactEntry[] }) => {
        try { this.receive(params) } catch (err) { this.log(`decoration failed: ${err}`) }
      }),
      // Scrolling changes which slice is visible, so re-apply.
      vscode.window.onDidChangeTextEditorVisibleRanges(e => {
        if (e.textEditor.document.languageId === 'isabelle') this.schedule(e.textEditor)
      }),
      vscode.window.onDidChangeVisibleTextEditors(editors => {
        for (const editor of editors) {
          if (editor.document.languageId !== 'isabelle') continue
          this.applyTo(editor)
          // Ask the server to resend: it only pushes on change, so a newly visible
          // editor would otherwise stay undecorated until the next edit.
          client.sendNotification('PIDE/decoration_request', {
            uri: client.code2ProtocolConverter.asUri(editor.document.uri),
          }).catch(() => undefined)
        }
      }),
      vscode.workspace.onDidCloseTextDocument(doc => {
        this.perDocument.delete(doc.uri.toString())
      }),
    )
    scope.push(...this.disposables, this)
  }

  /** Coalesce bursts of scroll events into one re-apply. */
  private schedule(editor: vscode.TextEditor): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.applyTo(editor), 20)
  }

  private receive(params: { uri: string; entries: CompactEntry[] }): void {
    const uri = vscode.Uri.parse(params.uri)
    const key = uri.toString()
    let byType = this.perDocument.get(key)
    if (!byType) { byType = new Map(); this.perDocument.set(key, byType) }

    for (const entry of params.entries) {
      const items = entry.content.map(c => ({
        range: new vscode.Range(c.range[0], c.range[1], c.range[2], c.range[3]),
      }))
      items.sort((a, b) => a.range.start.line - b.range.start.line)
      let maxHeight = 0
      for (const i of items) maxHeight = Math.max(maxHeight, i.range.end.line - i.range.start.line)
      byType.set(entry.type, { items, maxHeight })
      this.lastApplied.get(key)?.delete(entry.type)
    }
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === key) this.applyTo(editor)
    }
    this.updated.fire(uri)
  }

  /** The markup this document currently has, by decoration type. */
  rangesFor(uri: vscode.Uri): ReadonlyMap<string, TypeRanges> | undefined {
    return this.perDocument.get(uri.toString())
  }

  /** Lines the editor could plausibly show, given its viewport plus a margin. */
  private visibleSpan(editor: vscode.TextEditor): { first: number; last: number } | undefined {
    const cfg = vscode.workspace.getConfiguration('isabelle')
    if (!cfg.get<boolean>('pideViewportScope', true)) return undefined
    if (editor.visibleRanges.length === 0) return undefined
    const margin = cfg.get<number>('renderMarginLines') ?? 100
    let first = Number.MAX_SAFE_INTEGER
    let last = -1
    for (const r of editor.visibleRanges) {
      first = Math.min(first, r.start.line - margin)
      last = Math.max(last, r.end.line + margin)
    }
    return { first: Math.max(0, first), last }
  }

  private applyTo(editor: vscode.TextEditor): void {
    if (!vscode.workspace.getConfiguration('isabelle').get<boolean>('pideMarkup', true)) {
      for (const type of this.types.values()) editor.setDecorations(type, [])
      this.lastApplied.clear()
      return
    }
    const byType = this.perDocument.get(editor.document.uri.toString())
    if (!byType) return
    const span = this.visibleSpan(editor)
    const sticky = span
      ? stickyLines(editor.document, editor.visibleRanges[0]?.start.line ?? 0)
      : []
    const editorKey = editor.document.uri.toString()
    /* When the theme owns token colours, the text_* categories are served as semantic
       tokens instead. They must not also be decorated: a decoration `color` overrides
       the theme, which is the whole bug being fixed. Backgrounds, underlines and ruler
       marks are unaffected -- no theme has an opinion about those. */
    const themed = themeColorsMarkup()
    for (const [name, type] of this.types) {
      if (themed && name.startsWith('text_') && !name.startsWith('text_overview_')) {
        if (this.lastApplied.get(editorKey)?.get(name) !== 'off') {
          editor.setDecorations(type, [])
          let applied = this.lastApplied.get(editorKey)
          if (!applied) { applied = new Map(); this.lastApplied.set(editorKey, applied) }
          applied.set(name, 'off')
        }
        continue
      }
      const entry = byType.get(name)
      if (!entry || entry.items.length === 0) { editor.setDecorations(type, []); continue }

      let slice = span ? sliceFor(entry, span.first, span.last) : entry.items
      if (span && sticky.length > 0) {
        // The sticky header shows lines from above the viewport; decorate those too.
        const extra = sticky.flatMap(line =>
          line < span.first ? sliceFor(entry, line, line) : [])
        if (extra.length > 0) slice = extra.concat(slice)
      }
      // Re-applying an identical slice still costs a round trip to the renderer.
      const shape = slice.length === 0 ? '0'
        : `${slice.length}:${slice[0].range.start.line}:${slice[slice.length - 1].range.end.line}:${sticky.join(',')}`
      let applied = this.lastApplied.get(editorKey)
      if (!applied) { applied = new Map(); this.lastApplied.set(editorKey, applied) }
      if (applied.get(name) === shape) continue
      applied.set(name, shape)
      editor.setDecorations(type, slice)
    }
  }

  /** Test hook: how many ranges are currently held, by decoration type. */
  summary(uri: vscode.Uri): Record<string, number> | undefined {
    const byType = this.perDocument.get(uri.toString())
    if (!byType) return undefined
    const out: Record<string, number> = {}
    for (const [name, entry] of byType) if (entry.items.length) out[name] = entry.items.length
    return out
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    for (const t of this.types.values()) t.dispose()
    this.types.clear()
  }
}
