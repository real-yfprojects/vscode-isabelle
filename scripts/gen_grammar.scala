// Regenerate syntaxes/isabelle-grammar.json from a distribution's own keyword table.
//
// The grammar is not hand-written: it is generated from the keywords of a session and
// from Isabelle's symbol table, so it stays in step with the logic. Run it against the
// target distribution, from the repository root:
//
//   echo ':load scripts/gen_grammar.scala' | isabelle scala
//
// `:load`, not `isabelle scala < file`: fed on stdin, the REPL decides line by line when
// a statement is complete, and splits a multi-line definition at the first line that
// parses on its own.
//
// The outer half follows upstream's `Component_VSCode.build_grammar` rule for rule (same
// keyword partition, same scopes). What it adds is inner syntax: upstream scopes a whole
// "..." as one string, so every term was the theme's string colour, and a cartouche was
// a string too. Here both are terms unless the command says otherwise:
//
//   - document commands (`text`, `section`, ...; by keyword kind) and `\<comment>` take
//     prose, which stays `string.quoted.*` -- general spell checkers target that scope
//   - ML commands take ML, left opaque until PIDE colours it
//   - file-loading commands (kind thy_load) and the theory header take names, which stay
//     strings
//
// The inner scopes are the ones VS Code maps the semantic tokens of src/semantic_tokens.ts
// to, so a term looks the same before PIDE has checked it as after; checking then adds
// what no lexer can know (free vs. bound vs. constant).

object Gen_Grammar {
  import isabelle._

  /* JSON with a stable layout: objects keep their field order */

  sealed case class Obj(fields: (String, Any)*)
  sealed case class Arr(items: Any*)

  def print(x: Any, indent: String = ""): String = {
    val next = indent + "  "
    x match {
      case s: String => JSON.Format(s)
      case Obj(fields @ _*) if fields.isEmpty => "{}"
      case Obj(fields @ _*) =>
        fields.map({ case (k, v) => next + JSON.Format(k) + ": " + print(v, next) })
          .mkString("{\n", ",\n", "\n" + indent + "}")
      case Arr(items @ _*) if items.isEmpty => "[]"
      case Arr(items @ _*) =>
        items.map(v => next + print(v, next)).mkString("[\n", ",\n", "\n" + indent + "]")
      case other => error("bad JSON value " + other)
    }
  }

  def alt(xs: Iterable[String]): String =
    xs.toList.distinct.sortBy(s => (-s.length, s)).map(Library.escape_regex).mkString("|")

  def words(xs: Iterable[String]): String = "\\b(" + alt(xs) + ")\\b"

  def include(name: String): Obj = Obj("include" -> ("#" + name))


  /* commands whose argument is ML, by name */

  // The `% "ML"` tag would say this, but Keyword.Keywords keeps only kinds and load
  // commands; the tags are gone by the time a session's syntax is assembled.
  val ml_commands = List(
    "ML", "ML_prf", "ML_val", "ML_command", "ML_export", "SML_import", "SML_export",
    "setup", "local_setup", "attribute_setup", "method_setup", "declaration",
    "syntax_declaration", "simproc_setup", "parse_translation", "print_translation",
    "typed_print_translation", "parse_ast_translation", "print_ast_translation", "oracle")

  // Inner-syntax words of HOL. The inner lexicon lives in ML, out of reach from here;
  // after checking, PIDE's `literal` markup covers every word of the actual logic.
  val inner_words = List(
    "if", "then", "else", "case", "of", "let", "in", "THE", "SOME", "LEAST", "GREATEST",
    "div", "mod", "dvd")


