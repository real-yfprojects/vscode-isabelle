# AI agents: Claude Code, GitHub Copilot and other MCP clients

The extension can give AI agents access to the prover of your VS Code window, as
[MCP](https://modelcontextprotocol.io) tools. An agent can then check a theory, read the
goals at a line, try proofs and run Sledgehammer, all without starting a prover of its
own.

This matters because of how agents check proofs otherwise. Without these tools they run
`isabelle build` or `isabelle process_theories`, and each such run starts a new prover and
loads the session image again. That takes a minute or more per check, and the `poly`
processes of an interrupted run keep using the CPU. The window's prover already has the
image loaded and checks only what changed, so the same check takes seconds.

## Setting it up

1. Turn on the extended server (**Isabelle: Extended Server** in the settings). The tools
   need it.
2. Open your project folder and run **Isabelle: Set Up AI Agents**. It turns on
   `isabelle.agents.enabled` and offers to write:
   - `.mcp.json`, with an `isabelle` server for **Claude Code**. That server is a small
     relay script that connects Claude Code, whether it runs in the VS Code panel or in a
     terminal, to the window that has the project open.
   - `.claude/skills/isabelle/SKILL.md`, a short guide for Claude: the ASCII notation of
     theory files, the order to use the tools in, and common pitfalls.
   - A section in `.github/copilot-instructions.md` with the same guide for **Copilot**.

   An existing `.mcp.json` keeps its other servers; files that exist are never
   overwritten without asking.
3. Start a new Claude Code session in the project folder. Claude Code asks once whether
   to use the servers of the project's `.mcp.json`; approve `isabelle`. `/mcp` then
   lists it as connected. In Copilot's agent mode, the tools appear in the tools picker under
   *Isabelle* without any file, as long as the setting is on (VS Code 1.101 or newer).

The window has to stay open: the tools use its prover. If the language server hasn't
started yet, because no theory is open, the first tool call starts it.

## The tools

All lines are 1-based, as in a file read. Goals and messages are in the ASCII notation of
theory files (`\<forall>`, `\<Longrightarrow>`), so an agent can copy them into a file
as they are. Goals and candidates that an agent passes with Unicode glyphs are converted
to that notation.

| Tool | What it does |
|---|---|
| `isabelle_check` | Checks a theory and returns its errors and warnings. Each error comes with the goal the failing command worked on. Also reports the counts of `sorry` and `oops`, and lines with literal Unicode. The theory doesn't have to be open in an editor. |
| `isabelle_state` | The goals at a line, the goals of the enclosing proof levels, and the messages there, as the infoview shows them. |
| `isabelle_try` | Tries up to 12 proof candidates at once on the goal at a line, without editing the file. Candidates can be `by ...`, `apply ...`, a `proof ... qed` block, or `thm`, `term`, `value` and `find_theorems`. Each candidate reports `proved`, `goals_left`, `no_subgoals`, `error`, `timeout` or `output`. |
| `isabelle_sledgehammer` | Runs Sledgehammer and returns the proofs it found, after checking each one again. |
| `isabelle_find_theorems` | `find_theorems` in the context of a line. |

### Goals of the agent's own

`isabelle_try` and `isabelle_sledgehammer` take an optional `goal`, so an agent can try out
a step before writing it into the file:

- **Inside a proof**, the goal is stated as `have <goal>`. It sees the proof's fixed
  variables, its assumptions and its named facts. Use it to test an intermediate step or
  a case split.
- **Outside a proof**, the goal is stated as `lemma <goal>`, in the locale or context at
  that line. Use it to try a helper lemma.

A plain proposition is quoted automatically. Structured statements such as
`"A x" if "B x" for x` or `fixes x assumes "..." shows "..."` are passed on as they are.

### The simplifier

The full simplifier trace is far too long for an agent to read, so `isabelle_try` reports
a summary of it instead:

- **When a candidate times out**, it is traced again for up to 5 s. The result lists the
  rewrite rules applied most, and the cycle of rules that repeats at the end of the run.
  For a loop, that names the rule to remove with `simp del:`.
- **`simp_stats: true`** gives the same counts for a candidate that doesn't time out.
- **`watch_rules: ["foo"]`** and **`watch_patterns: ["f (Suc _)"]`** work like breakpoints,
  except that they record each matching step instead of stopping there. For each step
  they show:
  - the instance of the rule;
  - for a conditional rule, the premises as the simplifier tried them, and the rules it
    applied to them;
  - whether the condition was proved or failed.

  This answers "why didn't this rule fire". Interactive stepping isn't offered: each step
  would be a full turn of the agent, and the prover would wait for it the whole time.

### Where they run

The tools never edit the theory. Candidates run in threads of their own on the state of the
document, and their output goes to the agent, not to your infoview. Sledgehammer runs at a
lower priority than the checking of your edits, as with the Sledgehammer panel.

## Security

The endpoint listens on `127.0.0.1` only, and every request has to carry the window's
random token. Requests from web pages are refused. The token is in
`~/.isabelle-vscode/agents/<pid>.json`, which only your user can read, and the file is
removed when the window closes. Turning `isabelle.agents.enabled` off stops the endpoint.

The tools give an agent the prover of your window. Isabelle theories can run ML code, so
only connect agents you would also let run commands in your project.

## Without the setup command

A `.mcp.json` entry for Claude Code looks like this, with the path that **Set Up AI
Agents** puts there:

```json
{
  "mcpServers": {
    "isabelle": {
      "type": "stdio",
      "command": "node",
      "args": ["<VS Code global storage>/yfprojects.vscode-isabelle/agent/mcp_stdio.js"]
    }
  }
}
```

The relay finds the window whose workspace contains the directory Claude Code runs in. Set
`ISABELLE_VSCODE_WORKSPACE` in its `env` to use the window of another folder. Any MCP
client that can start a stdio server can use the same entry.
