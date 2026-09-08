theory Hover
  imports Main
begin

text \<open>Ctrl+hover over the glyphs below. They should underline and the pointer
  should become a hand, exactly as it does over an ordinary identifier.\<close>

lemma h1: "P \<Longrightarrow> P"
  by simp

lemma h2: "(A \<and> B) \<longrightarrow> A"
  by simp

lemma h3: "\<forall>x. x = x"
  by simp

definition hov :: "nat \<Rightarrow> nat" where
  "hov n = n + 1"

lemma h4: "hov n = n + 1"
  unfolding hov_def by simp

end
