import * as cp from 'child_process'
import * as path from 'path'
import * as vscode from 'vscode'
import { CloseAction, ErrorAction, ErrorHandler, LanguageClient, LanguageClientOptions,
  ServerOptions, State } from 'vscode-languageclient/node'
import { isRunning, killTree } from './process_tree'
import { buildServerOptions, checkWholeTheory, extendedServer, findIsabelleHome,
  IsabelleNotFound, serverArguments, stageExtendedJar } from './isabelle'
import { caretPerspective, checkingExtent } from './status_items'
import { SymbolTable } from './symbols'
import { SymbolRenderer } from './decorations'
import { AbbrevStore, dropDuplicateSymbols, registerAbbreviations } from './abbrev'
import { registerNormalizer } from './normalize'
import { registerAtomicMotion } from './atomic'
import { PideDecorations } from './pide_decorations'
import { Infoview } from './infoview'
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
import { IsabelleStatus } from './status_bar'
import { HeapWatch } from './heap_watch'
import { stalenessWarning } from './sessions'
import { BuildProgress } from './build_progress'
import { registerTerminal } from './terminal'
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
/* The server process, held here because the language client will not hand it back: with
   the function form of ServerOptions it never records the child at all, and even the
   Executable form only ever kills the process it spawned, which is the outer Cygwin bash
   rather than the JVM below it. See process_tree.ts. */
let serverProcess: cp.ChildProcess | undefined
let serverOwnsGroup = false
let pide: PideDecorations | undefined
let infoview: Infoview | undefined
let sledgehammer: SledgehammerPanel | undefined
let docPanel: DocumentationPanel | undefined
let previews: PreviewPanels | undefined
let queryPanel: QueryPanel | undefined
let theoriesPanel: TheoriesPanel | undefined
let simplifierTrace: SimplifierTracePanel | undefined
let graphview: GraphviewPanel | undefined
let sessionPicker: SessionPicker | undefined
let status: IsabelleStatus | undefined
let heapWatch: HeapWatch | undefined
let extensionPath = ''
let globalStoragePath = ''
let extendedJar: string | undefined
let runningJar: string | undefined
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

/**
 * How long the prover gets to stop on its own before the tree is killed.
 *
 * The client's own default is 2s, which is short for a session that has to bring down a
 * Poly/ML process. Overrunning this is not a disaster -- an interactive session writes no
 * build results, so there is nothing half-written to lose -- but it is worth waiting for.
 */
