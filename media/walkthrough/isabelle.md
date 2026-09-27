# Finding Isabelle

The extension looks, in this order, in:

1. the **Isabelle: Home** setting
2. `$ISABELLE_HOME`
3. a folder named like `Isabelle2025-2` in
   - **Windows:** `~/Isabelle`, your home folder, `C:\`
   - **macOS:** `/Applications`, `~/Applications`, your home folder
   - **Linux:** your home folder, `/opt`, `/usr/local`

Somewhere else? Set [Isabelle: Home](command:workbench.action.openSettings?%5B%22isabelle.home%22%5D) to the folder that contains `bin/isabelle`. On macOS that is
`/Applications/Isabelle2025-2.app/Contents/Resources/Isabelle2025-2`.

On Windows, run `Cygwin-Setup.bat` in the Isabelle folder once after unpacking.
