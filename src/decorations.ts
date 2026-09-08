/* Render `\<forall>` escapes as Unicode glyphs without touching the buffer.
 *
 * The buffer and the file on disk stay pure ASCII, which is what `isabelle build`
 * requires. Only the *presentation* is Unicode.
 *
 * Decorating the whole document on every keystroke costs ~17ms on a 9k-line theory;
 * decorating only the viewport (+margin) costs ~1.6ms and is flat in file size, so
 * everything here is scoped to editor.visibleRanges.
 */

import * as vscode from 'vscode'
import { SYMBOL_RE, SymbolTable } from './symbols'
import { stickyLines } from './viewport'

/** Control symbols that restyle the single character following them. */
const SCRIPT_SINGLE: Record<string, 'sub' | 'sup' | 'bold'> = {
  '\\<^sub>': 'sub',
  '\\<^sup>': 'sup',
  '\\<^bold>': 'bold',
}

/** Control symbols that open/close a restyled span. */
const SCRIPT_BLOCK: Record<string, { close: string; kind: 'sub' | 'sup' }> = {
  '\\<^bsub>': { close: '\\<^esub>', kind: 'sub' },
  '\\<^bsup>': { close: '\\<^esup>', kind: 'sup' },
}

interface Ranges {
  hidden: vscode.DecorationOptions[]
  /** Glyphs drawn underlined, because the editor is offering to navigate from them. */
  linked: vscode.DecorationOptions[]
  sub: vscode.Range[]
  sup: vscode.Range[]
  bold: vscode.Range[]
}

export class SymbolRenderer implements vscode.Disposable {
  private hide!: vscode.TextEditorDecorationType
  private link!: vscode.TextEditorDecorationType
  /** The escape the editor is currently offering as a link, if any. */
  private linked: { uri: string; range: vscode.Range } | undefined
  private linkTimer: NodeJS.Timeout | undefined
  private sub!: vscode.TextEditorDecorationType
  private sup!: vscode.TextEditorDecorationType
  private bold!: vscode.TextEditorDecorationType
  private timer: NodeJS.Timeout | undefined
  private disposables: vscode.Disposable[] = []
  private enabled: boolean

  constructor(private readonly table: SymbolTable) {
    this.enabled = config<boolean>('renderSymbols', true)
    this.createTypes()
  }

  private createTypes(): void {
    /* The escape text is shrunk to nothing; the glyph is supplied by an ::after
       attachment, which needs its size restored explicitly since it would otherwise
       inherit the 0.001em from the range it is attached to.

       The leading ";" matters. `textDecoration` is the only decoration option that takes
       raw CSS, so it is the standard way to smuggle in a property the API does not
       expose -- but writing "none; font-size: ..." also *sets* text-decoration: none,
       which was never the intent. That silently suppressed every underline the editor
       draws over a symbol, including the one Ctrl+hover uses to show a name is
       clickable: the rule lands on the same element and wins over VS Code's own
       goto-definition class. Starting with ";" makes the text-decoration declaration
       empty, so the CSS parser drops just that one and keeps the rest. */
    const fontSize = vscode.workspace.getConfiguration('editor').get<number>('fontSize') ?? 14
    this.hide = vscode.window.createTextEditorDecorationType({
      textDecoration: '; font-size: 0.001em',
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      before: {
        textDecoration: `; font-size: ${fontSize}px; letter-spacing: normal`,
      },
    })
    /* Ctrl+hover marks a name as clickable by underlining it, and that never reached a
       glyph: the underline is a decoration on the *text*, which here is collapsed to
       nothing, while the glyph lives in an attachment span the editor's own decoration
       cannot style. So the underline is drawn onto the same attachment instead, and
       `markLink` swaps an escape onto this type while the offer stands. Underlining in
       place rather than expanding the escape avoids reflowing the line under the mouse,
       which would move the very character being hovered. */
    this.link = vscode.window.createTextEditorDecorationType({
      textDecoration: '; font-size: 0.001em',
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      before: {
        textDecoration:
          `; font-size: ${fontSize}px; letter-spacing: normal;` +
          ' text-decoration: underline; cursor: pointer',
      },
    })
    this.sub = vscode.window.createTextEditorDecorationType({
      textDecoration: '; position: relative; bottom: -0.4em; font-size: 80%',
    })
    this.sup = vscode.window.createTextEditorDecorationType({
      textDecoration: '; position: relative; top: -0.4em; font-size: 80%',
    })
    this.bold = vscode.window.createTextEditorDecorationType({
      textDecoration: '; font-weight: bold',
    })
  }

