import * as vscode from 'vscode'
import { LanguageClient, LanguageClientOptions, State } from 'vscode-languageclient/node'
import { buildServerOptions, findIsabelleHome, IsabelleNotFound } from './isabelle'
import { SymbolTable } from './symbols'
import { SymbolRenderer } from './decorations'
import { AbbrevStore, registerAbbreviations } from './abbrev'
import { registerNormalizer } from './normalize'
import { registerAtomicMotion } from './atomic'
import { PideDecorations } from './pide_decorations'
import { OutputPanel, StatePanel } from './panels'
import { SymbolsPanel } from './symbols_panel'
import { SledgehammerPanel } from './sledgehammer_panel'
import { registerSpellChecker } from './spell_checker'
import { DocumentationPanel } from './doc_panel'
import { PreviewPanels } from './preview_panel'

let client: LanguageClient | undefined
let output: vscode.OutputChannel
let isabelleHome: string | undefined
let table: SymbolTable | undefined
let renderer: SymbolRenderer | undefined
let lastError: string | undefined
/* Panels and PIDE decorations subscribe to a specific LanguageClient, so their
   registrations live and die with it rather than with the extension. */
let clientScope: vscode.Disposable[] = []
let pide: PideDecorations | undefined
let statePanel: StatePanel | undefined
let outputPanel: OutputPanel | undefined
let sledgehammer: SledgehammerPanel | undefined
let docPanel: DocumentationPanel | undefined
let previews: PreviewPanels | undefined
const abbrevs = new AbbrevStore()

export const ISABELLE_SELECTOR: vscode.DocumentSelector =
  [{ scheme: 'file', language: 'isabelle' }]

/** Output channels are not readable from tests, so mirror to stdout of the host process. */
function log(message: string): void {
  output.appendLine(message)
  console.log('[isabelle] ' + message)
}

/**
 * PIDE only *processes* the part of a theory inside the caret perspective
 * (see the vscode_caret_perspective option, default 50 lines around the caret).
 * Without these notifications the server accepts didOpen and then reports nothing
 * at all, which looks exactly like a broken language server.
 */
function sendCaretUpdate(editor: vscode.TextEditor | undefined): void {
  if (!client || client.state !== State.Running) return
  if (!editor || editor.document.languageId !== 'isabelle') return
  const pos = editor.selection.active
  client.sendNotification('PIDE/caret_update', {
    uri: client.code2ProtocolConverter.asUri(editor.document.uri),
    line: pos.line,
    character: pos.character,
    focus: true,
  }).catch(err => output.appendLine(`caret_update failed: ${err}`))
}

async function startClient(): Promise<void> {
  lastError = undefined
  const home = isabelleHome ?? findIsabelleHome()
  const serverOptions = buildServerOptions(home)
  log(`Launching: ${serverOptions.command} ${(serverOptions.args ?? []).join(' ')}`)

  const clientOptions: LanguageClientOptions = {
    documentSelector: ISABELLE_SELECTOR as any,
    outputChannel: output,
  }

  client = new LanguageClient('isabelle', 'Isabelle/PIDE', serverOptions, clientOptions)
  try {
    await client.start()
  } catch (err) {
    lastError = err instanceof Error ? (err.stack ?? err.message) : String(err)
    log(`client.start() threw: ${lastError}`)
    throw err
  }
  log('Language server started.')

  pide = new PideDecorations(log)
  pide.register(clientScope, client)
  outputPanel = new OutputPanel()
  outputPanel.register(clientScope, client)
  statePanel = new StatePanel(client, log)
  statePanel.register(clientScope)
  sledgehammer = new SledgehammerPanel(client, log)
  sledgehammer.register(clientScope)
  docPanel = new DocumentationPanel(client, log)
  docPanel.register(clientScope)
  previews = new PreviewPanels(client, log)
  previews.register(clientScope)
  registerSpellChecker(clientScope, client, log)

  // Session abbreviations complement the static ones in etc/symbols.
  clientScope.push(client.onNotification('PIDE/abbrevs_response',
    (p: { abbrevs: [string, string][] }) => {
      abbrevs.set(p.abbrevs)
      log(`session abbreviations: ${abbrevs.size}`)
    }))
  void client.sendNotification('PIDE/abbrevs_request', {})

  sendCaretUpdate(vscode.window.activeTextEditor)
}

