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

/**
 * One item of the full trace, as PIDE/simplifier_trace_full sends it.
 *
 * `kind` is the markup without its simp_trace_ prefix: `recurse` (a simplifier
 * invocation), `step` (a rewrite the prover asked about), `log` (a rewrite recorded
 * without asking), `hint` (a step's outcome, `success` saying which) and `ignore` (a
 * failed step being redone). `content` is rendered HTML; `plain` the same as one-line
 * text, for summaries and search.
 */
export interface TraceEntry {
  serial: number
  parent?: number
  kind?: string
  text: string
  content: string
  plain?: string
  success?: boolean
}

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
       broken. Naming the whole incantation is the entire point of this message.
       Either form has to precede the simp call it is meant to catch: declare sets a
       context option that only affects commands after it in the theory text, and using
       attaches the option only to the one proof step it is written on.

       Breakpoints come first because the default mode=normal asks *only* at them
       (Simplifier_Trace.mk_generic_result: `Normal => triggered`). mode=full asks at every
       rewrite, which on a real simpset is hundreds of questions about rules nobody
       suspected -- the way to lose track of the one that matters. */
    return 'No simplifier question pending. Trace a simp call with ' +
      '`using [[simp_trace_new interactive]]` on it, or ' +
      '`declare [[simp_trace_new interactive]]` before it, and put the caret in that proof. ' +
      'It then stops only at breakpoints: mark a rule with `declare my_rule [simp_break]` ' +
      'or a term shape with `using [[simp_break "pattern"]]`. Add `mode=full` to stop at ' +
      'every rewrite instead. The "interactive" keyword is required -- without it the ' +
      'trace only logs. "Show trace tree" lists what was rewritten either way.'
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