  private disposeTypes(): void {
    for (const t of [this.hide, this.link, this.sub, this.sup, this.bold]) t.dispose()
  }

  register(context: vscode.ExtensionContext): void {
    const schedule = (editor?: vscode.TextEditor) => this.schedule(editor)
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(e => schedule(e)),
      vscode.window.onDidChangeTextEditorVisibleRanges(e => schedule(e.textEditor)),
      vscode.window.onDidChangeTextEditorSelection(e => schedule(e.textEditor)),
      vscode.workspace.onDidChangeTextDocument(e => {
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document === e.document) schedule(editor)
        }
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('isabelle.renderSymbols') ||
            e.affectsConfiguration('isabelle.renderMarginLines') ||
            e.affectsConfiguration('isabelle.revealSymbolAtCursor') ||
            e.affectsConfiguration('editor.fontSize')) {
          this.enabled = config<boolean>('renderSymbols', true)
          this.clearAll()
          this.disposeTypes()
          this.createTypes()
          schedule(vscode.window.activeTextEditor)
        }
      }),
    )
    context.subscriptions.push(...this.disposables, this)
    this.schedule(vscode.window.activeTextEditor)
  }

  toggle(): boolean {
    this.enabled = !this.enabled
    if (!this.enabled) this.clearAll()
    else this.schedule(vscode.window.activeTextEditor)
    return this.enabled
  }

  private schedule(editor?: vscode.TextEditor): void {
    if (!editor || editor.document.languageId !== 'isabelle') return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.refresh(editor), 20)
  }

  private clearAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.hide, [])
      editor.setDecorations(this.link, [])
      editor.setDecorations(this.sub, [])
      editor.setDecorations(this.sup, [])
      editor.setDecorations(this.bold, [])
    }
  }

  /** Public for tests: what would be decorated in this editor right now. */
  computeRanges(editor: vscode.TextEditor): Ranges {
    const doc = editor.document
    const margin = config<number>('renderMarginLines', 100)
    const reveal = config<boolean>('revealSymbolAtCursor', true)
    const out: Ranges = { hidden: [], linked: [], sub: [], sup: [], bold: [] }

    // Sticky-header lines sit above the viewport but are still painted, so scan them too.
    const first = editor.visibleRanges[0]?.start.line ?? 0
    const spans: vscode.Range[] = stickyLines(doc, first)
      .filter(line => line < first - margin)
      .map(line => new vscode.Range(line, 0, line, doc.lineAt(line).text.length))
    for (const visible of editor.visibleRanges) {
      const startLine = Math.max(0, visible.start.line - margin)
      const endLine = Math.min(doc.lineCount - 1, visible.end.line + margin)
      spans.push(new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length))
    }

    for (const span of spans) {
      const text = doc.getText(span)
      const base = doc.offsetAt(span.start)

      SYMBOL_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = SYMBOL_RE.exec(text)) !== null) {
        const name = m[0]
        const from = base + m.index
        const to = from + name.length
        const range = new vscode.Range(doc.positionAt(from), doc.positionAt(to))

        // Leave the symbol the caret is inside as raw text so it can be edited.
        if (reveal && editor.selections.some(s => entersInterior(s, range))) continue

        const single = SCRIPT_SINGLE[name]
        if (single) {
          const nextEnd = to + 1
          if (nextEnd <= base + text.length) {
            const next = text[m.index + name.length]
            if (next !== undefined && next !== '\n' && next !== '\r' && next !== ' ') {
              out.hidden.push({ range })
              const target = new vscode.Range(doc.positionAt(to), doc.positionAt(nextEnd))
              out[single].push(target)
              continue
            }
          }
        }

        const block = SCRIPT_BLOCK[name]
        if (block) {
          const closeIdx = text.indexOf(block.close, m.index + name.length)
          if (closeIdx >= 0) {
            out.hidden.push({ range })
            out.hidden.push({
              range: new vscode.Range(
                doc.positionAt(base + closeIdx),
                doc.positionAt(base + closeIdx + block.close.length)),
            })
            out[block.kind].push(new vscode.Range(doc.positionAt(to), doc.positionAt(base + closeIdx)))
            SYMBOL_RE.lastIndex = closeIdx + block.close.length
            continue
          }
        }

        const glyph = this.table.glyphOf(name)
        if (glyph) {
          /* The glyph has to sit *inside* the escape's own columns, and an attachment on
             the whole range cannot do that.

             VS Code derives a column's x by measuring the line's DOM up to that column,
             and attachment content is emitted outside the boundary it names: a `before`
             glyph on the range start is measured into the *preceding* boundary, so the
             caret for the escape's start was drawn to the right of the glyph and Left
             looked like it crossed the glyph and the space in front of it at once.
             Moving to `after` simply mirrored the fault onto the space behind it.

             So the range is split. Everything but the final character is hidden outright,
             and the glyph is attached *before* that final character. Columns start..end-1
             then all collapse to the left edge, ahead of the glyph, while end lands after
             it -- the glyph occupies the escape's own width from both sides. The interior
             columns are only reachable when the symbol is revealed, at which point this
             decoration is not applied at all. */
          const last = new vscode.Range(doc.positionAt(to - 1), range.end)
          out.hidden.push({ range: new vscode.Range(range.start, last.start) })
          const target = this.isLinked(doc, range) ? out.linked : out.hidden
          target.push({ range: last, renderOptions: { before: { contentText: glyph } } })
        }
      }
    }
    return out
  }

  private refresh(editor: vscode.TextEditor): void {
    if (!this.enabled) { this.clearAll(); return }
    if (editor.document.languageId !== 'isabelle') return
    const r = this.computeRanges(editor)
    editor.setDecorations(this.hide, r.hidden)
    editor.setDecorations(this.link, r.linked)
    editor.setDecorations(this.sub, r.sub)
    editor.setDecorations(this.sup, r.sup)
    editor.setDecorations(this.bold, r.bold)
  }

  private isLinked(doc: vscode.TextDocument, range: vscode.Range): boolean {
    const l = this.linked
    return !!l && l.uri === doc.uri.toString() && l.range.isEqual(range)
  }

  /**
   * The editor is offering to navigate from `position`; underline the glyph there.
   *
   * Called from the definition middleware, because VS Code asks for a definition exactly
   * when it is deciding whether to draw the Ctrl+hover link, and there is no API for the
   * modifier itself. `navigable` says whether the server actually answered with a
   * location: the editor underlines only what it can jump to, and so must this, or the
   * glyph would advertise a jump that does not exist.
   *
   * Requests arrive continuously while the pointer moves, so the offer is cleared a short
   * while after the last one rather than on an event that does not exist.
   */
  markLink(doc: vscode.TextDocument, position: vscode.Position, navigable: boolean): void {
    if (!this.enabled || doc.languageId !== 'isabelle') return
    const range = navigable ? this.escapeAt(doc, position) : undefined
    const uri = doc.uri.toString()
    const changed = !range
      ? this.linked !== undefined
      : !this.isLinked(doc, range)
    this.linked = range ? { uri, range } : undefined

    if (this.linkTimer) clearTimeout(this.linkTimer)
    this.linkTimer = setTimeout(() => this.clearLink(), 400)
    if (changed) this.schedule(vscode.window.activeTextEditor)
  }

  private clearLink(): void {
    if (!this.linked) return
    this.linked = undefined
    this.schedule(vscode.window.activeTextEditor)
  }

  /** The rendered escape containing `position`, if any. */
  private escapeAt(doc: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
    const text = doc.lineAt(position.line).text
    SYMBOL_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = SYMBOL_RE.exec(text)) !== null) {
      const from = m.index
      const to = from + m[0].length
      if (from <= position.character && position.character < to && this.table.glyphOf(m[0])) {
        return new vscode.Range(position.line, from, position.line, to)
      }
    }
    return undefined
  }

  dispose(): void {
    if (this.linkTimer) clearTimeout(this.linkTimer)
    if (this.timer) clearTimeout(this.timer)
    this.disposeTypes()
  }
}

/**
 * Whether a selection reaches strictly *into* a symbol, as opposed to merely resting
 * against one of its ends.
 *
 * Touching a boundary must not count. The caret sits on the end boundary immediately
 * after `\forall` auto-expands, and revealing there would show the raw escape for one
 * keystroke before the glyph appeared. It would also make the rest of the line jump
 * sideways every time the caret passed a symbol.
 */
function entersInterior(sel: vscode.Selection, range: vscode.Range): boolean {
  if (sel.isEmpty) {
    return range.start.isBefore(sel.active) && sel.active.isBefore(range.end)
  }
  const overlap = sel.intersection(range)
  return !!overlap && !overlap.isEmpty
}

function config<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('isabelle').get<T>(key) ?? fallback
}
