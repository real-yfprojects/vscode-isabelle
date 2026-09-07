/* Symbol input: type `\forall`, get `\<forall>`.
 *
 * This is the lean4-unicode-input idea with one crucial difference. Lean's rewriter
 * replaces `\exists` with the *Unicode* character, because Lean's own lexer accepts
 * Unicode in source files. Isabelle's does not, so we expand to the ASCII escape
 * `\<forall>` instead and let the renderer display it as a glyph.
 */

import * as vscode from 'vscode'
import { SymbolEntry, SymbolTable } from './symbols'

/** A partially typed abbreviation immediately before the caret. */
const PREFIX_RE = /\\([A-Za-z][A-Za-z0-9_^']*)$/


/**
 * Outer-syntax abbreviations of the loaded session, from PIDE/abbrevs_request.
 * These are session-specific (declared by `keywords ... abbrevs` in theory headers) and
 * complement the static `abbrev:` fields of etc/symbols.
 */
export class AbbrevStore {
  private pairs: [from: string, to: string][] = []

  set(abbrevs: [string, string][]): void {
    // Longest first, so "===" wins over "==" at the same caret position.
    this.pairs = (abbrevs ?? []).filter(p => p?.length === 2 && p[0] && p[1])
      .sort((a, b) => b[0].length - a[0].length)
  }

  get size(): number { return this.pairs.length }

  /** Abbreviations whose text ends at the caret. */
  matching(textBeforeCaret: string): [string, string][] {
    return this.pairs.filter(([from]) => from.length >= 2 && textBeforeCaret.endsWith(from))
  }
}

export function registerAbbreviations(
  context: vscode.ExtensionContext,
  table: SymbolTable,
  selector: vscode.DocumentSelector,
  abbrevs: AbbrevStore,
): void {
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector, new SymbolCompletionProvider(table), '\\'),
    vscode.languages.registerCompletionItemProvider(
      selector, new SessionAbbrevProvider(abbrevs)),
    vscode.workspace.onDidChangeTextDocument(e => void rewriteOnType(e, table)),
  )
}

/**
 * Completion for session abbreviations. Deliberately has no trigger characters and
 * requires a match of at least two characters: these are arbitrary strings like "===",
 * and firing on a single character would be noise in the middle of a proof.
 */
class SessionAbbrevProvider implements vscode.CompletionItemProvider {
  constructor(private readonly abbrevs: AbbrevStore) {}

  provideCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const line = doc.lineAt(position.line).text.slice(0, position.character)
    const tail = line.slice(-16)
    return this.abbrevs.matching(tail).map(([from, to]) => {
      const item = new vscode.CompletionItem(to, vscode.CompletionItemKind.Snippet)
      item.detail = `abbrev ${from}`
      item.insertText = to
      item.filterText = from
      item.range = new vscode.Range(position.translate(0, -from.length), position)
      item.sortText = '0'
      return item
    })
  }
}

class SymbolCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly table: SymbolTable) {}

  provideCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const prefixText = doc.lineAt(position.line).text.slice(0, position.character)
    const m = /\\([A-Za-z0-9_^']*)$/.exec(prefixText)
    if (!m) return []
    const replace = new vscode.Range(
      position.translate(0, -m[0].length), position)

    const typed = m[1].toLowerCase()
    const items: vscode.CompletionItem[] = []
    for (const entry of this.table.entries) {
      const inner = entry.name.slice(2, -1) // "\<forall>" -> "forall", "\<^sub>" -> "^sub"
      const matchesName = inner.toLowerCase().includes(typed)
      const matchesAbbrev = entry.abbrevs.some(a => a.toLowerCase().startsWith(typed))
      if (typed && !matchesName && !matchesAbbrev) continue

      const item = new vscode.CompletionItem(
        `\\${inner}`, vscode.CompletionItemKind.Text)
      item.detail = entry.glyph ? `${entry.glyph}   ${entry.name}` : entry.name
      item.documentation = new vscode.MarkdownString(
        [entry.glyph ? `**${entry.glyph}**` : undefined,
         `\`${entry.name}\``,
         entry.abbrevs.length ? `abbrev: ${entry.abbrevs.map(a => `\`${a}\``).join(', ')}` : undefined,
         entry.groups.length ? `group: ${entry.groups.join(', ')}` : undefined,
        ].filter(Boolean).join('  \n'))
      item.insertText = entry.name
      item.filterText = `\\${inner}`
      item.range = replace
      // Exact name matches first, then prefix matches, then substring matches.
      item.sortText = inner.toLowerCase() === typed ? '0' : inner.toLowerCase().startsWith(typed) ? '1' : '2'
      items.push(item)
    }
    return items
  }
}

/**
 * Expand as soon as the typed word is an unambiguous complete symbol name.
 * "\subset" must NOT fire immediately, because "\subseteq" extends it - those wait
 * for the user to type a character that cannot continue a symbol name.
 */
async function rewriteOnType(
  event: vscode.TextDocumentChangeEvent,
  table: SymbolTable,
): Promise<void> {
  const doc = event.document
  if (doc.languageId !== 'isabelle') return
  if (!vscode.workspace.getConfiguration('isabelle').get<boolean>('expandAbbreviations', true)) return
  if (event.contentChanges.length !== 1) return

  const change = event.contentChanges[0]
  if (change.text.length !== 1 || change.rangeLength !== 0) return

  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document !== doc) return

  const caret = doc.positionAt(change.rangeOffset + change.text.length)
  const linePrefix = doc.lineAt(caret.line).text.slice(0, caret.character)
  const typedChar = change.text

  const isNameChar = /[A-Za-z0-9_^']/.test(typedChar)
  let word: string | undefined
  let trailing = ''

  if (isNameChar) {
    const m = PREFIX_RE.exec(linePrefix)
    if (m) word = m[1]
  } else {
    // A terminator: expand the longest complete symbol sitting just before it.
    const m = PREFIX_RE.exec(linePrefix.slice(0, -1))
    if (m) { word = m[1]; trailing = typedChar }
  }
  if (!word) return

  const entry = table.lookupByKey(word)
  if (!entry) return
  // While a longer symbol name is still reachable, wait for a terminator rather than
  // expanding early: "sub" must not become \<^sub> when \<subseteq> is still possible.
  if (isNameChar && table.canExtend(word)) return
  const name = entry.name

  const start = caret.translate(0, -(word.length + 1 + trailing.length))
  const end = trailing ? caret.translate(0, -trailing.length) : caret
  const target = new vscode.Range(start, end)
  if (doc.getText(target) !== `\\${word}`) return

  await editor.edit(b => b.replace(target, name), { undoStopBefore: false, undoStopAfter: false })
}

export function symbolAt(table: SymbolTable, entry: SymbolEntry): string {
  return entry.glyph ?? entry.name
}
