theory Tutorial
  imports Main
begin

text \<open>
  Isabelle checks this theory while you read and edit
  it: the status bar shows how far, and a proof that
  fails is underlined in red. Try it: change "x + 1" to
  "x - 1" in the first lemma below.
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
  Move the cursor through this proof: the Infoview shows
  the goal at each step.
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
  every theorem that matches. Ctrl+click rev to open its
  definition.
\<close>

find_theorems "rev (rev _)"

end
