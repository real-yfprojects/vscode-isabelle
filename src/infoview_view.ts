/* The infoview's page body, from its model.
 *
 * No vscode import, so what the view shows in each state is testable under plain node
 * (suite44). Goals and messages are server HTML and go in as markup, as in every panel
 * here (see panelHtml); everything else -- file names, command text -- is text out of a
 * theory and is escaped.
 */

import { escapeAttr, escapeHtml } from './graphview_panel_view'

export type CommandStatus = 'unprocessed' | 'running' | 'finished' | 'failed'

/** The goals of a level around the command, as the command that last printed them left
    them. Only the extended server sends these. */
export interface OuterGoals {
  /** 0-based. */
  line: number
  command: string
  source: string
  /** Server HTML. */
  goals: string
}

/** One place the view shows: the command at the caret, or a pinned one. */
export interface InfoSection {
  /** Pins only. */
  id?: number
  uri?: string
  /** 0-based. */
  line?: number
  /** The command's keyword, like `apply`. */
  command?: string
  /** Its first line. */
  source?: string
  status?: CommandStatus
  /** Server HTML. Absent when the server cannot tell goals apart (a stock pin shows only
      its proof state, as `goals`, and says nothing of messages). */
  goals?: string
  /** The goals of each enclosing level, innermost first: Isabelle prints only the
      innermost goal, so inside `have` or `show` these are the rest of the proof. */
  outer?: OuterGoals[]
  messages?: string
  /** The pin's theory is closed or its command is gone; the content is the last seen. */
  stale?: boolean
}

export type InfoviewMode = 'waiting' | 'extended' | 'stock'

export interface InfoviewModel {
  mode: InfoviewMode
  live?: InfoSection
  pins: InfoSection[]
  paused: boolean
  /** The live section has changed while paused. */
  pending: boolean
}

