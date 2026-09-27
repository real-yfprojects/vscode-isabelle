#!/usr/bin/env bash
#
# Build server/<IDENTIFIER>.jar: the Isabelle/Scala module of a released Isabelle,
# compiled from the backport branch of mirror-isabelle for that release.
#
# Usage: scripts/build-server-jar.sh [--if-stale] ISABELLE_HOME [SOURCE]
#
#   ISABELLE_HOME  the released distribution the jar is for; provides the toolchain
#   SOURCE         a checkout of the backport, e.g. a worktree of vscode-2025-2, built
#                  as it stands, uncommitted changes included. Without it, the commit
#                  named in server/<IDENTIFIER>.ref is fetched from $MIRROR_URL.
#   --if-stale     build only if the jar was not built from exactly this source: the
#                  commit, the uncommitted changes and new files of a checkout, and this
#                  script. The dev launcher uses it on every start.
#
# The extension puts that jar ahead of the distribution's own lib/classes/isabelle.jar
# (extendedServer in src/isabelle.ts), so users get the extra panels without patching,
# copying or rebuilding their Isabelle.
#
# The distribution is only read, never written. The backport's sources are copied into a
# scratch component, and Isabelle's own Setup builds that component alone: Setup takes
# the component list from the settings environment, and getsettings leaves an
# environment alone that is already marked ISABELLE_SETTINGS_PRESENT, so exporting the
# dumped settings with ISABELLE_COMPONENTS replaced is enough. Setting ISABELLE_COMPONENTS
# directly does not work -- getsettings resets it.
#
# Takes a few minutes: it compiles all of Isabelle/Scala.

set -euo pipefail

MIRROR_URL="${MIRROR_URL:-https://github.com/real-yfprojects/mirror-isabelle.git}"

repo="$(cd "$(dirname "$0")/.." && pwd)"
# Inside the repository rather than under /tmp: Isabelle's Cygwin maps /tmp into the
# distribution itself. One directory per run, since the dev launcher runs this on every
# start: runs that shared one deleted each other's files, and failed with `*** I/O error`
# on a resource of the component.
run="${BUILD_SERVER_JAR_RUN:-run-$$}"
work="$repo/.server-build/$run"


# sources: resolved in whatever shell started this, which has git

if [ -z "${BUILD_SERVER_JAR_INNER:-}" ]; then
  if_stale=""
  if [ "${1:-}" = "--if-stale" ]; then if_stale=1; shift; fi
  if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    echo "usage: $0 [--if-stale] ISABELLE_HOME [SOURCE]" >&2
    exit 2
  fi
  home="$(cd "$1" && pwd)"
  if [ ! -f "$home/etc/ISABELLE_IDENTIFIER" ]; then
    echo "$home is not a released Isabelle distribution (no etc/ISABELLE_IDENTIFIER)" >&2
    exit 1
  fi
  ident="$(cat "$home/etc/ISABELLE_IDENTIFIER")"
  ref_file="$repo/server/$ident.ref"
  if [ ! -f "$ref_file" ]; then
    echo "no backport for $ident: $ref_file is missing" >&2
    exit 1
  fi
  commit="$(grep -v '^#' "$ref_file" | grep -m 1 -o '[0-9a-f]\{40\}')"

  # What the jar is built from, as one hash: the source's commit, for a checkout also its
  # uncommitted changes and new files under what Setup reads, and this script, whose
  # changes alter the jar too. Recorded beside the jar after a build.
  if [ "$#" -eq 2 ]; then
    source="$(cd "$2" && pwd)"
    key="$({
      git -C "$source" rev-parse HEAD
      git -C "$source" diff HEAD -- src etc/build.props lib/services
      git -C "$source" ls-files --others --exclude-standard -- src etc lib |
        while IFS= read -r f; do echo "$f $(git -C "$source" hash-object -- "$f")"; done
      git hash-object -- "$0"
    } | git hash-object --stdin)"
  else
    source=""
    key="$({ echo "$commit"; git hash-object -- "$0"; } | git hash-object --stdin)"
  fi
  stamp="$repo/server/$ident.jar.source"
  if [ -n "$if_stale" ] && [ -f "$repo/server/$ident.jar" ] && [ -f "$stamp" ] &&
     [ "$(cat "$stamp")" = "$key" ]; then
    echo "server/$ident.jar is up to date"
    exit 0
  fi

  rm -rf "$work"
  mkdir -p "$work"
  trap 'rm -rf "$work"' EXIT

  if [ -n "$source" ]; then
    head="$(git -C "$source" rev-parse HEAD 2>/dev/null || true)"
    if [ "$head" != "$commit" ]; then
      echo "note: building $source at ${head:-an unknown commit}, not $commit from $ref_file" >&2
    fi
  else
    # Just the tree of that commit, and of it only what Setup compiles or packs: no
    # history, no theories.
    source="$work/source"
    git init -q "$source"
    git -C "$source" config core.autocrlf false
    git -C "$source" config core.sparseCheckout true
    # The ML of the server travels as a resource too (vscode_completion.ML): the prover
    # loads it at startup, since a released heap does not contain it.
    printf '%s\n' '/etc/build.props' '/lib/services/' '/lib/logo/' '*.scala' '*.java' \
      '/src/Tools/VSCode/src/*.ML' > "$source/.git/info/sparse-checkout"
    echo "fetching $commit from $MIRROR_URL"
    git -C "$source" fetch -q --depth 1 --filter=blob:none "$MIRROR_URL" "$commit"
    git -C "$source" -c advice.detachedHead=false checkout -q FETCH_HEAD
  fi

  # On Windows, Isabelle's settings and paths are Cygwin's, and Git Bash's differ from
  # them (/c/... against /cygdrive/c/...). Build under Isabelle's own bash instead.
  case "$(uname -s)" in
    MINGW*|MSYS*)
      script_w="$(cygpath -m "$(cd "$(dirname "$0")" && pwd)/$(basename "$0")")"
      # The login shell sets up Cygwin's PATH; the script itself runs in a plain child,
      # since run as the login shell it exits silently before its first line.
      BUILD_SERVER_JAR_INNER=1 BUILD_SERVER_JAR_KEY="$key" BUILD_SERVER_JAR_RUN="$run" \
        exec "$(cygpath -m "$home")/contrib/cygwin/bin/bash.exe" -l \
        -c 'exec bash "$0" "$1" "$2"' "$script_w" "$(cygpath -m "$home")" "$(cygpath -m "$source")"
      ;;
  esac
