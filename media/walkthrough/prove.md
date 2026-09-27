# Finding proofs and facts

**Sledgehammer** hands the goal at the cursor to automatic provers and turns
what they find into a proof method. Click a result to insert it.

**Find theorems** by pattern, with the extended server:
[Find Theorems](command:isabelle.findTheorems)

- `"rev (rev _)"`: facts about a term
- `name: card`: facts whose name contains `card`

**Ctrl+click** (`Cmd+click` on macOS) any constant to open its definition in the HOL
sources. **Hover** shows types and messages.

The [Documentation](command:isabelle.documentation) panel has the Isabelle
manuals, including *prog-prove*, the tutorial for newcomers.
