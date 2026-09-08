/* When to let a dead language server come back.
 *
 * The language client's own DefaultErrorHandler keeps the last five close timestamps and
 * gives up only when five of them land inside three minutes; otherwise it drops the oldest
 * and restarts. That rule assumes a restart is cheap, which is true for a server that
 * starts in a second and false for this one: the heap build happens inside `initialize`,
 * so a start against a missing or unbuildable image costs a full session build. Against
 * viper-roots that is about twenty minutes, so the three-minute window never closes and
 * the client restarts forever -- each attempt rebuilding, failing identically, and
 * queueing the next.
 *
 * That is not merely wasteful. Two of those builds overlapping is what produced
 *
 *   [SQLITE_CONSTRAINT_PRIMARYKEY] ... UNIQUE constraint failed:
 *   isabelle_sources.session_name, isabelle_sources.name
 *
 * because `Store.write_session_info` inserts a session's source rows outright, trusting
 * `clean_session_info` to have cleared them first. Two builders writing one session record
 * is outside what that assumes, and the loser aborts on the primary key.
 *
 * So the rule here is about *what failed*, not how fast:
 *
 *   - A start that never reached a running server will fail the same way next time -- the
 *     ROOT, the option or the proof that broke it has not changed in the interim. Report
 *     it and stop. This is the loop above.
 *   - A server that was healthy and then died is the case restarts exist for: a crashed
 *     prover, an OOM, a killed process. Restart, but bound it by count alone, since the
 *     elapsed-time reset is exactly what made the loop unbounded.
 *
 * Kept free of `vscode` imports so it can be tested without an extension host.
 */

/** How many times to bring back a server that had been running. */
export const MAX_RESTARTS = 4

export type CloseVerdict =
  | { restart: true }
  | { restart: false; message: string }

export interface CloseState {
  /** Whether `start()` ever resolved, i.e. the server got past `initialize`. */
  everRunning: boolean
  /** Closes seen for this client so far, not counting the one being judged. */
  restarts: number
  /** Session name, for a message that says which build to look at. */
  logic?: string
  maxRestarts?: number
}

export function closeVerdict(state: CloseState): CloseVerdict {
  const max = state.maxRestarts ?? MAX_RESTARTS

  if (!state.everRunning) {
    const which = state.logic ? ` for ${state.logic}` : ''
    return {
      restart: false,
      message:
        `The Isabelle server failed to start${which} and will not be restarted automatically, ` +
        `because a retry would repeat the session build that just failed. ` +
        `See the Isabelle output channel for the build error, then run ` +
        `"Isabelle: Restart Server" once the cause is fixed.`,
    }
  }

  if (state.restarts >= max) {
    return {
      restart: false,
      message:
        `The Isabelle server stopped ${max + 1} times and will not be restarted again. ` +
        `See the Isabelle output channel, then run "Isabelle: Restart Server".`,
    }
  }

  return { restart: true }
}
