(* Prover output for suite70: what Isabelle2026's language server sends the Output and
   State panels, as YXML with its block and break markup still in it. Each sample is a list
   of messages, written to $PIDE_FIXTURES/<name>.yxml. scripts/gen-pide-fixtures.sh runs
   this, then formats every sample with Isabelle's own Pretty.formatted (Formatted.scala),
   which is what pretty.ts and pide_html.ts must reproduce. *)

theory Pide_Fixtures
  imports Main
begin

ML \<open>
local
  val out = getenv "PIDE_FIXTURES"

  datatype message = P of string * Pretty.T | S of string * string

  fun elem (P (kind, prt)) = XML.Elem ((kind, []), YXML.parse_body (Pretty.symbolic_string_of prt))
    | elem (S (kind, s)) = XML.Elem ((kind, []), YXML.parse_body s)

  fun write name msgs =
    File.write (Path.explode (out ^ "/" ^ name ^ ".yxml")) (YXML.string_of_body (map elem msgs))

  val ctxt = \<^context> |> Config.put show_markup true |> Config.put show_sorts false

  fun goal t = Goal_Display.pretty_goal ctxt (Goal.init (Thm.cterm_of ctxt t))
  fun term t = Syntax.pretty_term ctxt t

  val consistent =
    Pretty.markup_block {markup = Markup.empty, open_block = false, consistent = true, indent = 2}
in

val _ = write "goal"
  [P ("writeln_message", goal \<^prop>\<open>\<And>xs ys. \<forall>zs.
      rev (xs @ ys @ zs) = rev zs @ rev ys @ rev (xs::nat list) \<and>
      length (xs @ ys @ zs) = length xs + length ys + length zs \<and>
      (\<exists>n::nat. n * 2 + 1 > 3 \<longrightarrow> distinct (map (\<lambda>x. x + n) xs))\<close>)]

val _ = write "term"
  [P ("writeln_message", term \<^term>\<open>{(x, y). x \<in> A \<and> y \<in> B \<and>
      (if x < y then f x y = g (h x) (h y) else
        (case xs of [] \<Rightarrow> True | z # zs \<Rightarrow> z = x \<and> length zs > (y::nat)))}\<close>)]

val _ = write "subscripts"
  [P ("writeln_message", term \<^term>\<open>\<forall>x\<^sub>1 x\<^sub>2. P x\<^sub>1 \<Longrightarrow> Q (x\<^sub>2::nat) \<Longrightarrow> R x\<^sub>1 x\<^sub>2\<close>)]

val _ = write "sendback"
  [S ("writeln_message",
      "Try this: " ^ Active.sendback_markup_command "by (simp add: algebra_simps)" ^ " (0.5 ms)"),
   S ("information_message",
      "Found proof: " ^ Active.sendback_markup_command "by auto" ^ " (12 ms)")]

val _ =
  let val (text, _) = Active.dialog_text () in
    write "dialog"
      [S ("writeln_message",
          "Tracing paused.  " ^ text "Stop" ^ ", or continue with next " ^
          text "100" ^ ", " ^ text "1000" ^ ", " ^ text "10000" ^ " messages?")]
  end

val _ = write "blocks"
  [P ("writeln_message",
      consistent (Pretty.breaks (map Pretty.str
        ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa",
         "lambda", "mu", "nu", "xi", "omicron", "pi", "rho", "sigma", "tau", "upsilon"]))),
   P ("warning_message",
      Pretty.big_list "Items:"
        [Pretty.item [Pretty.para "The first item is long enough that it has to wrap onto a second line at a narrow margin."],
         Pretty.item [Pretty.str "second"],
         Pretty.item (Pretty.text "a third item with several words that break")]),
   P ("error_message",
      Pretty.chunks [Pretty.str "line one", Pretty.str "line two",
        Pretty.enclose "(" ")" (Pretty.commas (map Pretty.str ["a", "bb", "ccc", "dddd", "eeeee"]))])]

end
\<close>

end
