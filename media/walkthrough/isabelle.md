# Finding Isabelle

The extension looks, in this order, in:

1. the **Isabelle: Home** setting
2. `$ISABELLE_HOME`
3. a release like `Isabelle2026`, `Isabelle2025-2` or `Isabelle2026.app` (the newest one found) in
   - **Windows:** `~/Isabelle`, your home folder, your Desktop (where the installer puts it), `C:\`
   - **macOS:** `/Applications`, `~/Applications`, your home folder
   - **Linux:** your home folder, `/opt`, `/usr/local`

Somewhere else? Set [Isabelle: Home](command:workbench.action.openSettings?%5B%22isabelle.home%22%5D) to the folder that contains `bin/isabelle`. On macOS, set it to the app itself, such as
`/Applications/Isabelle2026.app`. The extension tries again as soon as you change the setting. Isabelle2026 comes as two
macOS downloads, one for Apple Silicon and one for Intel Macs: use the one for your Mac.

On Windows, the installer (`Isabelle2026.exe`) sets Isabelle up completely. If you unpacked it some other way, for example with 7-Zip, start `Isabelle2026.exe` in the Isabelle folder once, so that it can set up its bundled Cygwin.
