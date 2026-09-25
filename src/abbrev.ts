/* Symbol input: type `\forall`, get `\<forall>`.
 *
 * This is the lean4-unicode-input idea with one crucial difference. Lean's rewriter
 * replaces `\exists` with the *Unicode* character, because Lean's own lexer accepts
 * Unicode in source files. Isabelle's does not, so we expand to the ASCII escape
 * `\<forall>` instead and let the renderer display it as a glyph.
 */

import * as vscode from 'vscode'
import { SymbolEntry, SymbolTable, SYMBOL_RE } from './symbols'
import { autoClosers, Expansion, Shorthands, typedKey } from './shorthands'

/** Characters that may continue a symbol name, so typing one is no terminator. */
const NAME_CHAR_RE = /[A-Za-z0-9_^']/


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
  serverRunning: () => boolean,
  log: (message: string) => void,
): Shorthands {
  const custom = () => vscode.workspace.getConfiguration('isabelle')
    .get<Record<string, string>>('input.customShorthands', {})
  const shorthands = new Shorthands(table, custom())
  const report = () => {
    if (shorthands.invalidCustom.length) {
      log(`isabelle.input.customShorthands: ignored ${shorthands.invalidCustom.join(', ')} ` +
          '(keys must be non-blank without \\, and every \\<name> must be a known symbol)')
    }
  }
  report()
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      selector, new SymbolCompletionProvider(table, shorthands), '\\'),
    vscode.languages.registerCompletionItemProvider(
      selector, new SessionAbbrevProvider(abbrevs, serverRunning)),
    vscode.languages.registerHoverProvider(selector, new SymbolHoverProvider(table, shorthands)),
    vscode.workspace.onDidChangeTextDocument(e => void rewriteOnType(e, shorthands)),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('isabelle.input.customShorthands')) {
        shorthands.setCustom(custom())
        report()
      }
    }),
  )
  return shorthands
}

/** What SymbolCompletionProvider completes: a backslash and a partial symbol name. */
const SYMBOL_WORD_RE = /^\\[A-Za-z0-9_^']*$/

/**
 * Drop the server's plain symbol items for a `\name` word. SymbolCompletionProvider offers
 * the same symbols with substring matching, the glyph and documentation, and both would
 * otherwise be listed. Symbols reached through ASCII abbrevs such as `==>`, and symbol
 * templates (kind Snippet), are the server's alone and stay.
 */
export function dropDuplicateSymbols<T extends vscode.CompletionItem[] | vscode.CompletionList>(
  doc: vscode.TextDocument,
  result: T | null | undefined,
): T | null | undefined {
  if (!result) return result
  const keep = (item: vscode.CompletionItem): boolean => {
    if (item.kind !== vscode.CompletionItemKind.Operator) return true
    const range = item.range instanceof vscode.Range ? item.range : item.range?.replacing
    return !range || !SYMBOL_WORD_RE.test(doc.getText(range))
  }
  if (Array.isArray(result)) return result.filter(keep) as T
  result.items = result.items.filter(keep)
  return result
}

/**
 * Completion for session abbreviations. Deliberately has no trigger characters and
 * requires a match of at least two characters: these are arbitrary strings like "===",
 * and firing on a single character would be noise in the middle of a proof.
 *
 * Silent while the server runs: it completes the same abbrevs itself, and only where the
 * language context allows them.
 */
class SessionAbbrevProvider implements vscode.CompletionItemProvider {
  constructor(
    private readonly abbrevs: AbbrevStore,
    private readonly serverRunning: () => boolean,
  ) {}

  provideCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    if (this.serverRunning()) return []
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

/** Snippet text for an expansion: the caret goes where `$CURSOR` was. */
function snippetOf(exp: Expansion): vscode.SnippetString {
  const esc = (s: string) => s.replace(/[\\$}]/g, '\\$&')
  return new vscode.SnippetString(esc(exp.before) + (exp.after ? '$0' + esc(exp.after) : ''))
}

class SymbolCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly table: SymbolTable, private readonly shorthands: Shorthands) {}

  provideCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const prefixText = doc.lineAt(position.line).text.slice(0, position.character)
    const items = this.shorthandItems(prefixText, position)
    const m = /\\([A-Za-z0-9_^']*)$/.exec(prefixText)
    if (!m) return items
    const replace = new vscode.Range(
      position.translate(0, -m[0].length), position)

    const typed = m[1].toLowerCase()
    for (const entry of this.table.entries) {
      const inner = entry.name.slice(2, -1) // "\<forall>" -> "forall", "\<^sub>" -> "^sub"
      const matchesName = inner.toLowerCase().includes(typed)
      const matchesAbbrev = entry.abbrevs.some(a => a.toLowerCase().startsWith(typed))
      if (typed && !matchesName && !matchesAbbrev) continue

      // Operator, as the server marks symbols too: Text is the icon of plain words.
      const item = new vscode.CompletionItem(
        `\\${inner}`, vscode.CompletionItemKind.Operator)
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

  /** Shorthands whose key starts with what follows the `\`, which may be punctuation. */
  private shorthandItems(prefixText: string, position: vscode.Position): vscode.CompletionItem[] {
    const key = prefixText.endsWith('\\') ? '' : typedKey(prefixText)
    if (key === undefined) return []
    const replace = new vscode.Range(position.translate(0, -(key.length + 1)), position)
    return this.shorthands.entries()
      .filter(([k]) => k.startsWith(key))
      .map(([k, exp]) => {
        const shown = this.table.decode(exp.before) + (exp.after ? '…' + this.table.decode(exp.after) : '')
        const item = new vscode.CompletionItem(
          `\\${k}`, exp.after ? vscode.CompletionItemKind.Snippet : vscode.CompletionItemKind.Operator)
        item.detail = `${shown}   ${exp.before}${exp.after ? '…' + exp.after : ''}`
        item.insertText = snippetOf(exp)
        item.filterText = `\\${k}`
        item.range = replace
        item.sortText = k === key ? '0' : '1'
        return item
      })
  }
}

/** On a rendered symbol: its escape, and every way to type it. */
class SymbolHoverProvider implements vscode.HoverProvider {
  constructor(private readonly table: SymbolTable, private readonly shorthands: Shorthands) {}

  provideHover(doc: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const line = doc.lineAt(position.line).text
    SYMBOL_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = SYMBOL_RE.exec(line)) !== null) {
      const start = m.index, end = m.index + m[0].length
      if (position.character < start || position.character >= end) continue
      const entry = this.table.get(m[0])
      if (!entry) return undefined
      const ways = [`\\${SymbolTable.keyOf(entry.name)}`,
        ...this.shorthands.keysFor(entry.name).map(k => `\\${k}`), ...entry.abbrevs]
      const md = new vscode.MarkdownString()
      md.appendMarkdown(`${entry.glyph ? `**${entry.glyph}** ` : ''}\`${entry.name}\`\n\n`)
      md.appendMarkdown(`Type ${[...new Set(ways)].map(w => '`' + w + '`').join(', ')}`)
      return new vscode.Hover(md, new vscode.Range(position.line, start, position.line, end))
    }
    return undefined
  }
}

