/* Presentation for the session picker: what the quick pick and status bar say.
 *
 * Split from session_picker.ts so it can be tested under plain node. The `vscode` import
 * here is type-only and is erased at compile time -- nothing in this file touches the
 * editor API at runtime, which is the property that keeps the suite cheap.
 */

import type * as vscode from 'vscode'
import { Session, depth, orderSessions, recommendedSession, sessionForFile } from './sessions'

/**
 * Which icon a row carries. A name rather than a ThemeIcon so this module stays free of
 * the vscode runtime -- session_picker.ts turns these into real icons. The star is the
 * recommendation marker, following the pattern VS Code uses for a preferred choice in a
 * quick pick.
 */
export type IconKind = 'recommended' | 'current' | 'session' | 'uncached'

export interface PickItem extends vscode.QuickPickItem {
  session?: string
  requirements: boolean
  icon: IconKind
}

/** Sessions owning any theory currently open in an editor. */
export function openSessions(sessions: Session[], files: string[]): string[] {
  const names = new Set<string>()
  for (const f of files) {
    const s = sessionForFile(sessions, f)
    if (s !== undefined) names.add(s.name)
  }
  return [...names]
}

/**
 * Build the quick-pick list.
 *
 * Kept pure so the ordering and the recommendation can be pinned down without a running
 * editor. The recommendation is the part most worth testing: choosing a frontier that is
 * too high fails silently rather than loudly.
 */
export function pickItems(
  sessions: Session[], editing: string[], current: string | undefined,
): PickItem[] {
  const ordered = orderSessions(sessions)
  const recommended = recommendedSession(sessions, editing)
  const items: PickItem[] = []

  for (const s of ordered) {
    const marks: string[] = []
    if (s.name === recommended) marks.push('recommended: lowest session you have open')
    else if (editing.includes(s.name)) marks.push('open in an editor')
    if (s.name === current) marks.push('current')

    /* The star outranks the check: which session is in force is already on the status
       bar and repeated in the detail, whereas the recommendation is the one thing the
       row is here to tell you. */
    const icon: IconKind =
      s.name === recommended ? 'recommended' : s.name === current ? 'current' : 'session'

    items.push({
      label: s.name,
      description: s.parent !== undefined ? `extends ${s.parent}` : 'base session',
      detail: marks.length > 0 ? marks.join(' · ') : undefined,
      session: s.name,
      requirements: true,
      icon,
      // Children below parents, so the list reads as the dependency order it is.
      alwaysShow: depth(sessions, s.name) === 0,
    })
  }

  /* Escape hatch. Someone reading only distribution theories wants the plain image, and
     it must stay reachable once a project session has been chosen. */
  items.push({
    label: 'HOL',
    description: 'distribution image only',
    detail: 'no project theory is cached; every theory you open is checked from source',
    session: 'HOL',
    requirements: false,
    icon: current === 'HOL' ? 'current' : 'uncached',
  })

  return items
}

export function statusText(logic: string, requirements: boolean): string {
  return `$(library) ${logic}${requirements ? '' : ' (uncached)'}`
}

export function statusTooltip(logic: string, requirements: boolean): string {
  return requirements
    ? `Isabelle session: ${logic}\n\nImports of ${logic} load from a heap image and are ` +
      `not re-checked. ${logic}'s own theories stay editable.\n\nClick to change.`
    : `Isabelle session: ${logic}\n\nNo project theories are cached -- every theory you ` +
      `open is checked from source on each start.\n\nClick to change.`
}