async function stopClient(): Promise<void> {
  for (const d of clientScope.splice(0)) {
    try { d.dispose() } catch { /* a provider may already be gone */ }
  }
  pide = undefined
  statePanel = undefined
  outputPanel = undefined
  sledgehammer = undefined
  docPanel = undefined
  previews = undefined
  const c = client
  client = undefined
  if (c) {
    try { await c.stop() } catch (err) { output.appendLine(`stop failed: ${err}`) }
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Isabelle')
  context.subscriptions.push(output)

  try {
    isabelleHome = findIsabelleHome()
    log(`Isabelle home: ${isabelleHome}`)
  } catch (err) {
    reportStartupFailure(err)
    return
  }

  // Symbol rendering and input work without the language server, so set them up first.
  table = SymbolTable.load(isabelleHome)
  log(`Loaded ${table.entries.length} symbols from etc/symbols ` +
      `(${table.entries.filter(e => e.glyph).length} with a codepoint, ` +
      `${table.entries.filter(e => e.isControl).length} control).`)

  renderer = new SymbolRenderer(table)
  renderer.register(context)
  registerAbbreviations(context, table, ISABELLE_SELECTOR, abbrevs)
  registerNormalizer(context, table, log)
  registerAtomicMotion(context, table)
  new SymbolsPanel(table).register(context.subscriptions)

  context.subscriptions.push(
    vscode.commands.registerCommand('isabelle.restartServer', async () => {
      await stopClient()
      try { await startClient() } catch (err) { reportStartupFailure(err) }
    }),
    vscode.commands.registerCommand('isabelle.toggleSymbolRendering', () => {
      const on = renderer?.toggle()
      void vscode.window.showInformationMessage(`Isabelle symbol rendering ${on ? 'on' : 'off'}.`)
    }),
    vscode.commands.registerCommand('isabelle.serverState', () => ({
      state: client ? State[client.state] : 'none',
      lastError,
      isabelleHome,
      symbols: table?.entries.length ?? 0,
    })),
    // Test hook: what the renderer would decorate in the active editor right now.
    vscode.commands.registerCommand('isabelle.decorationRanges', () => {
      const editor = vscode.window.activeTextEditor
      if (!editor || !renderer) return undefined
      const r = renderer.computeRanges(editor)
      return {
        hidden: r.hidden.length,
        withGlyph: r.hidden.filter(d => !!d.renderOptions?.before?.contentText).length,
        sub: r.sub.length,
        sup: r.sup.length,
        bold: r.bold.length,
        glyphs: r.hidden.map(d => d.renderOptions?.before?.contentText).filter(Boolean).slice(0, 12),
      }
    }),
    // Test hooks for the PIDE panels.
    vscode.commands.registerCommand('isabelle.pideDecorationSummary', () => {
      const editor = vscode.window.activeTextEditor
      return editor && pide ? pide.summary(editor.document.uri) : undefined
    }),
    vscode.commands.registerCommand('isabelle.statePanelId', () => statePanel?.id),
    vscode.commands.registerCommand('isabelle.outputPanelContent', () => outputPanel?.rawContent),
    vscode.commands.registerCommand('isabelle.statePanelContent', () => statePanel?.rawContent),
    vscode.commands.registerCommand('isabelle.jEditParityState', () => ({
      abbrevs: abbrevs.size,
      documentationEntries: docPanel?.entryCount ?? 0,
      previewColumns: previews?.openColumns ?? [],
      previewLabel: previews?.label ?? '',
    })),
    vscode.commands.registerCommand('isabelle.sledgehammerState', () => sledgehammer && ({
      provers: sledgehammer.proverList,
      status: sledgehammer.lastStatus,
      output: sledgehammer.lastOutput,
    })),
    vscode.window.onDidChangeTextEditorSelection(e => sendCaretUpdate(e.textEditor)),
    vscode.window.onDidChangeActiveTextEditor(editor => sendCaretUpdate(editor)),
  )

  try {
    await startClient()
  } catch (err) {
    reportStartupFailure(err)
  }
}

function reportStartupFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  log(`Startup failed: ${message}`)
  if (err instanceof IsabelleNotFound) {
    void vscode.window.showErrorMessage(message, 'Open Settings').then(choice => {
      if (choice === 'Open Settings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'isabelle.home')
      }
    })
  } else {
    void vscode.window.showErrorMessage(`Isabelle language server failed to start: ${message}`)
  }
}

export async function deactivate(): Promise<void> {
  await stopClient()
}
