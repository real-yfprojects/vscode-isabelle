#!/usr/bin/env bash
# Regenerate test/fixtures/pide: prover output from Isabelle itself, and what Isabelle/Scala
# makes of it, for suite70 to hold pretty.ts and pide_html.ts against.
#
#   scripts/gen-pide-fixtures.sh <ISABELLE_HOME>
#
# 1. scripts/pide-fixtures/Pide_Fixtures.thy is processed with HOL (process_theories); its
#    ML writes each sample, a list of messages as YXML, to <name>.yxml.
# 2. scripts/pide-fixtures/Formatted.scala formats each with Pretty.formatted at several
#    margins and makes HTML with Browser_Info's make_html: <name>.<margin>.formatted.yxml
#    and <name>.<margin>.html.
# 3. etc/symbols is copied too, so suite70 decodes symbols as Isabelle did.
#
# On Windows (Git Bash) it re-runs itself under the distribution's Cygwin bash, which is
# what bin/isabelle needs.
set -euo pipefail

if [ -z "${GEN_PIDE_FIXTURES_INNER:-}" ] && [ -x "$1/contrib/cygwin/bin/bash.exe" ]; then
  home_m="$(cd "$1" && pwd -W 2>/dev/null || cygpath -m "$1")"
  # Absolute: a login shell starts in its home directory.
  script_m="$(cygpath -m "$(cd "$(dirname "$0")" && pwd)/$(basename "$0")")"
  GEN_PIDE_FIXTURES_INNER=1 exec "$home_m/contrib/cygwin/bin/bash.exe" -l \
    -c 'exec bash "$0" "$1"' "$script_m" "$home_m"
fi

home="$(cd "$1" && pwd)"
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/pide-fixtures"
out="$here/../test/fixtures/pide"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
rm -f "$out"/*.yxml "$out"/*.html

cd "$src"
PIDE_FIXTURES="$out" "$home/bin/isabelle" process_theories -l HOL -f Pide_Fixtures.thy Pide_Fixtures
"$home/bin/isabelle" scala Formatted.scala "$out"
cp "$home/etc/symbols" "$out/symbols"
echo "fixtures in $out from $(cat "$home/etc/ISABELLE_IDENTIFIER")"
