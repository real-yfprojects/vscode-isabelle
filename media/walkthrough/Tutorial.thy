theory Tutorial
  imports Main
begin

text \<open>
  Isabelle checks this theory while you read and edit
  it: the status bar shows how far, and a proof that
  fails is underlined in red. Hover over the underline
  to read the error; the Problems view lists them all.
  Try it: change "x + 1" to "x - 1" in the first lemma
  below.

  The first start loads the HOL image, which takes a few
  seconds up to a minute. Then Isabelle checks from the
  top down to 50 lines below the cursor, and again as
  you type.
\<close>

section \<open>Symbols\<close>

text \<open>
  The file stores every symbol as ASCII; the editor only
  draws the glyph. Put the cursor inside a symbol of the
  first lemma to see what is stored. To type one, write
  a backslash and its name, as in \all, \inter or \in,
  and a space.
\<close>

lemma "\<forall>x::nat. x \<le> x + 1"
  by simp

lemma "A \<inter> B \<subseteq> A \<union> B"
  by blast

lemma "x\<^sub>1 + x\<^sub>2 = x\<^sub>2 + (x\<^sub>1::nat)"
  by simp

section \<open>Goals\<close>

text \<open>
  Move the cursor through this proof: the Isabelle
  Infoview shows the goal at each step.
\<close>

lemma "rev (rev xs) = xs"
proof (induction xs)
  case Nil
  then show ?case by simp
next
  case (Cons x xs)
  then show ?case by simp
qed

section \<open>Sledgehammer\<close>

text \<open>
  Put the cursor on the lemma below and run Sledgehammer.
  Click the proof it finds to put it in place of the
  sorry.
\<close>

lemma "distinct xs \<Longrightarrow> card (set xs) = length xs"
  sorry

section \<open>Finding facts\<close>

text \<open>
  With the cursor on the next line, the Infoview lists
  every theorem that matches; the line after it finds
  theorems by name. Hover over rev to see its type, and
  Ctrl+click it (Cmd+click on macOS) to open its
  definition.
\<close>

find_theorems "rev (rev _)"
find_theorems name: card

end
