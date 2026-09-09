import * as vscode from 'vscode'
import { CloseAction, ErrorAction, ErrorHandler, LanguageClient, LanguageClientOptions, State }
  from 'vscode-languageclient/node'
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
import { QueryPanel } from './query_panel'
import { registerCaretUpdates, isApplyingCaretUpdate } from './caret'
import { TheoriesPanel } from './theories_panel'
import { SimplifierTracePanel } from './simplifier_trace_panel'
import { GraphviewPanel } from './graphview_panel'
import { registerOutline } from './outline'
import { registerSemanticTokens } from './semantic_tokens'
import { SessionPicker } from './session_picker'
import { stalenessWarning } from './sessions'
import { BuildProgress } from './build_progress'
import { closeVerdict } from './restart_policy'

const buildProgress = new BuildProgress()
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
let queryPanel: QueryPanel | undefined
let theoriesPanel: TheoriesPanel | undefined
let simplifierTrace: SimplifierTracePanel | undefined
let graphview: GraphviewPanel | undefined
let sessionPicker: SessionPicker | undefined
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
  // Do not echo a caret the server itself just asked us to move to.
  if (isApplyingCaretUpdate()) return
  if (!editor || editor.document.languageId !== 'isabelle') return
  const pos = editor.selection.active
  client.sendNotification('PIDE/caret_update', {
    uri: client.code2ProtocolConverter.asUri(editor.document.uri),
    line: pos.line,
    character: pos.character,
    focus: true,
  }).catch(err => output.appendLine(`caret_update failed: ${err}`))
}

/** Session named in settings, for the progress title. */
function logicLabel(): string {
  const cfg = vscode.workspace.getConfiguration('isabelle')
  const logic = cfg.get<string>('logic')?.trim() || 'HOL'
  return cfg.get<boolean>('logicRequirements') ? `${logic} (requirements)` : logic
}