  def grammar(keywords: Keyword.Keywords): Obj = {
    val (minor_keywords, operators) =
      keywords.minor.iterator.toList.partition(Symbol.is_ascii_identifier)

    def major_keywords(pred: String => Boolean): List[String] =
      (for {
        k <- keywords.major.iterator
        kind <- keywords.kinds.get(k)
        if pred(kind)
      } yield k).toList

    // Kinds by their names, which a release and the development tree share; the derived
    // kind sets differ between the two.
    val asm_goal_kinds = Set(Keyword.PRF_ASM, Keyword.PRF_ASM_GOAL)
    val keywords1 =
      major_keywords(k => k != Keyword.THY_END && !asm_goal_kinds(k))
    val keywords2 = minor_keywords ::: major_keywords(Set(Keyword.THY_END))
    val keywords3 = major_keywords(asm_goal_kinds)

    val document = major_keywords(
      Set(Keyword.DOCUMENT_HEADING, Keyword.DOCUMENT_BODY, Keyword.DOCUMENT_RAW))
    val load = major_keywords(_ == Keyword.THY_LOAD)
    val ml = ml_commands.filter(k => keywords.kinds.get(k).exists(_ != Keyword.THY_LOAD))

    // A region that begins at a command must not outlive it: it also ends where the next
    // command begins, whatever it was waiting for.
    val next_command = "(?=\\b(?:" + alt(keywords.major.iterator.toList) + ")\\b)"


    /* symbols */

    val letters = Symbol.symbols.letters
    // An `if` must not end a line here: the REPL runs under -old-syntax and would take
    // `if (c)` at a line end for a complete, malformed statement.
    def escaped_name(sym: String): Option[String] = {
      val plain = sym.startsWith("\\<") && sym.endsWith(">") && !sym.startsWith("\\<^")
      if (plain) Some(sym.substring(2, sym.length - 1)) else None
    }

    val letter_names = letters.iterator.flatMap(escaped_name).toList
    val letter_chars = letters.iterator.filter(s => s.length == 1 && !Symbol.is_ascii(s)).toList
    val letter =
      "(?:[A-Za-z]|\\\\<(?:" + alt(letter_names) + ")>" +
        (if (letter_chars.isEmpty) "" else "|" + alt(letter_chars)) + ")"
    val letdig = "(?:" + letter + "|[0-9_']|\\\\<\\^sub>)"
    val ident = letter + letdig + "*"

    val not_operator = Set("\\<open>", "\\<close>", "\\<comment>")
    val operator_entries =
      Symbol.symbols.entries.filter(e =>
        escaped_name(e.symbol).isDefined && !letters(e.symbol) &&
          !Symbol.is_blank(e.symbol) && !not_operator(e.symbol))
    val operator_symbols =
      "\\\\<(?:" + alt(operator_entries.flatMap(e => escaped_name(e.symbol))) + ")>|" +
        alt(operator_entries.flatMap(_.decode).filterNot(letters))

    // Non-ASCII written as escapes, so the REPL's reading of stdin cannot mangle them.
    val open_glyph = "‹"
    val close_glyph = "›"
    val open = "(?:\\\\<open>|" + open_glyph + ")"
    val close = "(?:\\\\<close>|" + close_glyph + ")"
    val after_close = "(?<=" + close_glyph + "|\\\\<close>)"
    val after_close_or_quote = "(?<=" + close_glyph + "|\\\\<close>|\")"
    // The quotes and cartouche brackets of a term keep the string colour. A theme styles
    // a token by its innermost scope, and themes give string delimiters their colour
    // through punctuation.definition.string; any other punctuation.* would fall to a
    // theme's plain `punctuation` rule instead (Breeze Dark: the keyword blue).
    val string_delimiter_begin = "string.quoted.other.isabelle punctuation.definition.string.begin.isabelle"
    val string_delimiter_end = "string.quoted.other.isabelle punctuation.definition.string.end.isabelle"
    def delimiter(name: String): Obj =
      Obj("0" -> Obj("name" -> name))


    /* rules */

    val escape_rule =
      Obj("name" -> "constant.character.escape.isabelle", "match" -> "\\\\[\"]|\\\\\\d\\d\\d")

    val string_rule = Obj(
      "name" -> "string.quoted.double.isabelle",
      "begin" -> "\"",
      "end" -> "\"",
      "patterns" -> Arr(escape_rule))

    val cartouche_rule = Obj(
      "name" -> "string.quoted.other.multiline.isabelle",
      "begin" -> open,
      "end" -> close,
      "patterns" -> Arr(include("cartouche")))

    val marker_rule = Obj(
      "name" -> "comment.block.marker.isabelle",
      "begin" -> ("(?:\\\\<comment>|―)\\s*" + open),
      "end" -> close,
      "patterns" -> Arr(include("cartouche")))

    val inner = Arr(
      // `(*)` is HOL's multiplication as a function, not a comment
      Obj(
        "name" -> "comment.block.isabelle",
        "begin" -> "\\(\\*(?!\\))",
        "end" -> "\\*\\)",
        "patterns" -> Arr(include("comment"))),
      include("marker"),
      Obj(
        "name" -> "string.quoted.other.inner.isabelle",
        "begin" -> open,
        "end" -> close,
        "patterns" -> Arr(include("cartouche"))),
      Obj(
        "name" -> "string.quoted.single.inner.isabelle",
        "begin" -> "''",
        "end" -> "''"),
      Obj(
        "name" -> "string.quoted.double.inner.isabelle",
        "begin" -> "\"",
        "end" -> "\""),
      Obj(
        "name" -> "keyword.other.inner.isabelle",
        "match" -> ("\\b(?:" + alt(inner_words) + ")(?!" + letdig + ")")),
      // Identifiers are consumed whole and left unscoped, so that no word or operator
      // rule fires inside one (`in` in `index`, `'a` in `x'a`).
      Obj("match" -> (ident + "(?:\\." + ident + ")*")),
      Obj(
        "name" -> "entity.name.type.parameter.inner.isabelle",
        "match" -> ("\\??'" + ident)),
      Obj(
        "name" -> "variable.other.constant.inner.isabelle",
        "match" -> ("\\?" + ident + "(?:\\.[0-9]+)?")),
      Obj(
        "name" -> "constant.numeric.inner.isabelle",
        "match" -> "[0-9]+(?:\\.[0-9]+)?"),
      Obj(
        "name" -> "keyword.operator.type.inner.isabelle",
        "match" -> "::"),
      Obj(
        "name" -> "keyword.operator.inner.isabelle",
        "match" -> operator_symbols),
      Obj(
        "name" -> "keyword.operator.inner.isabelle",
        "match" -> "\\\\<\\^[A-Za-z_]+>"),
      Obj(
        "name" -> "keyword.operator.inner.isabelle",
        "match" -> "[!#$%&*+\\-/<=>@^|~:.,;()\\[\\]{}]+"))

    def term_rule(begin: String, end: String, patterns: Obj*): Obj = Obj(
      "name" -> "meta.term.isabelle",
      "begin" -> begin,
      "beginCaptures" -> delimiter(string_delimiter_begin),
      "end" -> end,
      "endCaptures" -> delimiter(string_delimiter_end),
      "patterns" -> Arr(patterns :+ include("inner"): _*))

    def command_region(
      name: String, commands: List[String], keyword_scope: String, end: String,
      patterns: Obj*
    ): Obj = Obj(
      "name" -> name,
      "begin" -> words(commands),
      "beginCaptures" -> Obj("1" -> Obj("name" -> keyword_scope)),
      "end" -> end,
      "patterns" -> Arr(patterns: _*))

    Obj(
      "name" -> "Isabelle",
      "scopeName" -> "source.isabelle",
      "fileTypes" -> Arr("thy"),
      "uuid" -> UUID.random_string(),
      "repository" -> Obj(
        "comment" -> Obj("patterns" -> Arr(Obj(
          "name" -> "comment.block.isabelle",
          "begin" -> "\\(\\*",
          "patterns" -> Arr(include("comment")),
          "end" -> "\\*\\)"))),
        "cartouche" -> Obj("patterns" -> Arr(cartouche_rule)),
        "marker" -> Obj("patterns" -> Arr(marker_rule)),
        "string" -> Obj("patterns" -> Arr(string_rule)),
        "inner" -> Obj("patterns" -> inner),
        "term-string" -> Obj("patterns" -> Arr(term_rule("\"", "\"", escape_rule))),
        "term-cartouche" -> Obj("patterns" -> Arr(term_rule(open, close))),
        "ml-cartouche" -> Obj("patterns" -> Arr(Obj(
          "name" -> "meta.embedded.block.ml.isabelle",
          "begin" -> open,
          "beginCaptures" -> delimiter(string_delimiter_begin),
          "end" -> close,
          "endCaptures" -> delimiter(string_delimiter_end),
          "patterns" -> Arr(include("cartouche"))))),
        "document-command" -> Obj("patterns" -> Arr(command_region(
          "meta.command.document.isabelle", document, "keyword.control.isabelle",
          after_close_or_quote + "|" + next_command,
          include("comment"), include("cartouche"), include("string")))),
        "ml-command" -> Obj("patterns" -> Arr(command_region(
          "meta.command.ml.isabelle", ml, "keyword.control.isabelle",
          after_close + "|" + next_command,
          include("comment"), include("ml-cartouche"), include("term-string")))),
        "load-command" -> Obj("patterns" -> Arr(command_region(
          "meta.command.load.isabelle", load, "keyword.control.isabelle",
          after_close_or_quote + "|" + next_command,
          include("comment"), include("cartouche"), include("string")))),
        "theory-header" -> Obj("patterns" -> Arr(Obj(
          "name" -> "meta.theory-header.isabelle",
          "begin" -> "\\b(imports|keywords|abbrevs)\\b",
          "beginCaptures" -> Obj("1" -> Obj("name" -> "keyword.other.unit.isabelle")),
          "end" -> "(?=\\bbegin\\b)",
          "patterns" -> Arr(
            include("comment"), include("cartouche"), include("string"),
            Obj(
              "name" -> "keyword.other.unit.isabelle",
              "match" -> "\\b(imports|keywords|abbrevs|and)\\b")))))),
      "patterns" -> Arr(
        include("comment"),
        include("marker"),
        include("document-command"),
        include("load-command"),
        include("ml-command"),
        include("theory-header"),
        Obj("name" -> "keyword.control.isabelle", "match" -> words(keywords1)),
        Obj("name" -> "keyword.other.unit.isabelle", "match" -> words(keywords2)),
        Obj("name" -> "keyword.operator.isabelle", "match" -> words(operators)),
        Obj("name" -> "entity.name.type.isabelle", "match" -> words(keywords3)),
        Obj("name" -> "constant.numeric.isabelle", "match" -> "\\b\\d*\\.?\\d+\\b"),
        include("term-string"),
        Obj(
          "name" -> "string.quoted.backtick.isabelle",
          "begin" -> "`",
          "patterns" -> Arr(
            Obj("name" -> "constant.character.escape.isabelle", "match" -> "\\\\[\\`]|\\\\\\d\\d\\d")),
          "end" -> "`"),
        Obj(
          "name" -> "string.quoted.verbatim.isabelle",
          "begin" -> "\\{\\*",
          "patterns" -> Arr(Obj("match" -> "[^*]+|\\*(?!\\})")),
          "end" -> "\\*\\}"),
        include("term-cartouche")))
  }

  def run(
    output: Path = Path.explode("syntaxes/isabelle-grammar.json"),
    logic: String = Isabelle_System.default_logic()
  ): Unit = {
    val keywords =
      Sessions.background(Options.init(), logic).check_errors.base.overall_syntax.keywords
    File.write(output, print(grammar(keywords)) + "\n")
    Output.writeln(File.standard_path(output))
  }
}

Gen_Grammar.run()
