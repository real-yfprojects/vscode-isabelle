/* Code skeletons in the editor: a stock server's sendback code actions get a title and a
 * kind, and a proof outline -- or, from the extended server, the rest of an instantiation --
 * also appears as ghost text on the blank line below its command.
 *
 * The outline is Isabelle's own (see skeletons.ts), so that part works against a stock
 * server. The extended server titles its actions itself and adds skeletons of its own
 * (vscode_skeletons.ML).
 */

import * as vscode from 'vscode'
import { CodeActionRequest, LanguageClient, State } from 'vscode-languageclient/node'
import * as lsp from 'vscode-languageclient/node'
import { addedLines, classifySendback, ghostText, isBlank, isGhostCandidate,
  mayCarrySkeleton, startsOutline } from './skeletons'

export const OUTLINE_KIND = vscode.CodeActionKind.RefactorRewrite.append('isabelle').append('outline')
export const PROOF_KIND = vscode.CodeActionKind.QuickFix.append('isabelle').append('proof')

/**
 * Middleware for provideCodeActions: the server sends neither kind nor a usable title, so
 * a found proof and an outline look alike in the menu. Actions that already carry a kind
 * are someone else's and stay as they are.
 */
export function retitleSendbacks(
  actions: (vscode.Command | vscode.CodeAction)[] | null | undefined,
): (vscode.Command | vscode.CodeAction)[] | null | undefined {
  if (!actions) return actions
  let preferred = false
  for (const a of actions) {
    if (!(a instanceof vscode.CodeAction) || a.kind || !a.edit) continue
    const s = classifySendback(a.title)
    a.title = s.title
    a.kind = s.kind === 'outline' ? OUTLINE_KIND : PROOF_KIND
    // The first found proof is try0's or Sledgehammer's best: what "auto fix" should apply.
    if (s.kind === 'proof' && !preferred) a.isPreferred = preferred = true
  }
  return actions
}

/* How long to wait for the prover to finish the `proof` above before giving up: ENTER is
   usually pressed right after typing the method, so the outline is not there yet. */
const POLL_MS = 400
const POLL_FOR_MS = 8000

/** Ghost text for the outline of the `proof` above a blank line. */
class OutlineInlineProvider implements vscode.InlineCompletionItemProvider {
  constructor(private readonly client: () => LanguageClient | undefined) {}

  async provideInlineCompletionItems(
    doc: vscode.TextDocument, pos: vscode.Position,
    _context: vscode.InlineCompletionContext, token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (!vscode.workspace.getConfiguration('isabelle', doc)
      .get<boolean>('completion.inlineSkeletons', true)) return undefined
    const line = doc.lineAt(pos.line).text
    if (!isBlank(line)) return undefined

    let above = pos.line - 1
    while (above >= 0 && isBlank(doc.lineAt(above).text)) above--
    if (above < 0) return undefined
    let below = pos.line + 1
    while (below < doc.lineCount && isBlank(doc.lineAt(below).text)) below++
    if (below < doc.lineCount && startsOutline(doc.lineAt(below).text)) return undefined

    const commandEnd = doc.lineAt(above).range.end
    const poll = mayCarrySkeleton(doc.lineAt(above).text)
    const deadline = Date.now() + (poll ? POLL_FOR_MS : 0)
    for (;;) {
      const found = await this.skeleton(doc, commandEnd, token)
      if (token.isCancellationRequested) return undefined
      if (found) {
        const text = ghostText(found.snippet, found.commandIndent, line.slice(0, pos.character))
        return [new vscode.InlineCompletionItem(text,
          new vscode.Range(pos.line, 0, pos.line, pos.character))]
      }
      if (Date.now() >= deadline) return undefined
      await new Promise(r => setTimeout(r, POLL_MS))
      if (token.isCancellationRequested || doc.lineAt(pos.line).text !== line) return undefined
    }
  }

  /* Straight to the server rather than through vscode.executeCodeActionProvider, which
     would hand back the actions converted, and a stock server's retitled. */
  private async skeleton(doc: vscode.TextDocument, at: vscode.Position,
    token: vscode.CancellationToken): Promise<{ snippet: string, commandIndent: string } | undefined> {
    const c = this.client()
    if (!c || c.state !== State.Running) return undefined
    let result: (lsp.Command | lsp.CodeAction)[] | null
    try {
      result = await c.sendRequest(CodeActionRequest.type, {
        textDocument: { uri: c.code2ProtocolConverter.asUri(doc.uri) },
        range: c.code2ProtocolConverter.asRange(new vscode.Range(at, at)),
        context: { diagnostics: [] },
      }, token)
    } catch {
      return undefined
    }
    for (const a of result ?? []) {
      if (!lsp.CodeAction.is(a) || !isGhostCandidate(a.kind, a.title)) continue
      const edit = firstEdit(a)
      if (!edit) continue
      const range = c.protocol2CodeConverter.asRange(edit.range)
      const commandIndent = /^[ \t]*/.exec(doc.lineAt(range.start.line).text)![0]
      const snippet = addedLines(doc.getText(range), edit.newText, commandIndent)
      if (snippet) return { snippet, commandIndent }
    }
    return undefined
  }
}

/** The action's one edit: on the skeleton's command, as the server sends it. */
function firstEdit(a: lsp.CodeAction): lsp.TextEdit | undefined {
  const change = a.edit?.documentChanges?.[0]
  if (change && lsp.TextDocumentEdit.is(change)) return change.edits[0]
  const edits = a.edit?.changes && Object.values(a.edit.changes)[0]
  return edits?.[0]
}

export function registerSkeletons(
  subscriptions: vscode.Disposable[],
  selector: vscode.DocumentSelector,
  client: () => LanguageClient | undefined,
): void {
  const provider = new OutlineInlineProvider(client)
  subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(selector, provider),
    /* For the tests. VS Code shows ghost text only in a focused editor, which a test window
       running beside others is not; this asks the provider what it would show at a position
       of the active editor -- given, since the caret of an unfocused window lags behind. */
    vscode.commands.registerCommand('isabelle.skeletonProbe', async (line?: number, character?: number) => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return undefined
      const pos = line === undefined ? editor.selection.active
        : new vscode.Position(line, character ?? editor.document.lineAt(line).text.length)
      const cancel = new vscode.CancellationTokenSource()
      try {
        const items = await provider.provideInlineCompletionItems(editor.document, pos,
          { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined },
          cancel.token)
        const item = items?.[0]
        if (!item || !item.range) return undefined
        const r = item.range
        return {
          text: typeof item.insertText === 'string' ? item.insertText : item.insertText.value,
          range: [r.start.line, r.start.character, r.end.line, r.end.character],
        }
      } finally {
        cancel.dispose()
      }
    }))
}
