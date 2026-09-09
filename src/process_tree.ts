/* Killing a language server that will not die on its own.
 *
 * `shutdown` + `exit` is how the server is supposed to end, and when it works none of
 * this runs. It does not always work, and the failure is expensive: what the extension
 * spawns on Windows is Cygwin's bash, with a second bash, the JVM and Poly/ML below it,
 * so a server that does not end leaves multiple gigabytes behind. Two such stacks, four
 * and eight hours old, are what made a later launch fail outright -- Cygwin could no
 * longer create the process tree, and `bash.exe` exited 1 within three seconds without
 * ever forking bin/isabelle, which reads in the client log as the unhelpful
 *
 *   [Error] Server process exited with code 1.
 *
 * Two things can leave the prover running, and neither is reachable from the server side:
 *
 *   - A released Isabelle. Until the fix on mirror-isabelle, the main loop in
 *     language_server.scala answered EOF with nothing but a log line and returned, so the
 *     session -- and the JVM holding it -- outlived every client that died rather than
 *     closing. `processId` from `initialize` is ignored too. On a stock distribution
 *     closing the pipe is simply not a way to stop this server.
 *   - A prover that will not stop. `session.stop()` is what has to return, and an EOF
 *     handler does not help if the read loop is not what is stuck.
 *
 * Killing the *tree* rather than the process is the part that is easy to get wrong:
 * ending only our own child re-parents the JVM and produces exactly the orphan being
 * prevented. That is also why the language client's own `checkProcessDied` -- which
 * terminates the process it spawned, i.e. the outer bash -- is not enough.
 *
 * Kept free of `vscode` imports so it can be tested without an extension host.
 */

import { spawn } from 'child_process'

/** How long a signalled process group gets before it is killed outright. */
export const GRACE_MS = 2000

/**
 * The Windows recipe for killing a process and everything beneath it.
 *
 * `/T` is the whole point: it walks the live descendants, which is how the JVM two bash
 * levels down is reached. POSIX has no equivalent command -- there the server is spawned
 * into its own process group and the group is signalled instead -- so this returns
 * undefined and `killTree` takes the other branch.
 */
export function killTreeCommand(
  pid: number, platform: NodeJS.Platform = process.platform,
): string[] | undefined {
  if (platform !== 'win32') return undefined
  return ['taskkill', '/PID', String(pid), '/T', '/F']
}

/**
 * Whether a pid is still around.
 *
 * Signal 0 performs the permission and existence checks without delivering anything.
 * EPERM means the process exists but is not ours to signal, which for our purposes is
 * still "running" -- reporting it dead would make a caller conclude a kill succeeded.
 */
export function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface KillTreeOptions {
  platform?: NodeJS.Platform
  /**
   * Whether the process leads its own process group, i.e. was spawned `detached` on
   * POSIX. Passed rather than assumed: `process.kill(-pid)` against a process that is
   * *not* a group leader signals whatever group it happens to be in, which for a child
   * of the extension host is the extension host's own.
   */
  ownGroup?: boolean
  log?: (message: string) => void
}

/** Wait, but only while there is still something to wait for. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Kill `pid` and every process below it, returning once it is gone (or once we have run
 * out of ways to ask).
 *
 * Resolves rather than throwing when the process is already dead: every caller here is
 * cleaning up, and "it was not running" is the outcome they wanted.
 */
export async function killTree(pid: number, options: KillTreeOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform
  const log = options.log ?? (() => { /* silent by default */ })
  if (!isRunning(pid)) return

  const command = killTreeCommand(pid, platform)
  if (command) {
    log(`killing server process tree ${pid} with ${command.join(' ')}`)
    await new Promise<void>(resolve => {
      const killer = spawn(command[0], command.slice(1), { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => resolve())
      killer.on('exit', () => resolve())
    })
    return
  }

  // POSIX: signal the group if we know there is one, otherwise the process alone. TERM
  // first so a well-behaved child can still run its own cleanup, KILL if it does not.
  const target = options.ownGroup ? -pid : pid
  log(`killing server process ${options.ownGroup ? 'group ' : ''}${pid}`)
  try { process.kill(target, 'SIGTERM') } catch { /* already gone */ }
  await delay(GRACE_MS)
  if (!isRunning(pid)) return
  try { process.kill(target, 'SIGKILL') } catch { /* already gone */ }
}
