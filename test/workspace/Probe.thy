theory Probe
  imports Main
begin

lemma good: "\<forall>x::'a. x = x"
  by simp

lemma bad: "\<forall>x::nat. x \<noteq> x"
  by simp

end
