/* A progress notification for server startup, including the heap build.
 *
 * The server builds its image inside the LSP `initialize` handler
 * (Language_Server.init calls build_session before replying), so client.start() does not
 * resolve until the build has finished. A first start against a missing image is
 * therefore minutes of silence with nothing on screen -- which is exactly what it looked
 * like after switching session.
 *
 * The build is not reported over a structured channel: Channel.progress writes through
 * log_writeln/log_warning, i.e. `window/logMessage`, which the language client appends to
 * its output channel. There is no build-progress notification to subscribe to. So the way
 * to see it is to sit in the path it already takes -- hence `channel`, which wraps the
 * real output channel, forwards everything unchanged, and relays interesting lines to
 * whatever notification is currently open.
 */

import * as vscode from 'vscode'

/**
 * Lines worth putting in front of someone. Isabelle's build output is mostly per-theory
 * chatter; these are the ones that say what is happening and roughly how far along it is.
 */
export function buildLine(text: string): string | undefined {
  const line = text.trim()
  if (line.length === 0) return undefined
  // "Build started for Isabelle/MainResults_requirements(ViperAbstract) ..."
  const started = /^Build started for (?:Isabelle\/)?(.+?)\s*\.{0,3}$/.exec(line)
  if (started) return `building ${started[1]}`
  // Isabelle's own progress lines for a session build.
  if (/^(Running|Finished|Building|Session) /.test(line)) return line
  if (/^Timing /.test(line)) return undefined
  return undefined
}

export class BuildProgress {
  private report: ((message: string) => void) | undefined

  /**
   * Wrap an output channel so server log lines also reach the open notification.
   *
   * Everything is forwarded verbatim: the output channel stays the complete record, and
   * this only ever adds a second reader.
   */
  channel(inner: vscode.OutputChannel): vscode.OutputChannel {
    const relay = (text: string): void => {
      const message = buildLine(text)
      if (message !== undefined) this.report?.(message)
    }
    return {
      get name() { return inner.name },
      append: (v: string) => { relay(v); inner.append(v) },
      appendLine: (v: string) => { relay(v); inner.appendLine(v) },
      replace: (v: string) => { relay(v); inner.replace(v) },
      clear: () => inner.clear(),
      show: (...args: unknown[]) => (inner.show as (...a: unknown[]) => void)(...args),
      hide: () => inner.hide(),
      dispose: () => inner.dispose(),
    } as vscode.OutputChannel
  }

  /**
   * Run `task` under a progress notification titled for `logic`.
   *
   * Not cancellable: stopping a heap build midway leaves the image absent, which is the
   * state we were already in, but the language client has no way to abandon an in-flight
   * initialize cleanly. Better to let it finish than to offer a button that half-works.
   */
  async during<T>(logic: string, task: () => Thenable<T>): Promise<T> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Isabelle: starting ${logic}`,
        cancellable: false,
      },
      async progress => {
        progress.report({ message: 'building the session image if it is missing' })
        this.report = message => progress.report({ message })
        try { return await task() }
        finally { this.report = undefined }
      })
  }
}
