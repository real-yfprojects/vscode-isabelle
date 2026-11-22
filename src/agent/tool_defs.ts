/*
 * The Isabelle tools for AI agents: names, descriptions and input schemas.
 *
 * Plain data without `vscode`, so that the stdio shim (mcp_stdio.ts), which runs outside
 * VS Code, can list the tools while no window is open; the handlers are in tools.ts.
 */

export interface ToolDef {
  name: string
  description: string
  inputSchema: object
}

/* `path`, not `file`: Claude Code's panel labels a running MCP call with its `path` (among
   a few names like it), and with nothing for a `file`. The handlers still read `file`. */
const thyPath = {
  type: 'string',
  description: 'The theory file (.thy), relative to a workspace folder or absolute. Prefer ' +
    'the relative path: the user\'s client shows it while the call runs.',
}
const line = {
  type: 'integer', minimum: 1,
  description: '1-based line, as in a file read.',
}
const column = {
  type: 'integer', minimum: 1,
  description: '1-based column. Default: the first non-blank character of the line. Needed ' +
    'only when several commands share a line, as in `lemma "P" by simp`.',
}
const goal = {
  type: 'string',
  description: 'A goal of your own instead of the one in the file. Inside a proof it is ' +
    'stated as `have <goal>` and sees the proof\'s fixed variables, assumptions and named ' +
    'facts; outside one as `lemma <goal>`, in the locale or context at that line. A plain ' +
    'proposition is quoted for you; pass `"A x" if "B x" for x` or `fixes x assumes "..." ' +
    'shows "..."` as they are.',
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'isabelle_check',
    description:
      'Check an Isabelle theory with the prover of the open VS Code window, which keeps the ' +
      'session image loaded and rechecks only what changed (seconds, not minutes). Waits ' +
      'until the theory is checked or the timeout passes, then returns its errors and ' +
      'warnings with 1-based lines, the goal each failing command worked on, and the counts ' +
      'of sorry and oops. A theory still being checked at the timeout comes back with the ' +
      'commands the prover is running: the same one on the next call is slow or stuck. It ' +
      'also comes back as soon as the same commands have run for 30 s with nothing else ' +
      'moving, since a proof method that does not end runs until it is edited. With ' +
      '`wait: false` it answers at once with how far the prover is, so that you can do ' +
      'other work and ask again later; isabelle_state, isabelle_try and the other tools ' +
      'work meanwhile, on the commands already checked. Call it after every edit of a ' +
      '.thy file. Never run `isabelle build` or `process_theories` instead.',
    inputSchema: {
      type: 'object',
      properties: {
        path: thyPath,
        timeout_s: { type: 'integer', minimum: 1, description: 'How long to wait at most. Default 120.' },
        wait: {
          type: 'boolean',
          description: 'Default true. false: do not wait for the prover; answer at once with ' +
            'its progress (percentage, the messages so far, the commands it runs), or with ' +
            'the result if the theory is checked already. Ignores timeout_s.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'isabelle_state',
    description:
      'The proof state at a line: the goals after the command there, the goals of the ' +
      'enclosing proof levels (the rest of the proof around a `have`), and the command\'s ' +
      'messages, as the infoview shows them.',
    inputSchema: {
      type: 'object',
      properties: { path: thyPath, line, column },
      required: ['path', 'line'],
    },
  },
  {
    name: 'isabelle_try',
    description:
      'Try several proof candidates at once on the goal at a line, without editing the ' +
      'file. The goal is the state before the command at `line` (the line of a `lemma`, ' +
      '`have` or `show` means its own goal), or your own `goal`. A candidate is Isar text: ' +
      '`by (induct xs) auto`, `apply simp`, a `proof ... qed` block, or a diagnostic command ' +
      'like `thm foo`, `term t`, `value t` or `find_theorems ...`. Each runs with its own ' +
      'timeout and reports proved, goals_left (with the goals), no_subgoals (finish with ' +
      '`done`), error (with the message), timeout, or output. A simplifier run that times ' +
      'out comes back with the rewrite rules it applied most and the cycle they repeat in. ' +
      'A candidate may outline a proof with `sorry`, as in `proof (induct xs) case Nil show ' +
      '?case sorry next ... qed`: it comes back proved_with_sorry with the goals of each ' +
      'sorry, the holes to fill in next, each with a handle of its own: a candidate `from` ' +
      'it is a proof in place of that sorry. Each candidate reports its time, and one of several ' +
      'steps its slowest steps: prefer the fastest proof that checks. ' +
      'A candidate that reaches a state comes back with a handle: pass it as `from`, instead ' +
      'of path and line, to go on from that state -- step by step through a proof, back to ' +
      'an earlier handle, or several ways from one -- and get the steps so far to write into ' +
      'the file. Goals left there come back also stated on their own, to give ' +
      'isabelle_sledgehammer as `goal`. ' +
      'Use it before writing a proof into the file, and to look up facts instead of ' +
      'guessing their names.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { ...thyPath, description: thyPath.description + ' Not needed with `from`.' },
        line: { ...line, description: line.description + ' Not needed with `from`.' },
        column, goal,
        from: {
          type: 'string',
          description: 'A handle from an earlier isabelle_try, like "h7": the candidates run on ' +
            'the state it stands for. With `goal`, the goal is stated in that state.',
        },
        candidates: {
          type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12,
          description: 'Isar texts to try, each on its own.',
        },
        timeout_s: { type: 'number', minimum: 0.1, description: 'Per candidate. Default 10.' },
        simp_stats: {
          type: 'boolean',
          description: 'Also count the rewrite rules the simplifier applies when the ' +
            'candidate does not time out. Slows it down.',
        },
        watch_rules: {
          type: 'array', items: { type: 'string' },
          description: 'Record each step of these rewrite rules (names like `foo_def` or ' +
            '`List.rev_rev_ident`): the instance, and for a conditional rule its premises, ' +
            'the rules applied to them, and whether the condition was proved or failed. ' +
            'Answers "why did this rule not fire". To see what simp makes of a premise, ' +
            'try it as a `goal` with `apply simp`.',
        },
        watch_patterns: {
          type: 'array', items: { type: 'string' },
          description: 'Record each rewrite step whose redex matches one of these term ' +
            'patterns, like `f (Suc _)` (best effort).',
        },
        watch_limit: { type: 'integer', minimum: 1, description: 'Steps recorded. Default 20.' },
      },
      required: ['candidates'],
    },
  },
  {
    name: 'isabelle_sledgehammer',
    description:
      'Run Sledgehammer on the goal at a line, or on your own `goal`, and return the ' +
      'one-line proofs it finds, each checked again before it is returned. It runs below ' +
      'the checking of the theory, so it does not hold up the user, and it goes on while ' +
      'the theory is edited: several calls may run at once. It also looks for a ' +
      'falsification: if it reports one, the goal is false as stated -- fix it instead.',
    inputSchema: {
      type: 'object',
      properties: {
        path: thyPath, line, column, goal,
        timeout_s: { type: 'integer', minimum: 1, description: 'Default 30.' },
      },
      required: ['path', 'line'],
    },
  },
  {
    name: 'isabelle_context',
    description:
      'What to know about the goal at a line, or of a handle, before proving it: the ' +
      'definitions of the constants in it, each with the fact to unfold or simp it by ' +
      '(`foo_def`, `foo.simps`, `foo.intros`); the variables and the facts of the proof ' +
      '(assumptions, `this`, named facts); and the facts Sledgehammer\'s relevance filter ' +
      'ranks highest for the first goal, with their statements. Use it instead of guessing ' +
      'which definitions to unfold or which lemmas apply.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { ...thyPath, description: thyPath.description + ' Not needed with `from`.' },
        line: { ...line, description: line.description + ' Not needed with `from`.' },
        column, goal,
        from: {
          type: 'string',
          description: 'A handle from isabelle_try, like "h7": the context of its state.',
        },
        relevant: {
          type: 'boolean',
          description: 'Default true. false: leave out the relevant facts, which take a few seconds.',
        },
        limit: { type: 'integer', minimum: 1, description: 'Relevant facts. Default 20.' },
      },
      required: [],
    },
  },
  {
    name: 'isabelle_profile',
    description:
      'Where a theory spends its time, for making it faster: the slowest lemmas, each with ' +
      'its slowest command, or with `by: "command"` the slowest commands. Waits until the ' +
      'theory is checked, as isabelle_check does. Counts the commands of proofs, which an ' +
      'agent can speed up; `kinds: "all"` counts imports, definitions and packages too. ' +
      'Leave out what you judged cannot be made faster with `exclude` (lemma names, or text ' +
      'of a command\'s first line), and check one lemma again after a change with `match`. ' +
      'What is left out is summed up at the end.',
    inputSchema: {
      type: 'object',
      properties: {
        path: thyPath,
        by: { type: 'string', enum: ['lemma', 'command'], description: 'Default "lemma".' },
        kinds: { type: 'string', enum: ['proofs', 'all'], description: 'Default "proofs".' },
        match: {
          type: 'array', items: { type: 'string' },
          description: 'Only these: lemma names (exact), or text in a command\'s first line.',
        },
        exclude: {
          type: 'array', items: { type: 'string' },
          description: 'Not these: lemma names (exact), or text in a command\'s first line.',
        },
        from_line: { type: 'integer', minimum: 1, description: 'First line to count (1-based).' },
        to_line: { type: 'integer', minimum: 1, description: 'Last line to count (1-based).' },
        limit: { type: 'integer', minimum: 1, description: 'Rows. Default 10.' },
        min_s: { type: 'number', minimum: 0, description: 'Leave out rows below this. Default 0.1.' },
        timeout_s: { type: 'integer', minimum: 1, description: 'How long to wait for the check. Default 120.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'isabelle_find_theorems',
    description:
      'Search the facts visible at a line of a theory, with Isabelle\'s find_theorems: ' +
      'term patterns in quotes (`"rev (rev _)"`, `"_ + _ = _ + _"`), `name: foo`, `intro`, ' +
      '`elim`, `dest`, `simp: "..."`, and `-` to exclude.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The find_theorems criteria.' },
        path: thyPath,
        line: { ...line, description: '1-based line whose context to search. Default: the end of the theory.' },
        limit: { type: 'integer', minimum: 1, description: 'Default 40.' },
      },
      required: ['query', 'path'],
    },
  },
]

