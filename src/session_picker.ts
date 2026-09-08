/* Choosing the session the language server boots with.
 *
 * The server's heap image is fixed for the life of the process: session_name and
 * session_requirements are constructor fields of Language_Server, read once in init(),
 * LSP `initialize` happens once per process, and shutdown() clears the session with no
 * path back. So changing session means restarting the server, which is what this does.
 *
 * Why it matters: an import already in the heap resolves to a nodeless name
 * (Resources.import_name) and is never re-checked; anything else becomes a live node and
 * is elaborated from source on every start. That is the whole of Isabelle's "caching" --
 * there is no on-disk cache of checked theories, here or in jEdit. Booting with the stock
 * default `-l HOL` therefore re-checks every theory in a project workspace, every start.
 *
 * Which session to pick is *not* "the one owning the file you have open". `-R S` bakes
 * S's whole import closure into an immutable heap, so if you later edit something down
 * there, your edit is checked in isolation while everything above keeps the stale copy.
 * The frontier has to sit below everything you intend to edit -- hence the recommendation
 * is the lowest session currently open, not the focused one. See sessions.ts.
 */

import * as vscode from 'vscode'
import { Session, readSessions, sessionDirsFor, stalenessWarning } from './sessions'
import { IconKind, PickItem, pickItems, openSessions, statusText, statusTooltip }
  from './session_items'

export { PickItem, IconKind, pickItems, openSessions, statusText, statusTooltip }
  from './session_items'

/**
 * Icon for a row.
 *
 * A gold star marks the recommended session, the pattern VS Code itself uses for a
 * preferred entry in a quick pick. The colour is `extensionIcon.starForeground`, the
 * theme colour defined for exactly this star, so it tracks the theme rather than being a
 * hardcoded yellow.
 *
 * Caveat worth knowing: the API documents ThemeIcon.color as "currently only used in
 * TreeItem" (vscode.d.ts), so a build that honours it only there will draw the star in
 * the default foreground. The star itself still renders, so the marker survives either
 * way -- only its colour is at the editor's discretion.
 */
export function icon(kind: IconKind): vscode.ThemeIcon {
  switch (kind) {
    case 'recommended':
      return new vscode.ThemeIcon(
        'star-full', new vscode.ThemeColor('extensionIcon.starForeground'))
    case 'current': return new vscode.ThemeIcon('check')
    case 'uncached': return new vscode.ThemeIcon('circle-slash')
    default: return new vscode.ThemeIcon('library')
  }
}

/** Attach real icons to the pure rows. */
export function withIcons(items: PickItem[]): PickItem[] {
  return items.map(i => ({ ...i, iconPath: icon(i.icon) }))
}

export function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)
}

export class SessionPicker {
  private readonly status: vscode.StatusBarItem
  private sessions: Session[] = []
  /* Files already warned about, so the prompt appears once per server run. */
  private warned = new Set<string>()

  constructor(private readonly log: (msg: string) => void) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
    this.status.command = 'isabelle.selectSession'
    this.refresh()
  }

  /** Re-scan ROOT files. Cheap enough to redo whenever it is asked for. */
  scan(): Session[] {
    const roots = workspaceRoots()
    this.sessions = readSessions(roots)
    this.log(`session scan: ${this.sessions.length} session(s) in ${roots.length} folder(s)`)
    return this.sessions
  }

  refresh(): void {
    const cfg = vscode.workspace.getConfiguration('isabelle')
    const logic = cfg.get<string>('logic')?.trim() || 'HOL'
    const requirements = cfg.get<boolean>('logicRequirements') === true
    this.status.text = statusText(logic, requirements)
    this.status.tooltip = statusTooltip(logic, requirements)
    this.status.show()
  }

  /**
   * Warn when an edit lands on a theory that is inside the current heap image.
   *
   * Fired on the first edit rather than on open: reading a heap theory is a normal thing
   * to do and warning about it would be noise. Editing one is the case with no other
   * signal -- the file checks as usual and only the results above it go stale.
   *
   * Once per file per server run. The condition cannot change without a restart, so
   * repeating it would be nagging about something the user has already answered.
   */
  async checkStaleEdit(file: string): Promise<void> {
    if (this.warned.has(file.toLowerCase())) return
    const cfg = vscode.workspace.getConfiguration('isabelle')
    const logic = cfg.get<string>('logic')?.trim() || 'HOL'
    const requirements = cfg.get<boolean>('logicRequirements') === true

    const stale = stalenessWarning(
      this.sessions.length > 0 ? this.sessions : this.scan(),
      file, logic, requirements, this.editingSessions())
    if (stale === undefined) return

    this.warned.add(file.toLowerCase())
    this.log(`stale edit: ${file} is in session ${stale.session}, inside image ${logic}`)
    const switchTo = `Switch to ${stale.suggested}`
    const answer = await vscode.window.showWarningMessage(
      stale.message, switchTo, 'Keep ' + logic)
    if (answer === switchTo) await this.apply(stale.suggested, true)
  }

  private editingSessions(): string[] {
    const files = vscode.workspace.textDocuments
      .filter(d => d.languageId === 'isabelle' || d.fileName.endsWith('.thy'))
      .map(d => d.fileName)
    return openSessions(this.sessions, files)
  }

  async pick(): Promise<void> {
    const sessions = this.scan()
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage(
        'No Isabelle ROOT files found in this workspace, so there are no project sessions ' +
        'to choose from. The server keeps using the configured logic image.')
      return
    }

    const cfg = vscode.workspace.getConfiguration('isabelle')
    const current = cfg.get<string>('logic')?.trim() || 'HOL'
    const chosen = await vscode.window.showQuickPick(
      withIcons(pickItems(sessions, this.editingSessions(), current)),
      {
        title: 'Isabelle session image',
        placeHolder: 'Imports of the chosen session load from a heap instead of being re-checked',
        matchOnDescription: true,
        matchOnDetail: true,
      })
    if (chosen?.session === undefined) return

    await this.apply(chosen.session, chosen.requirements)
  }

  async apply(logic: string, requirements: boolean): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('isabelle')
    /* A ROOT in the workspace is not automatically visible to Isabelle -- it must be a
       registered component, listed in a ROOTS catalogue, or passed with -d. Register the
       chosen session's own directory so every session the picker offers actually starts. */
    const existing = cfg.get<string[]>('sessionDirs') ?? []
    const dirs = sessionDirsFor(this.sessions, logic, existing)
    if (dirs.length !== existing.length) {
      await cfg.update('sessionDirs', dirs, vscode.ConfigurationTarget.Workspace)
    }
    /* Workspace rather than Global: which session to boot is a property of the project in
       front of you, unlike continuousChecking which is a property of how you work. */
    await cfg.update('logic', logic, vscode.ConfigurationTarget.Workspace)
    await cfg.update('logicRequirements', requirements, vscode.ConfigurationTarget.Workspace)
    // A new frontier makes every previous verdict obsolete, so ask again where it applies.
    this.warned.clear()
    this.refresh()
    await vscode.commands.executeCommand('isabelle.restartServer')
    /* Deliberately not predicting whether a heap build follows. `-R S` needs the image
       Sessions.background computes, a synthetic S_requirements(PARENT) whenever S imports
       beyond its parent, and nothing short of loading the whole session structure says
       whether that heap exists -- measured at ~20s per Isabelle invocation, which a
       picker cannot spend. The server reports its own build via build_started, which is
       the honest source. */
    void vscode.window.showInformationMessage(
      `Isabelle session: ${logic}. Restarting the server; if its heap image is missing ` +
      `it will be built first, which can take a while.`)
  }

  dispose(): void { this.status.dispose() }
}