export function fileLabel(uri: string | undefined): string {
  if (!uri) return ''
  const path = decodeURIComponent(uri.replace(/^file:\/*/, ''))
  return path.split(/[\\/]/).pop() ?? path
}

export function locationLabel(section: InfoSection): string {
  const file = fileLabel(section.uri)
  return section.line === undefined ? file : `${file}:${section.line + 1}`
}

function button(command: string, label: string, title: string, arg?: string | number): string {
  const argAttr = arg === undefined ? '' : ` data-arg="${escapeAttr(String(arg))}"`
  return `<button class="action" data-command="${command}"${argAttr} title="${escapeAttr(title)}">` +
    `${escapeHtml(label)}</button>`
}

function block(key: string, title: string, html: string): string {
  return `<details open data-key="${escapeAttr(key)}"><summary>${escapeHtml(title)}</summary>` +
    `<div class="output">${html}</div></details>`
}

/* What a section says when there is nothing to show, which depends on why: a command
   still waiting for the prover is not the same as one that printed nothing. */
function emptyText(section: InfoSection): string {
  switch (section.status) {
    case 'unprocessed': return 'Not checked yet.'
    case 'running': return 'Running…'
    default: return 'No output.'
  }
}

/* Below the command's own goals, one entry per enclosing level, so all open goals are in
   view with the current one on top. Each says where it was printed, and goes there. */
function outerGoals(section: InfoSection): string {
  return (section.outer ?? []).map(level => {
    const where = section.uri ? `${section.uri}#${level.line}` : ''
    return `<div class="outer">` +
      `<div class="outer-head">Enclosing` +
      (where ? ` <a class="location" data-command="revealLine" data-arg="${escapeAttr(where)}" ` +
        `title="Go to the command">line ${level.line + 1}</a>` : '') +
      (level.source ? ` <span class="cmdtext">${escapeHtml(level.source)}</span>` : '') +
      `</div>${level.goals}</div>`
  }).join('')
}

function sectionBody(section: InfoSection, key: string): string {
  const parts: string[] = []
  const outer = outerGoals(section)
  if (section.goals || outer) parts.push(block(`${key}:goals`, 'Goals', (section.goals ?? '') + outer))
  if (section.messages) parts.push(block(`${key}:messages`, 'Messages', section.messages))
  if (parts.length === 0) parts.push(`<div class="empty">${escapeHtml(emptyText(section))}</div>`)
  return parts.join('')
}

function header(section: InfoSection, where: string, actions: string[]): string {
  const location = locationLabel(section)
  const status = section.status && section.status !== 'finished'
    ? `<span class="status ${section.status}">${section.status}</span>` : ''
  const stale = section.stale ? '<span class="status stale" title="The pinned command is gone; this is what it showed last">stale</span>' : ''
  return `<header>` +
    `<span class="where">${escapeHtml(where)}</span>` +
    (location
      ? `<a class="location" data-command="reveal" data-arg="${escapeAttr(String(section.id ?? 'live'))}" ` +
        `title="Go to the command">${escapeHtml(location)}</a>` : '') +
    (section.source ? `<span class="cmdtext">${escapeHtml(section.source)}</span>` : '') +
    status + stale +
    `<span class="actions">${actions.join('')}</span>` +
    `</header>`
}

function liveSection(model: InfoviewModel): string {
  const actions = [
    button('pin', 'Pin', 'Pin the command at the cursor, to keep its state in view'),
    button('togglePause', model.paused ? 'Resume' : 'Pause',
      model.paused ? 'Follow the cursor again' : 'Stop following the cursor'),
  ]
  const live = model.live
  const where = model.paused ? (model.pending ? 'Paused (changed)' : 'Paused') : 'At cursor'
  const body = live
    ? sectionBody(live, 'live')
    : `<div class="empty">${model.mode === 'waiting' ? 'Waiting for Isabelle…' : 'No command at the cursor.'}</div>`
  return `<section class="live${model.paused ? ' paused' : ''}">` +
    header(live ?? {}, where, actions) + body + `</section>`
}

function pinSection(pin: InfoSection): string {
  const actions = [button('unpin', 'Unpin', 'Remove this pin', pin.id)]
  return `<section class="pin${pin.stale ? ' stale' : ''}">` +
    header(pin, 'Pinned', actions) + sectionBody(pin, `pin${pin.id}`) + `</section>`
}

/** The page body. The live section comes first, so it stays put as pins come and go. */
export function infoviewBody(model: InfoviewModel): string {
  const pins = model.pins.map(pinSection).join('')
  const unpinAll = model.pins.length > 1
    ? `<div class="pins-footer">${button('unpinAll', 'Unpin all', 'Remove every pin')}</div>` : ''
  return liveSection(model) + pins + unpinAll
}

export const INFOVIEW_CSS = `
  section { margin: 0 0 10px 0; }
  section.pin { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); padding-top: 6px; }
  section.stale .output { opacity: .6; }
  header { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; margin-bottom: 4px;
           font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  header .where { font-weight: 600; }
  header .location { border-bottom: none; color: var(--vscode-textLink-foreground); }
  header .location:hover { text-decoration: underline; }
  header .cmdtext { opacity: .75; font-family: 'Isabelle DejaVu Sans Mono', var(--vscode-editor-font-family), monospace;
                   overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40ch; }
  header .status { font-size: .85em; padding: 0 4px; border-radius: 2px;
                   background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  header .status.failed { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); }
  header .status.stale { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-foreground); }
  header .actions { margin-left: auto; display: flex; gap: 4px; }
  button.action { font-family: var(--vscode-font-family); font-size: 12px; padding: 1px 8px; cursor: pointer;
                  border: none; border-radius: 2px;
                  color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.action:hover { background: var(--vscode-button-secondaryHoverBackground); }
  section.paused header .where { color: var(--vscode-editorWarning-foreground); }
  details { margin: 2px 0 6px 0; }
  summary { cursor: pointer; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); opacity: .8; }
  .output { margin: 2px 0 0 0; }
  .empty { opacity: .6; font-family: var(--vscode-font-family); }
  .pins-footer { text-align: right; }
  .outer { margin-top: 6px; padding-top: 4px; border-top: 1px dashed var(--vscode-panel-border, rgba(128,128,128,.35)); }
  .outer > .source { opacity: .75; }
  .outer-head { font-family: var(--vscode-font-family); font-size: .9em; opacity: .7; margin-bottom: 2px;
                display: flex; gap: 6px; align-items: baseline; }
  .outer-head .location { border-bottom: none; color: var(--vscode-textLink-foreground); }
  .outer-head .cmdtext { font-family: 'Isabelle DejaVu Sans Mono', var(--vscode-editor-font-family), monospace;
                         overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40ch; }
`
