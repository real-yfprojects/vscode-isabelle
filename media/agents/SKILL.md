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
   each failing command worked on comes with it. A check that is still running at its
   timeout names the commands the prover runs: the same one on the next call is slow or
   stuck, so test its goal with `isabelle_try` and a timeout, or edit it. A check that
   reports `no progress` found commands that ran 30 s with nothing else moving: usually a
   `metis`, `auto` or `smt` that never ends, which runs until you edit it. When there is
   other work to do, `isabelle_check` with `wait: false` answers at once with the
   progress; ask again later. The other tools work on the commands already checked.
2. At an error, `isabelle_state` shows the goals at that line and the goals of the
   enclosing proof.
3. Try several proofs at once with `isabelle_try`: `by simp`, `by auto`,
   `by (induct xs) auto`, `apply (cases x)`, a whole `proof ... qed` block. Nothing is
   written to the file. Only write a proof that came back `proved`; of several, the
   fastest. A proof marked slow, or a slow step named in a longer candidate, is worth
   replacing before it goes into the file.
4. If nothing works, `isabelle_sledgehammer` on the same line; it returns one-line proofs
   that it has checked. If it says the goal is *falsified*, the step is false as stated:
   fix the statement instead of hammering it again. Calls on different goals may run at
   once, and a call goes on while the file is edited.
5. Plan bigger proofs top-down. Try the outline as one candidate, with `sorry` for each
   step: `proof (induct xs) case Nil show ?case sorry next case (Cons x xs) show ?case
   sorry qed`. It comes back `proved_with_sorry` with the goals of each hole; fill them
   in one at a time. Test an intermediate step or a helper lemma with `goal` on
   `isabelle_try` or `isabelle_sledgehammer` before writing it. Inside a proof the goal
   sees the proof's fixed variables and assumptions.
6. Run `isabelle_check` again after writing. It lists every `sorry` left with the goals
   it skips. Do not leave `sorry` or `oops` behind unless asked to.

## Going on from a state

Each `isabelle_try` candidate that reaches a state comes back with a handle (`h7`). Pass
it as `from` instead of `path` and `line` to go on from there: one or two `apply` steps
at a time, back to an earlier handle to try another way, or several ways from one
handle at once. The answer shows the steps so far, ready to write into the file. Handles
last until the prover restarts; one whose theory changed above its first line says so.

Goals left in a handle's state also come back stated on their own. To hammer one, give
it as `goal` to `isabelle_sledgehammer` at the line the chain started at, then try the
proof it finds `from` the handle as `apply ...`, with the `using` it suggests.

## Facts and definitions

Before guessing which definition to unfold or which lemma applies, call
`isabelle_context` at the line (or `from` a handle): it lists the definitions of the
constants in the goal with the fact to use for each (`foo_def`, `foo.simps`,
`foo.intros`), the variables and facts of the proof, and the library facts most relevant
to the goal. Look other facts up instead of guessing their names: `isabelle_try` with
candidates like `thm foo_def`, `thm list.induct`, `term "f x"`, `typ "'a set"`,
`print_statement foo`, or `isabelle_find_theorems` with patterns such as
`"rev (rev _)"`, `name: Cons`, `intro`. `quickcheck` and `nitpick` as candidates look for
a counterexample to the goal.

## Speed

`isabelle_profile` lists the slowest lemmas of a theory with the slowest command of each.
Leave out what cannot be made faster with `exclude` (lemma names), and check a lemma
again with `match` after changing its proof.

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
