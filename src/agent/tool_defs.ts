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

const file = {
  type: 'string',
  description: 'The theory file (.thy): an absolute path, or one relative to a workspace folder.',
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
      'of sorry and oops. Call it after every edit of a .thy file. Never run `isabelle ' +
      'build` or `process_theories` instead.',
    inputSchema: {
      type: 'object',
      properties: {
        file,
        timeout_s: { type: 'integer', minimum: 1, description: 'How long to wait. Default 300.' },
      },
      required: ['file'],
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
      properties: { file, line, column },
      required: ['file', 'line'],
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
      'Use it before writing a proof into the file, and to look up facts instead of ' +
      'guessing their names.',
    inputSchema: {
      type: 'object',
      properties: {
        file, line, column, goal,
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
      required: ['file', 'line', 'candidates'],
    },
  },
  {
    name: 'isabelle_sledgehammer',
    description:
      'Run Sledgehammer on the goal at a line, or on your own `goal`, and return the ' +
      'one-line proofs it finds, each checked again before it is returned. It runs below ' +
      'the checking of the theory, so it does not hold up the user.',
    inputSchema: {
      type: 'object',
      properties: {
        file, line, column, goal,
        timeout_s: { type: 'integer', minimum: 1, description: 'Default 30.' },
      },
      required: ['file', 'line'],
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
        file,
        line: { ...line, description: '1-based line whose context to search. Default: the end of the theory.' },
        limit: { type: 'integer', minimum: 1, description: 'Default 40.' },
      },
      required: ['query', 'file'],
    },
  },
]

/** What an MCP client is told when it connects: the guide in brief. */
export const SERVER_INSTRUCTIONS =
  'Isabelle theories in the open VS Code window. Theory files are ASCII: write symbols ' +
  'as \\<forall>, \\<Longrightarrow>, \\<open>...\\<close>, never as Unicode glyphs; tool ' +
  'output uses the same notation. After editing a .thy file, run isabelle_check. At an ' +
  'error, look at isabelle_state, try several candidates at once with isabelle_try, then ' +
  'isabelle_sledgehammer, and write only a proof that came back `proved`. Test an ' +
  'intermediate step or a helper lemma with `goal` before writing it. Look up facts with ' +
  'isabelle_try ["thm name"] or isabelle_find_theorems instead of guessing names. A ' +
  'simplifier loop shows as a timeout with its rule cycle: drop that rule with `simp del:`.'

/** The answer of a tool when no VS Code window serves this folder. */
export const NO_WINDOW =
  'No VS Code window with the Isabelle extension serves this folder. Open the folder in ' +
  'VS Code with the extension installed and the setting isabelle.agents.enabled on ' +
  '(command "Isabelle: Set Up AI Agents"), then try again.'
