/* Following the files of the running heap image for changes; see heap_files.ts.
 *
 * Two sources of change. Disk: a file-system watcher, which sees saves, checkouts and
 * other editors alike. Buffers: an unsaved edit to a heap theory already makes what you
 * see disagree with what the image holds, so open documents count with their text --
 * and undoing the edit clears it again.
 */

import * as vscode from 'vscode'
import { Baseline, Change, compare, digest, digestFile, fileKey, heapSourceFiles, takeBaseline }
  from './heap_files'
import { Session } from './sessions'

export interface StaleFile {
  file: string
  /** Relative to the workspace, for display. */
  label: string
  change: Change
}

/** Buffers are re-digested at most this often per file while typing. */
const TYPING_DELAY_MS = 300

export class HeapWatch {
  private baseline: Baseline | undefined
  private readonly stale = new Map<string, StaleFile>()
  private readonly pending = new Map<string, NodeJS.Timeout>()
  /* Bumped by every capture/clear, so a digest computed for an older baseline is dropped
     rather than recorded against the new one. */
  private generation = 0
  private readonly changed = new vscode.EventEmitter<StaleFile[]>()
  readonly onDidChange = this.changed.event

  constructor(
    private readonly sessions: () => Session[],
    private readonly log: (m: string) => void,
  ) {}

  register(disposables: vscode.Disposable[]): void {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{thy,ML,sml}')
    const onDisk = (uri: vscode.Uri) => this.schedule(uri.fsPath, 0)
    disposables.push(
      // First, so no timer outlives the extension.
      { dispose: () => this.reset() },
      this.changed,
      watcher,
      watcher.onDidChange(onDisk),
      watcher.onDidCreate(onDisk),
      watcher.onDidDelete(onDisk),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.scheme === 'file' && e.contentChanges.length > 0) {
          this.schedule(e.document.uri.fsPath, TYPING_DELAY_MS)
        }
      }),
      // Closing a dirty buffer without saving puts the disk version back in charge.
      vscode.workspace.onDidCloseTextDocument(d => {
        if (d.uri.scheme === 'file') this.schedule(d.uri.fsPath, 0)
      }),
    )
  }

  /**
   * Record what the image is being built from. Called as the server starts: its build
   * step reads the same files at about the same moment, and rebuilds if they changed.
   */
  async capture(logic: string, requirements: boolean): Promise<void> {
    const generation = this.reset()
    const files = heapSourceFiles(this.sessions(), logic, requirements)
    const baseline = await takeBaseline(files)
    if (generation !== this.generation) return
    this.baseline = baseline
    this.log(`heap image sources: ${baseline.files.size} workspace file(s) in ${logic}` +
      (requirements ? ' (requirements)' : ''))
    // Anything already edited in a buffer before the server came up.
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isDirty) this.schedule(doc.uri.fsPath, 0)
    }
    this.fire()
  }

  /** No server, so no image to be stale against. */
  clear(): void {
    this.reset()
    this.fire()
  }

  get files(): StaleFile[] {
    return [...this.stale.values()].sort((a, b) => a.label.localeCompare(b.label))
  }

  get watchedCount(): number { return this.baseline?.files.size ?? 0 }

  private reset(): number {
    for (const t of this.pending.values()) clearTimeout(t)
    this.pending.clear()
    this.baseline = undefined
    this.stale.clear()
    return ++this.generation
  }

  private schedule(file: string, delay: number): void {
    const baseline = this.baseline
    if (baseline === undefined || !baseline.files.has(fileKey(file))) return
    const key = fileKey(file)
    const previous = this.pending.get(key)
    if (previous !== undefined) clearTimeout(previous)
    const generation = this.generation
    this.pending.set(key, setTimeout(() => {
      this.pending.delete(key)
      void this.recheck(file, generation)
    }, delay))
  }

  private async recheck(file: string, generation: number): Promise<void> {
    const baseline = this.baseline
    if (baseline === undefined) return
    const key = fileKey(file)
    const doc = vscode.workspace.textDocuments.find(
      d => d.uri.scheme === 'file' && fileKey(d.uri.fsPath) === key)
    /* A clean buffer is the disk file, and reading the disk avoids comparing across a
       line-ending conversion the editor may have made. */
    const unsaved = doc !== undefined && doc.isDirty
    const current = unsaved ? digest(doc.getText()) : await digestFile(file)
    if (generation !== this.generation) return

    const change = compare(baseline, file, current, unsaved)
    const before = this.stale.get(key)?.change
    if (change === undefined) this.stale.delete(key)
    else this.stale.set(key, { file, label: vscode.workspace.asRelativePath(file), change })
    if (before !== change) {
      if (change !== undefined) this.log(`heap image stale: ${file} ${change}`)
      this.fire()
    }
  }

  private fire(): void { this.changed.fire(this.files) }
}
