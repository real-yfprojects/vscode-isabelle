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
  sub: vscode.Range[]
  sup: vscode.Range[]
  bold: vscode.Range[]
}

export class SymbolRenderer implements vscode.Disposable {
  private hide!: vscode.TextEditorDecorationType
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
    // The escape text is shrunk to nothing; the glyph is supplied by a ::before
    // attachment, which needs its size restored explicitly since it would otherwise
    // inherit the 0.001em from the range it is attached to.
    const fontSize = vscode.workspace.getConfiguration('editor').get<number>('fontSize') ?? 14
    this.hide = vscode.window.createTextEditorDecorationType({
      textDecoration: 'none; font-size: 0.001em',
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      before: {
        textDecoration: `none; font-size: ${fontSize}px; letter-spacing: normal`,
      },
    })
    this.sub = vscode.window.createTextEditorDecorationType({
      textDecoration: 'none; position: relative; bottom: -0.4em; font-size: 80%',
    })
    this.sup = vscode.window.createTextEditorDecorationType({
      textDecoration: 'none; position: relative; top: -0.4em; font-size: 80%',
    })
    this.bold = vscode.window.createTextEditorDecorationType({
      textDecoration: 'none; font-weight: bold',
    })
  }

  private disposeTypes(): void {
    for (const t of [this.hide, this.sub, this.sup, this.bold]) t.dispose()
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
    const out: Ranges = { hidden: [], sub: [], sup: [], bold: [] }

    for (const visible of editor.visibleRanges) {
      const startLine = Math.max(0, visible.start.line - margin)
      const endLine = Math.min(doc.lineCount - 1, visible.end.line + margin)
      const span = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length)
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
        if (reveal && editor.selections.some(s => !!s.intersection(range))) continue

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
          out.hidden.push({ range, renderOptions: { before: { contentText: glyph } } })
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
    editor.setDecorations(this.sub, r.sub)
    editor.setDecorations(this.sup, r.sup)
    editor.setDecorations(this.bold, r.bold)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.disposeTypes()
  }
}

function config<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('isabelle').get<T>(key) ?? fallback
}