const SHUTDOWN_TIMEOUT_MS = 5000

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
  const extended = extendedServer(home, extensionPath)
  extendedJar = extended.kind === 'on' ? extended.jar : undefined
  // The server runs a copy, so rebuilding or updating the jar cannot break it; see there.
  const stagedJar = extended.kind === 'on'
    ? stageExtendedJar(extended.jar, path.join(globalStoragePath, 'server'))
    : undefined
  runningJar = stagedJar
  if (stagedJar) log(`Extended server: ${extended.kind === 'on' ? extended.jar : ''}, running ${stagedJar}`)
  if (extended.kind === 'unavailable') {
    log(`Extended server unavailable: ${extended.reason}`)
    void vscode.window.showWarningMessage(
      `Isabelle: ${extended.reason} Starting the standard language server instead.`)
  }
  const executable = buildServerOptions(home, process.platform, stagedJar)
  log(`Launching: ${executable.command} ${(executable.args ?? []).join(' ')}`)
  status?.setLaunchArgs(executable.args ?? [])

  /* Spawn the server ourselves rather than handing the client an Executable, for the one
     reason that we need its pid: the process to kill is a tree, and neither the client's
     `checkProcessDied` nor closing the pipe brings the prover down (process_tree.ts).
     Everything else the Executable form does -- pipe stdio, relay stderr to the output
     channel -- the client still does with a ChildProcess, minus the "server process
     exited" line, which is re-added below so a crash still says so. */
  serverOwnsGroup = executable.options?.detached === true
  const serverOptions: ServerOptions = async () => {
    /* The client restarts itself on CloseAction.Restart without going through
       stopClient(), so this is the only place that sees the previous server. Usually it
       is already dead -- its connection closing is what triggered the restart -- but a
       connection can also close over a live process, and nothing else would ever come
       back for that one. */
    const previous = serverProcess
    serverProcess = undefined
    if (previous?.pid !== undefined && isRunning(previous.pid)) {
      log(`previous server ${previous.pid} outlived its connection; killing its tree`)
      await killTree(previous.pid, { ownGroup: serverOwnsGroup, log })
    }
    const child = cp.spawn(executable.command, executable.args ?? [], executable.options)
    // A failed spawn reports asynchronously, so an unhandled 'error' would take the
    // extension host down with it; pid is the synchronous half of the same news.
    child.on('error', err => log(`server process error: ${err}`))
    if (child.pid === undefined) {
      throw new Error(`Launching the Isabelle server using ${executable.command} failed.`)
    }
    child.on('exit', (code, signal) => {
      if (code !== null) log(`Server process exited with code ${code}.`)
      if (signal !== null) log(`Server process exited with signal ${signal}.`)
    })
    serverProcess = child
    return child
  }

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
      status?.setServer('failed', verdict.message)
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
      provideCompletionItem: async (document, position, context, token, next) =>
        dropDuplicateSymbols(document, await next(document, position, context, token)),
    },
  }

  client = new LanguageClient('isabelle', 'Isabelle/PIDE', serverOptions, clientOptions)
  /* Registered before start() so the client's own restarts (CloseAction.Restart) show
     too; those never pass through stopClient/startClient. A close that gives up has
     already said 'failed' in errorHandler.closed, and the Stopped after it must not
     overwrite that with a plain 'off'. */
  clientScope.push(client.onDidChangeState(e => {
    if (e.newState === State.Starting) {
      status?.setServer('starting')
      /* Every start, including the client's own restarts: each one runs the server's
         build check, so each is a fresh image to compare against. */
      const cfg = vscode.workspace.getConfiguration('isabelle')
      void heapWatch?.capture(cfg.get<string>('logic')?.trim() || 'HOL',
        cfg.get<boolean>('logicRequirements') === true)
    } else if (e.newState === State.Running) status?.setServer('running')
    else {
      status?.setProgress(undefined)
      heapWatch?.clear()
      if (status?.phase !== 'failed') status?.setServer('off')
    }
  }))
  status?.setServer('starting')
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
  status?.setServer('running')
  log('Language server started.')

  pide = new PideDecorations(log)
  pide.register(clientScope, client)
  registerSemanticTokens(clientScope, ISABELLE_SELECTOR, pide)
  /* Asks the server whether it speaks PIDE/infoview_* whenever the extended server is
     configured; it may still be the stock one, if the jar does not fit the distribution. */
  infoview = new Infoview(client, log,
    vscode.workspace.getConfiguration('isabelle').get<boolean>('extendedServer', false))
  infoview.register(clientScope)
  sledgehammer = new SledgehammerPanel(client, log)
  sledgehammer.register(clientScope)
  docPanel = new DocumentationPanel(client, log)
  docPanel.register(clientScope)
  previews = new PreviewPanels(client, log)
  previews.register(clientScope)
  // Off by default: the PIDE/query_* messages exist only on the vscode-query-panel
  // branch of mirror-isabelle, so a stock distribution would show a dead view.
  if (panelEnabled('queryPanel')) {
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
  if (panelEnabled('simplifierTrace')) {
    simplifierTrace = new SimplifierTracePanel(client, log)
    simplifierTrace.register(clientScope)
  }
  if (panelEnabled('graphview')) {
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

/**
 * The panels marked experimental need messages only the extended server answers, so
 * turning that on shows them all; each keeps its own setting for a server patched by
 * other means.
 */
function panelEnabled(setting: string): boolean {
  const cfg = vscode.workspace.getConfiguration('isabelle')
  return cfg.get<boolean>(setting, false) || cfg.get<boolean>('extendedServer', false)
}

async function stopClient(): Promise<void> {
  for (const d of clientScope.splice(0)) {
    try { d.dispose() } catch { /* a provider may already be gone */ }
  }
  pide = undefined
  infoview = undefined
  sledgehammer = undefined
  docPanel = undefined
  previews = undefined
  queryPanel = undefined
  simplifierTrace = undefined
  graphview = undefined
  status?.setProgress(undefined)
  status?.setServer('off')
  heapWatch?.clear()
  const c = client
  client = undefined
  const proc = serverProcess
  serverProcess = undefined
  if (c) {
    try { await c.stop(SHUTDOWN_TIMEOUT_MS) } catch (err) {
      output.appendLine(`stop failed: ${err}`)
    }
  }
  /* `shutdown` + `exit` is what *should* end the server, and when it does this finds
     nothing to do. When it does not -- a wedged prover, a shutdown that outran the
     timeout, a client that never got as far as a handshake -- the process is still there
     with the JVM below it, and killing the tree is the only thing that ends it. */
  if (proc?.pid !== undefined && isRunning(proc.pid)) {
    await killTree(proc.pid, { ownGroup: serverOwnsGroup, log })
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Isabelle')
  context.subscriptions.push(output)
  /* First, so that a missing Isabelle installation shows on it too. */
  status = new IsabelleStatus()
  context.subscriptions.push(status,
    vscode.commands.registerCommand('isabelle.showOutput', () => output.show(true)),
    // Test hook: what the status bar item currently says.
    vscode.commands.registerCommand('isabelle.statusBarState', () => status?.snapshot()))
  /* Build lines only mean a build while the server is still coming up; the same line
     shapes ("Session ...") can turn up in the log of a running server. */
  buildProgress.onMessage = message => {
    const phase = status?.phase
    if (phase === 'starting' || phase === 'building') status?.setServer('building', message)
  }
  extensionPath = context.extensionPath
  globalStoragePath = context.globalStorageUri.fsPath

  /* The server is chosen at launch and the Theories views are registered at activation,
     so a reload is the one step that applies this setting everywhere. */
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
    if (!e.affectsConfiguration('isabelle.extendedServer')) return
    const choice = await vscode.window.showInformationMessage(
      'Reload the window to switch the Isabelle language server.', 'Reload Window')
    if (choice) await vscode.commands.executeCommand('workbench.action.reloadWindow')
  }))

  // Before the lookup below, so that a missing distribution is reported, not a missing command.
  registerTerminal(context, reportStartupFailure)

  try {
    isabelleHome = findIsabelleHome()
    log(`Isabelle home: ${isabelleHome}`)
  } catch (err) {
    serverFailed(err)
    return
  }

  // Symbol rendering and input work without the language server, so set them up first.
  table = SymbolTable.load(isabelleHome)
  log(`Loaded ${table.entries.length} symbols from etc/symbols ` +
      `(${table.entries.filter(e => e.glyph).length} with a codepoint, ` +
      `${table.entries.filter(e => e.isControl).length} control).`)

  renderer = new SymbolRenderer(table)
  renderer.register(context)
  registerAbbreviations(context, table, ISABELLE_SELECTOR, abbrevs,
    () => client?.state === State.Running, log)
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
  if (panelEnabled('theoriesPanel')) {
    theoriesPanel = new TheoriesPanel(log)
    theoriesPanel.registerViews(context.subscriptions)
    context.subscriptions.push(theoriesPanel.onDidChange(r => status?.setProgress(r)))
  }

  sessionPicker = new SessionPicker(msg => output.appendLine(msg))
  heapWatch = new HeapWatch(() => sessionPicker?.scan() ?? [], log)
  heapWatch.register(context.subscriptions)
  context.subscriptions.push(heapWatch.onDidChange(files => status?.setStale(files)))

  context.subscriptions.push(
    vscode.commands.registerCommand('isabelle.restartServer', async () => {
      await stopClient()
      try { await startClient() } catch (err) { serverFailed(err) }
    }),
    vscode.commands.registerCommand('isabelle.toggleSymbolRendering', () => {
      const on = renderer?.toggle()
      void vscode.window.showInformationMessage(`Isabelle symbol rendering ${on ? 'on' : 'off'}.`)
    }),
    vscode.commands.registerCommand('isabelle.serverState', () => ({
      state: client ? State[client.state] : 'none',
      lastError,
      isabelleHome,
      extendedJar,
      runningJar,
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
    vscode.commands.registerCommand('isabelle.showStaleFiles', showStaleFiles),
    // Test hooks: the heap image's workspace files and which of them changed, and taking
    // the baseline a server start would take, without a prover.
    vscode.commands.registerCommand('isabelle.heapWatchState', () => ({
      watched: heapWatch?.watchedCount ?? 0,
      stale: heapWatch?.files ?? [],
    })),
    vscode.commands.registerCommand('isabelle.heapWatchCapture',
      (logic: string, requirements: boolean) => heapWatch?.capture(logic, requirements)),
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
    vscode.commands.registerCommand('isabelle.toggleWholeTheoryChecking', toggleWholeTheory),
    // The old name, for keybindings made before the rename; no longer in the palette.
    vscode.commands.registerCommand('isabelle.toggleContinuousChecking', toggleWholeTheory),
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
  status.enableControls()

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
    serverFailed(err)
  }
}

async function toggleWholeTheory(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('isabelle')
  const on = !checkWholeTheory(cfg)
  /* Global by default: the option is a property of how you like to work. But a value
     already set for the workspace would shadow a global one and the toggle would do
     nothing, so write where the setting already lives. */
  const target = cfg.inspect<boolean>('checkWholeTheory')?.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global
  await cfg.update('checkWholeTheory', on, target)
  await vscode.commands.executeCommand('isabelle.restartServer')
  // From the arguments, which also see a vscode_caret_perspective set in serverOptions.
  void vscode.window.showInformationMessage(
    `Isabelle now checks ${checkingExtent(caretPerspective(serverArguments()))}; ` +
    'server restarted.')
}

/**
 * Open one changed heap file, or pick from all of them. The status bar tooltip links
 * here with the file as argument, which keeps its trusted-command list to our own.
 */
async function showStaleFiles(file?: string): Promise<void> {
  if (file !== undefined) {
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false })
    return
  }
  const files = heapWatch?.files ?? []
  if (files.length === 0) {
    void vscode.window.showInformationMessage(
      'No file built into the Isabelle heap image has changed since the server started.')
    return
  }
  const chosen = await vscode.window.showQuickPick(
    files.map(f => ({ label: f.label, description: f.change, file: f.file })),
    { title: 'Changed since the heap image was built', matchOnDescription: true })
  if (chosen) await vscode.window.showTextDocument(vscode.Uri.file(chosen.file), { preview: false })
}

/**
 * The server could not start. Separate from reportStartupFailure, which the terminal also
 * uses: a terminal that cannot find Isabelle says nothing about a server already running.
 */
function serverFailed(err: unknown): void {
  status?.setServer('failed', err instanceof Error ? err.message : String(err))
  heapWatch?.clear()
  reportStartupFailure(err)
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
