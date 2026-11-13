/* The expected output for suite70: each $DIR/<name>.yxml (from Pide_Fixtures.thy) formatted
   by Isabelle's Pretty.formatted at several margins, as Isabelle2025-2's server and
   Isabelle2026's own output view do, and made HTML by Browser_Info's make_html.

     <name>.<margin>.formatted.yxml   the formatted XML
     <name>.<margin>.html             its HTML

   The node context makes the same elements pide_html.ts makes for links and active markup
   (`a` and `span class="active"`); suite70 compares tags, classes and text, not attributes. */

import isabelle._

object Formatted {
  val margins: List[Int] = List(20, 40, 76, 120)

  val node_context: Browser_Info.Node_Context =
    new Browser_Info.Node_Context {
      override def make_ref(props: Properties.T, body: XML.Body): Option[XML.Elem] =
        props match {
          case Position.Item_Def_File(_, _, _) | Position.Item_Def_Id(_, _) =>
            Some(XML.Elem(Markup("a", Nil), body))
          case _ => None
        }
      override def make_file_ref(file: String, body: XML.Body): Option[XML.Elem] =
        Some(XML.Elem(Markup("a", Nil), body))
      override def make_active(active: XML.Elem, body: XML.Body): Option[XML.Elem] =
        Some(HTML.span("active", body))
    }

  val elements: Browser_Info.Elements =
    Browser_Info.extra_elements.copy(entity = Markup.Elements.full,
      active = Markup.Elements(Markup.SENDBACK, Markup.DIALOG))

  def main(args: Array[String]): Unit = {
    Isabelle_System.init()
    val dir = Path.explode(File.standard_path(args(0)))
    for (file <- File.read_dir(dir) if file.endsWith(".yxml") && !file.contains(".formatted.")) {
      val name = file.stripSuffix(".yxml")
      val messages = YXML.parse_body(YXML.Source(File.read(dir + Path.basic(file))))
      for (margin <- margins) {
        val formatted =
          Pretty.formatted(Pretty.separate(messages), margin = margin.toDouble,
            metric = Symbol.Metric)
        File.write(dir + Path.basic(name + "." + margin + ".formatted.yxml"),
          YXML.string_of_body(formatted))
        val html = node_context.make_html(elements, formatted)
        File.write(dir + Path.basic(name + "." + margin + ".html"),
          HTML.output(html, hidden = false, structural = false))
      }
      println(name)
    }
  }
}
