---
name: isabelle
description: Use when reading, writing or proving anything in Isabelle theory files (.thy) - checking theories, inspecting goals, finding proofs and facts with the isabelle_* tools of the VS Code window.
---

# Isabelle theories

The `isabelle_*` tools talk to the prover of the open VS Code window. It keeps the
session image loaded and rechecks only what changed, so a check takes seconds. Never run
`isabelle build`, `isabelle process_theories` or `isabelle jedit` yourself: they start a
second prover, reload the image (minutes), compete for the CPU and can leave `poly`
processes running.

## Notation

Theory files are ASCII. Write symbols as `\<forall>`, `\<exists>`, `\<Longrightarrow>`,
`\<Rightarrow>`, `\<and>`, `\<or>`, `\<not>`, `\<le>`, `\<in>`, `\<lambda>`,
`\<open>...\<close>`, never as Unicode glyphs (`∀`, `⟹`, `‹›`): `isabelle build` rejects
those inside terms. The tools print goals and messages in the same notation, so whatever
you copy from their output can go into the file as it is.

## Working on a proof

1. After editing a `.thy` file, run `isabelle_check` on it. Read every error; the goal
   each failing command worked on comes with it.
2. At an error, `isabelle_state` shows the goals at that line and the goals of the
   enclosing proof.
3. Try several proofs at once with `isabelle_try`: `by simp`, `by auto`,
   `by (induct xs) auto`, `apply (cases x)`, a whole `proof ... qed` block. Nothing is
   written to the file. Only write a proof that came back `proved`.
4. If nothing works, `isabelle_sledgehammer` on the same line; it returns one-line proofs
   that it has checked.
5. Plan bigger proofs with your own goals: test an intermediate step or a helper lemma
   with `goal` on `isabelle_try` or `isabelle_sledgehammer` before writing it. Inside a
   proof the goal sees the proof's fixed variables and assumptions.
6. Run `isabelle_check` again after writing. Do not leave `sorry` or `oops` behind
   unless asked to.

## Facts and definitions

Look facts up instead of guessing their names: `isabelle_try` with candidates like
`thm foo_def`, `thm list.induct`, `term "f x"`, `typ "'a set"`, `print_statement foo`, or
`isabelle_find_theorems` with patterns such as `"rev (rev _)"`, `name: Cons`, `intro`.

## The simplifier

- A candidate that times out in `simp` or `auto` comes back with the rewrite rules it
  applied most and the cycle they repeat in. Drop the looping rule with
  `simp del: rule`, or use `unfolding` and `blast` instead.
- When a rule you expect to fire does not, watch it: `watch_rules: ["foo_simp"]` records
  each attempt, and for a conditional rule the premises simp tried to prove. Then try the
  premise itself as a `goal` with `apply simp` to see what simp makes of it.
- A conditional `[simp]` rule whose premise unfolds to something containing its own
  left-hand side loops; so does a definition used as `simp add: f_def` when its right
  side mentions `f`'s argument again.

## Pitfalls

- `let ?x = ...` abbreviations are not expanded inside attributes (`[of ?x]`); write the
  term itself, or `[where x = "..."]`.
- Inserting a step between `obtain` and a following `hence` changes what `this` refers
  to; name facts and `using` them explicitly.
- `@{term ...}` inside `text` is type-checked; use `\<open>...\<close>` for informal math.