/**
 * Expand as soon as the typed word is an unambiguous complete symbol name.
 * "\subset" must NOT fire immediately, because "\subseteq" extends it - those wait
 * for the user to type a character that cannot continue a symbol name.
 */
async function rewriteOnType(
  event: vscode.TextDocumentChangeEvent,
  shorthands: Shorthands,
): Promise<void> {
  const doc = event.document
  if (doc.languageId !== 'isabelle') return
  if (!vscode.workspace.getConfiguration('isabelle').get<boolean>('expandAbbreviations', true)) return
  if (event.contentChanges.length !== 1) return

  const change = event.contentChanges[0]
  if (change.rangeLength !== 0) return
  // One typed character, or an opening bracket that VS Code closed at once: "[]".
  const autoClosed = change.text.length === 2 && autoClosers(change.text[0]) === change.text[1]
  if (change.text.length !== 1 && !autoClosed) return

  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document !== doc) return

  const caret = doc.positionAt(change.rangeOffset + 1)
  const linePrefix = doc.lineAt(caret.line).text.slice(0, caret.character)
  const typedChar = change.text[0]

  let key: string | undefined
  let exp: Expansion | undefined
  let trailing = ''

  // While a longer key is still reachable, wait: "sub" must not become \<^sub> when
  // \<subseteq> is still possible, nor "<-" become \<leftarrow> before "<->" is ruled out.
  const typed = typedKey(linePrefix)
  if (typed !== undefined && !shorthands.canExtend(typed)) {
    exp = shorthands.lookup(typed)
    if (exp) key = typed
  }
  // A terminator: expand the complete key sitting just before it -- unless the character
  // still continues some key, or could continue a symbol name.
  if (!exp && !NAME_CHAR_RE.test(typedChar) && !(typed !== undefined && shorthands.isKeyPrefix(typed))) {
    const before = typedKey(linePrefix.slice(0, -1))
    if (before !== undefined) {
      exp = shorthands.lookup(before)
      if (exp) { key = before; trailing = typedChar }
    }
  }
  if (!exp || key === undefined) return

  const start = caret.translate(0, -(key.length + 1 + trailing.length))
  let end = trailing ? caret.translate(0, -trailing.length) : caret
  if (doc.getText(new vscode.Range(start, end)) !== `\\${key}`) return
  // The closers VS Code put after the caret while the key was typed go with it.
  const closers = trailing ? '' : autoClosers(key)
  if (closers && doc.getText(new vscode.Range(end, end.translate(0, closers.length))) === closers) {
    end = end.translate(0, closers.length)
  }
  const target = new vscode.Range(start, end)

  const { before, after } = exp
  const ok = await editor.edit(b => b.replace(target, before + after),
    { undoStopBefore: false, undoStopAfter: false })
  if (ok && after) {
    const inside = start.translate(0, before.length)
    editor.selection = new vscode.Selection(inside, inside)
  }
}

export function symbolAt(table: SymbolTable, entry: SymbolEntry): string {
  return entry.glyph ?? entry.name
}
