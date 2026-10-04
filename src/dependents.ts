/*
 * References in theories nobody has checked yet.
 *
 * The server finds references in the markup of the theories it has loaded -- the open ones
 * and what they import -- and a theory that only *imports* the one being edited has no
 * markup at all until the prover has been through it. So this asks the server which of the
 * project's theories may refer to the entity at the caret (PIDE/dependents: those that
 * import where it is bound and spell its name), has the prover check them
 * (PIDE/check_theories, asked again until all are done), and then lets the ordinary
 * reference search run over the lot. A rename has to see the same theories, or it would
 * break the ones it misses, so the checking is a function of its own.
 */
import * as vscode from 'vscode'
import { LanguageClient, ParameterStructures, RequestType, State } from 'vscode-languageclient/node'

/** What PIDE/dependents answers: the entity's names, and the files to check. */
export interface Dependents {
  names: string[]
  /** unloaded theories that may refer to the entity */
  theories: string[]
  /** theories of the session image that spell a name: never checked again, not searched */
  in_image: string[]
}

interface TheoryStatus {
  uri: string
  status: 'pending' | 'checked' | 'failed'
  percentage: number
}

export interface CheckedDependents extends Dependents {
  /** theories the prover could not check completely: their references may be missing */
  failed: string[]
}

const POLL_MS = 500

/* By name: a request given an undefined token would otherwise go out with its parameters
   in an array, which the server does not read. */
const DependentsRequest = new RequestType<object, Dependents, void>(
  'PIDE/dependents', ParameterStructures.byName)
const CheckTheoriesRequest = new RequestType<object, { theories: TheoryStatus[] }, void>(
  'PIDE/check_theories', ParameterStructures.byName)

/**
 * Whether the server answers PIDE/dependents. Both came with references on the extended
 * server, and a stock server leaves a request it does not know unanswered for good, so its
 * references capability is what to go by.
 */
export function supportsDependents(client: LanguageClient | undefined): boolean {
  return !!client && client.state === State.Running &&
    !!client.initializeResult?.capabilities.referencesProvider
}

/**
 * Have the prover check every project theory that may refer to the entity at `position`.
 * Resolves once all of them are checked (or failed), or with undefined when cancelled. The
 * theories stay loaded either way, and required, as if ticked in jEdit's Theories panel: an
 * edit to what they import checks them again.
 */
export async function checkDependentTheories(
  client: LanguageClient,
  uri: vscode.Uri,
  position: vscode.Position,
  report?: (checked: number, total: number, names: string[]) => void,
  token?: vscode.CancellationToken,
): Promise<CheckedDependents | undefined> {
  const asUri = (u: vscode.Uri) => client.code2ProtocolConverter.asUri(u)
  const files = (await vscode.workspace.findFiles('**/*.thy')).map(asUri)
  const dependents = await client.sendRequest(DependentsRequest, {
    textDocument: { uri: asUri(uri) },
    position: { line: position.line, character: position.character },
    files,
  }, token)
  if (dependents.theories.length === 0) return { ...dependents, failed: [] }

  for (;;) {
    if (token?.isCancellationRequested) return undefined
    const { theories } = await client.sendRequest(CheckTheoriesRequest,
      { files: dependents.theories })
    const done = theories.filter(t => t.status !== 'pending')
    report?.(done.length, theories.length, dependents.names)
    if (done.length === theories.length) {
      return { ...dependents, failed: theories.filter(t => t.status === 'failed').map(t => t.uri) }
    }
    await new Promise(r => setTimeout(r, POLL_MS))
  }
}

const fileName = (uri: string) => vscode.Uri.parse(uri).path.split('/').pop() ?? uri

/** Find All References, after checking the theories that may hold more of them. */
async function findReferencesInDependents(
  getClient: () => LanguageClient | undefined,
  log: (m: string) => void,
): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.document.languageId !== 'isabelle') return
  const client = getClient()
  if (!client || !supportsDependents(client)) {
    void vscode.window.showWarningMessage(client?.state === State.Running
      ? 'Finding references in dependent theories needs the extended server ' +
        '(setting isabelle.extendedServer).'
      : 'The Isabelle server is not running.')
    return
  }
  const { document, selection } = editor
  const result = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Isabelle',
    cancellable: true,
  }, (progress, token) => {
    let last = 0
    return checkDependentTheories(client, document.uri, selection.active, (checked, total, names) => {
      progress.report({
        message: `checking theories that may use ${names.join(', ')}: ${checked} of ${total}`,
        increment: (checked - last) / total * 100,
      })
      last = checked
    }, token)
  })
  if (!result) return
  if (result.names.length === 0) {
    void vscode.window.showInformationMessage('There is no name at the cursor.')
    return
  }
  log(`dependents of ${result.names.join(', ')}: ${result.theories.map(fileName).join(', ') || 'none'}` +
    (result.in_image.length ? `; in the session image: ${result.in_image.map(fileName).join(', ')}` : ''))

  const notes: string[] = []
  if (result.failed.length) {
    notes.push(`${result.failed.map(fileName).join(', ')} could not be checked completely, ` +
      'so references there may be missing.')
  }
  if (result.in_image.length) {
    notes.push(`${result.in_image.map(fileName).join(', ')} ` +
      `${result.in_image.length === 1 ? 'is' : 'are'} in the session image and not searched.`)
  }
  if (notes.length) void vscode.window.showWarningMessage(notes.join(' '))

  /* The references view, as Find All References opens it; the editor's own peek where
     that built-in extension is disabled. */
  try { await vscode.commands.executeCommand('references-view.findReferences') }
  catch { await vscode.commands.executeCommand('editor.action.referenceSearch.trigger') }
}

export function registerDependents(
  scope: vscode.Disposable[],
  getClient: () => LanguageClient | undefined,
  log: (m: string) => void,
): void {
  scope.push(
    vscode.commands.registerCommand('isabelle.findReferencesInDependents',
      () => findReferencesInDependents(getClient, log)),
    /* Without UI, for a rename and for the tests: the result, or undefined when the server
       cannot answer. */
    vscode.commands.registerCommand('isabelle.checkDependentTheories',
      async (uri: vscode.Uri, position: vscode.Position) => {
        const client = getClient()
        return client && supportsDependents(client)
          ? checkDependentTheories(client, uri, position) : undefined
      }),
  )
}
