/* Commands behind the Get Started walkthrough (contributes.walkthroughs in package.json).
 *
 * Registered before the Isabelle lookup in activate(), like the terminal: the walkthrough
 * is what someone without a working installation reads, so its buttons must not answer
 * "command not found" exactly when they are needed.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import { findIsabelleHome } from './isabelle'
import { registerSessionRoot } from './session_picker'
import { anchorPosition, TUTORIAL_FILE } from './tutorial'

export const WALKTHROUGH = 'gettingStarted'
/** Set once a distribution is found; the walkthrough's first step completes on it. */
export const HOME_FOUND = 'isabelle.homeFound'
export const EXTENDED_SERVER_ENABLED = 'isabelle.extendedServerEnabled'
const TUTORIAL_OPENED = 'isabelle.tutorialOpened'
/** Set on the first Sledgehammer run, from the walkthrough's button or the panel's. */
export const SLEDGEHAMMER_RAN = 'isabelle.sledgehammerRan'
const ISABELLE_FONT = "'Isabelle DejaVu Sans Mono', monospace"

export function setHomeFound(found: boolean): void {
  void vscode.commands.executeCommand('setContext', HOME_FOUND, found)
}

/** Re-emit the current setting so a walkthrough opened after activation sees it. */
export function refreshExtendedServer(): void {
  const enabled = vscode.workspace.getConfiguration('isabelle')
    .get<boolean>('extendedServer') === true
  void vscode.commands.executeCommand('setContext', EXTENDED_SERVER_ENABLED, false)
  if (enabled) {
    setTimeout(() => void vscode.commands.executeCommand(
      'setContext', EXTENDED_SERVER_ENABLED, true), 0)
  }
}

export function registerWalkthrough(
  context: vscode.ExtensionContext, report: (err: unknown) => void,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('isabelle.gettingStarted', async () => {
      await vscode.commands.executeCommand('workbench.action.openWalkthrough',
        `${context.extension.id}#${WALKTHROUGH}`, false)
      refreshExtendedServer()
    }),
    vscode.commands.registerCommand('isabelle.checkInstallation', () =>
      checkInstallation(context.extensionPath, report)),
    vscode.commands.registerCommand('isabelle.revealFonts', () => revealFonts(report)),
    vscode.commands.registerCommand('isabelle.useIsabelleFont', useIsabelleFont),
    vscode.commands.registerCommand('isabelle.openTutorial', (section?: string) =>
      openTutorial(context, section)),
    vscode.commands.registerCommand('isabelle.selectTutorialSession', async () => {
      await openTutorial(context, 'sessions')
      return vscode.commands.executeCommand('isabelle.selectSession')
    }),
  )
}

function ensureTutorial(context: vscode.ExtensionContext): string {
  const dir = path.join(context.globalStorageUri.fsPath, 'tutorial')
  const file = path.join(dir, TUTORIAL_FILE)
  fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(file)) {
    fs.copyFileSync(path.join(context.extensionPath, 'media', 'walkthrough', TUTORIAL_FILE), file)
  }
  const root = path.join(dir, 'ROOT')
  let oldTutorialSession = false
  try { oldTutorialSession = fs.readFileSync(root, 'utf8').includes('session Tutorial =') } catch { /* copy below */ }
  if (!fs.existsSync(root) || oldTutorialSession) {
    fs.copyFileSync(path.join(context.extensionPath, 'media', 'walkthrough', 'ROOT'), root)
  }
  registerSessionRoot(dir)
  return dir
}

function checkInstallation(extensionPath: string, report: (err: unknown) => void): void {
  let home: string
  try {
    home = findIsabelleHome()
  } catch (err) {
    setHomeFound(false)
    report(err)
    return
  }
  setHomeFound(true)
  let identifier = path.basename(home)
  try {
    identifier = fs.readFileSync(path.join(home, 'etc', 'ISABELLE_IDENTIFIER'), 'utf8').trim()
  } catch { /* a development checkout: the folder name is the best there is */ }
  /* The extended server is compiled against one release, so it is the jar that says
     which Isabelle this extension targets. */
  const extended = fs.existsSync(path.join(extensionPath, 'server', `${identifier}.jar`))
  void vscode.window.showInformationMessage(extended
    ? `Found ${identifier} at ${home}.`
    : `Found ${identifier} at ${home}. The extended server is not available for it; ` +
      'the extension is made for Isabelle2025-2.')
}

/** The newest contrib/isabelle_fonts-*\/ttf of the distribution, if it has one. */
function fontDirectory(home: string): string | undefined {
  const contrib = path.join(home, 'contrib')
  let names: string[]
  try { names = fs.readdirSync(contrib) } catch { return undefined }
  const found = names.filter(n => n.startsWith('isabelle_fonts')).sort()
    .map(n => path.join(contrib, n, 'ttf')).filter(d => fs.existsSync(d))
  return found.pop()
}

async function revealFonts(report: (err: unknown) => void): Promise<void> {
  let home: string
  try { home = findIsabelleHome() } catch (err) { report(err); return }
  const dir = fontDirectory(home)
  if (!dir) {
    void vscode.window.showWarningMessage(`${home} has no contrib/isabelle_fonts-*/ttf folder.`)
    return
  }
  // Revealing a file opens its folder with the file selected; the folder itself would
  // open its parent instead.
  const first = fs.readdirSync(dir).filter(n => n.endsWith('.ttf')).sort()[0]
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(first ? path.join(dir, first) : dir))
}

async function useIsabelleFont(): Promise<void> {
  // Language-scoped, so everything that is not a theory keeps the user's font.
  await vscode.workspace.getConfiguration('editor', { languageId: 'isabelle' })
    .update('fontFamily', ISABELLE_FONT, vscode.ConfigurationTarget.Global, true)
  void vscode.window.showInformationMessage(
    'Theories now use the Isabelle font. If you installed it just now, restart VS Code to load it.')
}

/**
 * Open the tutorial, a copy in global storage: the extension checks only file: documents,
 * and a copy of their own lets people edit freely. An existing copy is kept, edits and all.
 */
async function openTutorial(context: vscode.ExtensionContext, section?: string): Promise<void> {
  const dir = ensureTutorial(context)
  const file = path.join(dir, TUTORIAL_FILE)
  const uri = vscode.Uri.file(file)
  // Beside the walkthrough, which is an editor too; but into a tab that already shows it.
  const shown = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === uri.fsPath)
  const editor = await vscode.window.showTextDocument(uri,
    { viewColumn: shown?.viewColumn ?? vscode.ViewColumn.Beside, preview: false })
  void vscode.commands.executeCommand('setContext', TUTORIAL_OPENED, true)
  if (section === undefined) return
  const at = anchorPosition(editor.document.getText(), section)
  if (!at) return
  const position = new vscode.Position(at.line, at.character)
  editor.selection = new vscode.Selection(position, position)
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter)
}
