/* What the simplifier trace panel says, separated from how it says it.
 *
 * No vscode import, so the wording rules can be tested under plain node. They are worth
 * testing on their own: "the simplifier is waiting for you" and "nothing is tracing" look
 * identical on screen and mean opposite things, and getting the second wrong makes a
 * working feature read as broken.
 */

export interface TraceAnswer { name: string; label: string }

export interface TraceQuestion {
  serial: number
  text: string
  content: string
  answers: TraceAnswer[]
}

export interface TraceResponse {
  auto_update: boolean
  pending: number
  question?: TraceQuestion
}

export interface TraceEntry { serial: number; text: string; content: string }

/**
 * What the panel says about itself above the question.
 *
 * Kept separate from the rendering so the wording can be pinned down: "no question" and
 * "the prover is not tracing" look identical on screen but mean very different things,
 * and the second is the one users misread as the feature being broken.
 */
export function statusLine(state: TraceResponse | undefined): string {
  if (state === undefined) return 'Waiting for the prover.'
  if (state.question === undefined) {
    /* `interactive` is the load-bearing word and is easy to leave out: it is a separate
       flag in the attribute, defaulting to false, and without it the simplifier logs the
       trace instead of asking about it -- so the panel stays empty forever and looks
       broken. Naming the whole incantation is the entire point of this message. */
    return 'No simplifier question pending. Enable tracing in the theory with ' +
      'declare [[simp_trace_new interactive mode=full]] -- the "interactive" keyword is ' +
      'required, without it the trace only logs -- and put the caret in a proof that ' +
      'simplifies.'
  }
  const queued = state.pending - 1
  return queued > 0
    ? `Simplifier suspended. ${queued} further question${queued === 1 ? '' : 's'} queued.`
    : 'Simplifier suspended, waiting for an answer.'
}

/** Answers, in the order jEdit offers them, with the safe default first. */
export function answerButtons(question: TraceQuestion | undefined): TraceAnswer[] {
  return question?.answers ?? []
}