/** What an MCP client is told when it connects: the guide in brief. */
export const SERVER_INSTRUCTIONS =
  'Isabelle theories in the open VS Code window. Theory files are ASCII: write symbols ' +
  'as \\<forall>, \\<Longrightarrow>, \\<open>...\\<close>, never as Unicode glyphs; tool ' +
  'output uses the same notation. After editing a .thy file, run isabelle_check. At an ' +
  'error, look at isabelle_state, try several candidates at once with isabelle_try, then ' +
  'isabelle_sledgehammer, and write only a proof that came back `proved`, the fastest one. ' +
  'Test an intermediate step or a helper lemma with `goal` before writing it. Outline a ' +
  'bigger proof as one candidate with `sorry` for its steps: the goals of the holes come ' +
  'back, each hole with a handle to fill it from. A candidate\'s result has a handle: go ' +
  'on from it with `from`, step by step. ' +
  'isabelle_context shows the definitions in a goal, the facts in scope and the relevant ' +
  'library facts; look facts up with it, isabelle_try ["thm name"] or ' +
  'isabelle_find_theorems instead of guessing names. isabelle_profile finds slow proofs. A ' +
  'simplifier loop shows as a timeout with its rule cycle: drop that rule with `simp del:`. ' +
  'A long check need not hold you up: isabelle_check with `wait: false` returns the ' +
  'progress at once, and the other tools work while the prover goes on.'

/** The answer of a tool when no VS Code window serves this folder. */
export const NO_WINDOW =
  'No VS Code window with the Isabelle extension serves this folder. Open the folder in ' +
  'VS Code with the extension installed and the setting isabelle.agents.enabled on ' +
  '(command "Isabelle: Set Up AI Agents"), then try again.'
