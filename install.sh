#!/usr/bin/env bash
# ghost-kit installer — installs the Ghost Hunting plugin for Claude Code, then signs this
# computer in through the browser (no API key to copy).
#
#   curl -fsSL https://github.com/jweilbach/ghost-kit/releases/latest/download/install.sh | bash
#
# Safe to re-run. Works when piped to bash: everything runs inside main(), so a truncated
# download executes nothing, and questions are read from /dev/tty, never from the pipe.
# bash 3.2 compatible. Needs: Claude Code (`claude`), git, curl, jq.
#
# Environment: GHOST_KIT_NO_LOGIN=1 skips the browser sign-in; GHOST_KIT_MIRROR_URL and
# CLAUDE_BIN override the marketplace URL and the claude executable (for testing).
set -u

main() {
  local mirror="${GHOST_KIT_MIRROR_URL:-https://github.com/jweilbach/ghost-kit.git}"
  local claude="${CLAUDE_BIN:-claude}"
  local cdir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  local conf="${XDG_CONFIG_HOME:-$HOME/.config}/ghost-hunting"
  local known="$cdir/plugins/known_marketplaces.json"
  local installed="$cdir/plugins/installed_plugins.json"

  say() { printf '%s\n' "$*"; }
  fail() { printf '\nghost-kit install: %s\n' "$*" >&2; exit 1; }
  ask() { # ask "question" -> 0 for yes. No terminal -> no.
    local a=""
    [ -r /dev/tty ] || return 1
    printf '%s [Y/n] ' "$1" > /dev/tty
    read -r a < /dev/tty || return 1
    case "$a" in ''|y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
  }
  hint() {
    case "$(uname -s 2>/dev/null)" in
      Darwin) if command -v brew >/dev/null 2>&1; then printf 'brew install %s' "$1"
              else printf 'install Homebrew from https://brew.sh, then: brew install %s' "$1"; fi ;;
      *) if command -v apt-get >/dev/null 2>&1; then printf 'sudo apt-get install %s' "$1"
         elif command -v dnf >/dev/null 2>&1; then printf 'sudo dnf install %s' "$1"
         else printf 'install %s with your package manager' "$1"; fi ;;
    esac
  }

  say "Installing ghost-kit (the Ghost Hunting plugin for Claude Code)…"

  # 1. Claude Code itself.
  command -v "$claude" >/dev/null 2>&1 || fail "Claude Code isn't installed (no 'claude' command). Install it from https://code.claude.com, then run this again."

  # 2. Tools. The same checks as `ghost-kit doctor --tools`, which isn't on disk yet.
  local t missing=""
  for t in git curl jq; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done
  if [ -n "$missing" ] && [ "$(uname -s)" = Darwin ] && command -v brew >/dev/null 2>&1; then
    if ask "ghost-kit needs:$missing. Install with Homebrew now?"; then
      # shellcheck disable=SC2086
      brew install $missing || fail "brew install$missing failed."
      missing=""
      for t in git curl jq; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done
    fi
  fi
  if [ -n "$missing" ]; then
    for t in $missing; do say "  missing: $t — $(hint "$t")"; done
    fail "install the tools above, then run this again."
  fi
  local gv; gv=$(git --version | sed 's/[^0-9]*\([0-9]*\)\.\([0-9]*\).*/\1 \2/')
  set -- $gv
  if [ "${1:-0}" -lt 2 ] || { [ "${1:-0}" -eq 2 ] && [ "${2:-0}" -lt 31 ]; }; then
    fail "git $(git --version | awk '{print $3}') is too old — ghost-kit needs 2.31 or newer ($(hint git))."
  fi

  # 3. The marketplace. A development checkout registered as a directory marketplace is left
  #    exactly as it is: on that machine the plugin loads from the checkout, on purpose.
  local src; src=$(jq -r '.["ghost-kit"].source.source // empty' "$known" 2>/dev/null)
  case "$src" in
    directory|file)
      say "  ghost-kit is already registered from a local checkout ($(jq -r '.["ghost-kit"].installLocation // ""' "$known")) — leaving it." ;;
    '')
      "$claude" plugin marketplace add "$mirror" --scope user || fail "could not add the ghost-kit marketplace ($mirror)." ;;
    *)
      "$claude" plugin marketplace update ghost-kit >/dev/null 2>&1 || true ;;
  esac
  # Auto-update: Claude Code refreshes the marketplace after startup and the next session runs the
  # new version. Third-party marketplaces default to off, so turn it on for this one (user scope).
  if [ "$src" != directory ] && [ "$src" != file ]; then
    local us="$cdir/settings.json" tmp
    [ -f "$us" ] || { mkdir -p "$cdir" && printf '{}\n' > "$us"; }
    if jq -e 'type == "object"' "$us" >/dev/null 2>&1; then
      tmp="$us.ghost-kit.$$"
      jq --arg u "$mirror" '.extraKnownMarketplaces = (.extraKnownMarketplaces // {})
        | .extraKnownMarketplaces["ghost-kit"] = ((.extraKnownMarketplaces["ghost-kit"] // {source: {source: "git", url: $u}}) + {autoUpdate: true})' \
        "$us" > "$tmp" && mv "$tmp" "$us" || { rm -f "$tmp"; say "  (couldn't turn on auto-update; do it in Claude Code: /plugin → Marketplaces → ghost-kit)"; }
    else
      say "  (left $us alone — it isn't valid JSON; turn on auto-update in /plugin → Marketplaces → ghost-kit)"
    fi
  fi

  # 4. The plugin (user scope: every repo on this computer).
  if ! "$claude" plugin install ghost-hunting-core@ghost-kit --scope user; then
    jq -e '.plugins["ghost-hunting-core@ghost-kit"] // empty' "$installed" >/dev/null 2>&1 \
      || fail "could not install ghost-hunting-core@ghost-kit."
    say "  ghost-hunting-core@ghost-kit is already installed."
  fi

  # 5. Sign in, from the INSTALLED plugin (a real terminal, so no tool timeout applies).
  local root=""
  root=$(jq -r '[.plugins["ghost-hunting-core@ghost-kit"][]? | select(.scope == "user") | .installPath][0] // empty' "$installed" 2>/dev/null)
  [ -n "$root" ] && [ -x "$root/scripts/ghost-kit" ] || root="$(jq -r '.["ghost-kit"].installLocation // empty' "$known" 2>/dev/null)/plugins/ghost-hunting-core"
  [ -x "$root/scripts/ghost-kit" ] || root="$cdir/plugins/marketplaces/ghost-kit/plugins/ghost-hunting-core"
  if [ "${GHOST_KIT_NO_LOGIN:-0}" = 1 ]; then
    say "  skipped the browser sign-in (GHOST_KIT_NO_LOGIN=1)."
  elif grep -q '^GHOST_HUNTING_API_KEY__[0-9A-F]\{8\}=' "$conf/.env" 2>/dev/null; then
    say "  this computer is already signed in to Ghost Hunting."
  elif [ -x "$root/scripts/ghost-kit" ]; then
    say ""
    say "Signing this computer in to Ghost Hunting. A browser window will open:"
    say "create an account (or sign in), check the code matches, then click Connect."
    if [ -r /dev/tty ]; then "$root/scripts/ghost-kit" login < /dev/tty
    else "$root/scripts/ghost-kit" login < /dev/null; fi
    case $? in
      0) ;;
      2) say "Sign-in cancelled — you can finish it later from Claude Code with /ghost-onboard." ;;
      *) say "Sign-in didn't finish — you can do it later from Claude Code with /ghost-onboard." ;;
    esac
  else
    say "  (couldn't find the installed plugin to sign in from; /ghost-onboard in Claude Code will do it.)"
  fi

  say ""
  say "Done. Open Claude Code in your repo (restart it if it's already open) and type /ghost-onboard."
}

main "$@"
