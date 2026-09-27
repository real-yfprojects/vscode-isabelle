theory Tree
  imports Main
begin

datatype 'a tree = Leaf | Node "'a tree" 'a "'a tree"

fun mirror :: "'a tree \<Rightarrow> 'a tree" where
  "mirror Leaf = Leaf"
| "mirror (Node l x r) = Node (mirror r) x (mirror l)"

fun contents :: "'a tree \<Rightarrow> 'a list" where
  "contents Leaf = []"
| "contents (Node l x r) = contents l @ x # contents r"

end