async function startClient(): Promise<void> {
  lastError = undefined
  // Re-resolve on every start rather than reusing the value cached at activation:
  // otherwise changing isabelle.home and restarting the server silently keeps using
  // the old distribution.
  const home = findIsabelleHome()
  if (home !== isabelleHome) {
    if (isabelleHome !== undefined) log(`Isabelle home changed to ${home}, reloading symbols`)
    isabelleHome = home
    table = SymbolTable.load(home)
  }
  const serverOptions = buildServerOptions(home)
  log(`Launching: ${serverOptions.command} ${(serverOptions.args ?? []).join(' ')}`)

  /* Restart policy. Without an errorHandler the client uses its default, which gives up
     only when five closes land inside three minutes -- a window a ~20 minute heap build
     never fits into, so a server that cannot start is restarted forever, rebuilding each
     time. See restart_policy.ts; `everRunning` is what separates "this will fail again"
     from "the prover died and should come back". */
  let everRunning = false
  let closes = 0
  const errorHandler: ErrorHandler = {
    error: (_error, _message, count) => ({
      action: count !== undefined && count <= 3 ? ErrorAction.Continue : ErrorAction.Shutdown,
    }),
    closed: () => {
      const verdict = closeVerdict({ everRunning, restarts: closes, logic: logicLabel() })
      closes += 1
      if (verdict.restart) return { action: CloseAction.Restart }
      log(verdict.message)
      return { action: CloseAction.DoNotRestart, message: verdict.message }
    },
  }

  const clientOptions: LanguageClientOptions = {
    documentSelector: ISABELLE_SELECTOR as any,
    outputChannel: buildProgress.channel(output),
    errorHandler,
    middleware: {
      /* There is no API for "the user is holding Ctrl", but VS Code asks for a definition
         exactly when it is deciding whether to draw the Ctrl+hover link -- so this is
         where we learn that a glyph is being offered as clickable, and can underline it.
         The request is passed through untouched. */
      provideDefinition: async (document, position, token, next) => {
        const result = await next(document, position, token)
        // Only mark what is actually navigable: the editor draws its link the same way,
        // so underlining on the mere *request* would promise a jump that is not there.
        const found = Array.isArray(result) ? result.length > 0 : !!result
        renderer?.markLink(document, position, found)
        return result
      },
    },
  }

  client = new LanguageClient('isabelle', 'Isabelle/PIDE', serverOptions, clientOptions)
  /* The server builds its heap image inside `initialize`, so client.start() does not
     resolve until any build has finished -- which is why a first start with a missing
     image looks like a hang. Wrapping the start is therefore all it takes to cover the
     build, and buildProgress relays the server's own progress lines into the notification
     so it says which session and how far, not just "working". */
  try {
    await buildProgress.during(logicLabel(), () => (client as LanguageClient).start())
  } catch (err) {
    lastError = err instanceof Error ? (err.stack ?? err.message) : String(err)
    log(`client.start() threw: ${lastError}`)
    throw err
  }
  // Only now is a later close worth restarting: the server got past `initialize`, so its
  // heap image exists and coming back does not mean rebuilding it.
  everRunning = true
  log('Language server started.')

  pide = new PideDecorations(log)
  pide.register(clientScope, client)
  registerSemanticTokens(clientScope, ISABELLE_SELECTOR, pide)
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
  // Off by default: the PIDE/query_* messages exist only on the vscode-query-panel
  // branch of mirror-isabelle, so a stock distribution would show a dead view.
  if (vscode.workspace.getConfiguration('isabelle').get<boolean>('queryPanel', false)) {
    queryPanel = new QueryPanel(client, log)
    queryPanel.register(clientScope)
  }
  // Same reasoning as the Query panel: the PIDE/theories_* messages exist only on the
  // vscode-theories-panel branch, so the views stay hidden against a stock distribution
  // rather than showing two permanently empty trees.
  // Views live at extension scope (registered in activate); only the subscription is
  // per-client, so a restart that fails leaves the view present rather than provider-less.
  theoriesPanel?.bind(client, clientScope)
  /* Same reasoning as the Query panel: PIDE/simplifier_trace_* exists only on the
     vscode-simplifier-trace branch, so the view stays hidden against a stock
     distribution rather than sitting there permanently empty. */
  if (vscode.workspace.getConfiguration('isabelle').get<boolean>('simplifierTrace', false)) {
    simplifierTrace = new SimplifierTracePanel(client, log)
    simplifierTrace.register(clientScope)
  }
  if (vscode.workspace.getConfiguration('isabelle').get<boolean>('graphview', false)) {
    graphview = new GraphviewPanel(client, log)
    graphview.register(clientScope)
  }
  registerSpellChecker(clientScope, client, log)
  registerCaretUpdates(clientScope, client, log)

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
  queryPanel = undefined
  simplifierTrace = undefined
  graphview = undefined
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
  // Outline, breadcrumbs and folding: plain LSP features the server does not provide.
  registerOutline(context, ISABELLE_SELECTOR)

  /* The session image decides what is cached: imports already in the heap are never
     re-checked, everything else is elaborated from source on every start. The stock
     default is HOL, which caches nothing in a project workspace. */
  /* Same reasoning as the Query panel: the PIDE/theories_* messages exist only on the
     vscode-theories-panel branch, so the views stay hidden against a stock distribution
     rather than showing two permanently empty trees. */
  if (vscode.workspace.getConfiguration('isabelle').get<boolean>('theoriesPanel', false)) {
    theoriesPanel = new TheoriesPanel(log)
    theoriesPanel.registerViews(context.subscriptions)
  }

  sessionPicker = new SessionPicker(msg => output.appendLine(msg))
  context.subscriptions.push(sessionPicker)

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
        linked: r.linked.length,
        linkedGlyphs: r.linked.map(d => d.renderOptions?.before?.contentText).filter(Boolean),
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
    /* Test hook for the Ctrl+hover underline. The real trigger is the definition
       middleware, which needs a running server and a held modifier; this drives the same
       entry point directly so the decision can be asserted. */
    vscode.commands.registerCommand('isabelle.markLinkAt', (line: number, character: number) => {
      const editor = vscode.window.activeTextEditor
      if (!editor || !renderer) return false
      renderer.markLink(editor.document, new vscode.Position(line, character), true)
      return true
    }),
    vscode.commands.registerCommand('isabelle.statePanelId', () => statePanel?.id),
    vscode.commands.registerCommand('isabelle.outputPanelContent', () => outputPanel?.rawContent),
    vscode.commands.registerCommand('isabelle.statePanelContent', () => statePanel?.rawContent),
    vscode.commands.registerCommand('isabelle.jEditParityState', () => ({
      abbrevs: abbrevs.size,
      documentationEntries: docPanel?.entryCount ?? 0,
      previewColumns: previews?.openColumns ?? [],
      previewLabel: previews?.label ?? '',
      queryPanelEnabled: queryPanel !== undefined,
      querySupported: queryPanel?.serverSupported,
      theoriesSupported: theoriesPanel?.serverSupported ?? false,
      simplifierTraceSupported: simplifierTrace?.serverSupported ?? false,
      graphviewSupported: graphview?.serverSupported ?? false,
    })),
    vscode.commands.registerCommand('isabelle.selectSession', () => sessionPicker?.pick()),
    vscode.commands.registerCommand('isabelle.staleEditCheck', (file: string) => {
      const cfg = vscode.workspace.getConfiguration('isabelle')
      return stalenessWarning(sessionPicker?.scan() ?? [], file,
        cfg.get<string>('logic')?.trim() || 'HOL',
        cfg.get<boolean>('logicRequirements') === true)
    }),
    // Test hook: the picker's view of the workspace, without opening the quick pick.
    vscode.commands.registerCommand('isabelle.sessionState', () => {
      const sessions = sessionPicker?.scan() ?? []
      const cfg = vscode.workspace.getConfiguration('isabelle')
      return {
        sessions: sessions.map(s => s.name),
        logic: cfg.get<string>('logic'),
        requirements: cfg.get<boolean>('logicRequirements') === true,
      }
    }),
    vscode.commands.registerCommand('isabelle.toggleContinuousChecking', async () => {
      const cfg = vscode.workspace.getConfiguration('isabelle')
      const on = !cfg.get<boolean>('continuousChecking')
      // Global rather than workspace: the option is a property of how you like to work.
      await cfg.update('continuousChecking', on, vscode.ConfigurationTarget.Global)
      await vscode.commands.executeCommand('isabelle.restartServer')
      void vscode.window.showInformationMessage(
        `Isabelle continuous checking ${on ? 'on' : 'off'}; server restarted.`)
    }),
    vscode.commands.registerCommand('isabelle.queryState', () => queryPanel && ({
      supported: queryPanel.serverSupported,
      output: queryPanel.lastOutput,
      status: queryPanel.lastStatus,
    })),
    vscode.commands.registerCommand('isabelle.sledgehammerState', () => sledgehammer && ({
      provers: sledgehammer.proverList,
      status: sledgehammer.lastStatus,
      output: sledgehammer.lastOutput,
    })),
    /* Editing a theory that sits inside the heap image checks the file but changes
       nothing above it, and looks entirely normal while doing so. This is the only
       place that signal comes from. */
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.contentChanges.length === 0) return
      if (e.document.languageId !== 'isabelle' && !e.document.fileName.endsWith('.thy')) return
      void sessionPicker?.checkStaleEdit(e.document.fileName)
    }),
    vscode.window.onDidChangeTextEditorSelection(e => sendCaretUpdate(e.textEditor)),
    vscode.window.onDidChangeActiveTextEditor(editor => sendCaretUpdate(editor)),
  )

  /* Starting the server loads a heap image, which is the slowest thing this extension
     does. Plenty of what it offers -- symbol rendering, input, the outline, folding,
     Ctrl+T -- is client-side and needs no prover at all, so this is worth being able to
     decline: on a machine without Isabelle, when opening a theory only to read it, or in
     tests that assert none of the prover-backed behaviour. */
  if (vscode.workspace.getConfiguration('isabelle').get<boolean>('autoStart') === false) {
    log('isabelle.autoStart is off; run "Isabelle: Start / Restart Language Server" to connect')
    return
  }

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