else
  # Re-run under Isabelle's Cygwin, with both paths resolved.
  home="$(cd "$1" && pwd)"
  source="$(cd "$2" && pwd)"
  ident="$(cat "$home/etc/ISABELLE_IDENTIFIER")"
  key="${BUILD_SERVER_JAR_KEY:-}"
  stamp="$repo/server/$ident.jar.source"
  trap 'rm -rf "$work"' EXIT
fi

out="$repo/server/$ident.jar"
comp="$work/component"
rm -rf "$comp"
mkdir -p "$comp/etc"


# component: the backport's sources and resources

# The items of a multi-line build.props entry, one per line. A checkout with
# core.autocrlf has CRLF line ends, so those go first; the continuation backslash is then
# tested as a character, not with /\\$/, which gawk 5.4 does not match.
props_list() {
  awk -v key="$1" '
    { sub(/\r$/, "") }
    $0 ~ "^" key " *=" { r = 1; sub("^" key " *= *", "") }
    r {
      line = $0; more = (substr(line, length(line)) == "\\")
      if (more) line = substr(line, 1, length(line) - 1)
      n = split(line, items, " ")
      for (i = 1; i <= n; i++) print items[i]
      if (!more) r = 0
    }' "$2"
}

resources="$(props_list resources "$source/etc/build.props" | sed 's/:.*//')"

(
  cd "$source"
  { find src \( -name '*.scala' -o -name '*.java' \); echo "$resources"; } | tar -cf - -T -
) | (cd "$comp" && tar -xf -)

# A checkout with core.autocrlf has CRLF sources, and they do not compile to the same
# jar: multi-line string literals carry the \r into the classes, and every .tasty records
# different positions. Built from a Windows worktree, 862 of 3620 entries differed from
# the jar built from the fetched commit. So compile what the commit holds: LF. The text
# resources under src and lib/services too; lib/logo is images and must stay as it is.
find "$comp/src" \( -name '*.scala' -o -name '*.java' -o -name '*.ML' \) \
  -exec perl -pi -e 's/\r$//' {} +
if [ -d "$comp/lib/services" ]; then
  find "$comp/lib/services" -type f -exec perl -pi -e 's/\r$//' {} +
fi

# Scala services are not compiled into this jar's record: Isabelle reads the service list
# of every jar on the classpath (Classpath.services), and the distribution's own jar,
# still on it behind this one, already names them all. A second record registers every
# Scala function twice, and the prover dies at startup with `Exception- DUP "echo"`. The
# names in the distribution's record load from this jar anyway, being first. That only
# holds while the backport adds no services, so refuse one that does.
if [ "$(props_list services "$home/etc/build.props")" != \
     "$(props_list services "$source/etc/build.props")" ]; then
  echo "the backport changes etc/build.props services; this jar cannot carry that" >&2
  exit 1
fi

# The module is written relative to the component, not into $ISABELLE_HOME/lib/classes.
awk '
  { sub(/\r$/, "") }
  /^services *=/ { skip = 1 }
  skip { if (substr($0, length($0)) != "\\") skip = 0; next }
  /^module *=/ { print "module = lib/isabelle.jar"; next }
  { print }' "$source/etc/build.props" > "$comp/etc/build.props"


# build, in the distribution's settings environment

"$home/bin/isabelle" getenv -d "$work/settings"

(
  while IFS= read -r -d '' entry; do
    name="${entry%%=*}"
    case "$name" in
      ''|*[!A-Za-z0-9_]*|[0-9]*) continue ;;
      BASH*|SHELLOPTS|UID|EUID|PPID|_) continue ;;
    esac
    export "$entry" 2>/dev/null || true
  done < "$work/settings"

  export ISABELLE_COMPONENTS="$comp"

  classpath="$ISABELLE_CLASSPATH"
  if [ -n "${CYGWIN_ROOT:-}" ]; then classpath="$(cygpath -w -p "$classpath")"; fi

  eval "declare -a java_args=($ISABELLE_TOOL_JAVA_OPTIONS)"
  "$JAVA_HOME/bin/java" "${java_args[@]}" -classpath "$classpath" \
    isabelle.setup.Setup build_fresh
)

cp "$comp/lib/isabelle.jar" "$out"
if [ -n "$key" ]; then echo "$key" > "$stamp"; else rm -f "$stamp"; fi
echo "built $out"
