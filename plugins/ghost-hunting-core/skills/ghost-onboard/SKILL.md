---
name: ghost-onboard
description: Connect this computer and this repo to Ghost Hunting in one pass — a browser sign-in with nothing to copy or paste, then the repo linked to a Séance (portfolio) so /summon, /haunt and /commence-haunt work. Use when the user says "ghost onboard", "onboard", "set up ghost hunting", "connect to ghost hunting", "connect this repo", "sign in to ghost hunting", "log in to ghost hunting", "reconnect ghost hunting", or when any ghost-kit message says to type /ghost-onboard.
allowed-tools: Bash, Read, Glob, Grep
---

# Ghost Onboard

## Codex host

When running in Codex, apply the [Codex host adapter](../../runtime/CODEX.md)
before the steps below. It maps skill/agent/workflow calls to Codex while
preserving these instructions, result contracts, and gates. Claude follows its
existing execution path. In Codex the user types `$ghost-onboard`; in Claude, `/ghost-onboard`.

This is the one ghost-kit skill that runs **before** a credential exists, so it does not use the
canonical Phase 0 block (that block stops when there is no key). Everything that touches the
API key goes through the `ghost-kit` helper, which never prints the key — keep it that way:
never `cat`, `grep` or echo `~/.config/ghost-hunting/.env`, and never put a key in a command.

**Invocation input** means the user's text after `/ghost-onboard` (Claude) or `$ghost-onboard`
(Codex). `--local` targets the local backend (`http://localhost:8000`); anything else is ignored.

## Words to use

- First mention gets the spooky term with a plain gloss: "Coven (organization)", "Séance
  (portfolio)", "Haunting (project)", "ghost (task)". After that, the spooky term alone.
- On the happy path never say "Talisman" or "Medium". Say "API key" and "Claude Code (Name)".
- Error lines use plain words ("API key", "sign in"), and are relayed exactly as the helper prints them.
- Keep it short: at most **one** question on the happy path (the Step 4 confirmation).

## Step 0 — Find the helper

Run this first. Every later step calls the absolute path it prints (each Bash call is a fresh
shell, so use the printed path, not `$GK`).

```bash
# ── ghost-onboard bootstrap (runs before any credential exists; NOT the canonical Phase 0) ──
PLUGIN_VERSION="1.10.0"
GK="${CLAUDE_PLUGIN_ROOT}/scripts/ghost-kit"
if [ ! -x "$GK" ]; then
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  GK_SRC=$(jq -r '.["ghost-kit"].installLocation // empty' "$HOME/.claude/plugins/known_marketplaces.json" 2>/dev/null)
  GK_CODEX=$(setopt nonomatch 2>/dev/null || true; ls -d "$HOME"/.codex/plugins/cache/*/ghost-hunting-core/*/ 2>/dev/null | sort | tail -n 1)
  GK_RESOLVED=$([ -x "$REPO_ROOT/.ghost/bin/resolve-plugin" ] && "$REPO_ROOT/.ghost/bin/resolve-plugin" 2>/dev/null)
  for c in "${GHOST_KIT_ROOT:-}" "$GK_RESOLVED" "$GK_SRC/plugins/ghost-hunting-core" "${GK_CODEX%/}" "$REPO_ROOT/plugins/ghost-hunting-core"; do
    [ -n "$c" ] && [ -x "$c/scripts/ghost-kit" ] && { GK="$c/scripts/ghost-kit"; break; }
  done
fi
[ -x "$GK" ] || { echo "STOP: ghost-kit's helper is missing from this install. Reinstall it: curl -fsSL https://github.com/jweilbach/ghost-kit/releases/latest/download/install.sh | bash"; exit 3; }
echo "ghost-kit helper: $GK  (skill prose v$PLUGIN_VERSION, helper $("$GK" version))"
```

If it printed `STOP:`, relay that line and stop. With `--local` in the invocation input, add
`--local` to every `login`, `status`, `covens` and `api` call below.

## Step 1 — Tools (ask only if something is missing)

```bash
"<helper>" doctor --tools
```

Exit 0 → say nothing about tools and continue. Nonzero → show only the `MISSING` / `TOO OLD`
lines and ask once whether to run the install command each line names (for example
`brew install jq`). If a line says to install Homebrew from brew.sh, tell the user to do that
first — never offer `brew install` without Homebrew. Re-run the check after installing.

## Step 2 — Sign in (only if this computer has no working key for this repo)

Read the repo's Coven binding and the sign-in state:

```bash
ORG_HINT=$(jq -r '.auth.prod.org_id // empty' "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.ghost/config.json" 2>/dev/null); echo "org_hint: ${ORG_HINT:-none}"
"<helper>" status --json
"<helper>" covens --json
```

You need a sign-in when **either**:

- the repo is connected (`connected_repo: true`) and `status` reports `problem` `no_key`,
  `rejected` or `wrong_coven`; or
- the repo is NOT connected and `covens` lists no entry with `"http": "200"`.

If the repo is not connected and `covens` lists exactly one working Coven, use it — no sign-in,
no question. If it lists several, name them in the Step 4 block and use the first unless the user
picks another (that is still the one confirmation).

To sign in:

1. Start the login (pass the hint when there is one; add `--local` if the user asked for it):

   ```bash
   "<helper>" login --start --org-hint <org_hint>      # omit --org-hint when there is none
   ```

2. **Write the code and the link in your own reply text first**, so the user sees them even if
   tool output is collapsed:

   > Your browser should be open on Ghost Hunting. Check that it shows code **ABCD-EFGH**, then
   > click **Connect** (create an account there first if you don't have one). If no browser
   > opened, use this link: https://…/connect?code=ABCD-EFGH

3. Then wait, repeating this call quietly (allow it up to 2 minutes per call):

   ```bash
   "<helper>" login --wait
   ```

   | exit | meaning | do |
   |---|---|---|
   | 0 | connected | read the `org_id:` / `org_name:` lines and continue |
   | 10 | still waiting | call `login --wait` again — no commentary beyond an occasional "still waiting for you to approve in the browser" |
   | 11 | the code expired; a fresh one was started and printed | relay the NEW code and link exactly as in 2, then keep waiting |
   | 2 | the user clicked "This wasn't me" | say "Cancelled. Nothing was connected." and stop |
   | 12 | this session can't write to `~/.config/ghost-hunting` (sandbox) | tell the user to type the `! "…/ghost-kit" login` line the helper printed (the `!` runs it in their own terminal), then to type /ghost-onboard again; stop |
   | 1 | an error | relay the helper's line and stop |

   Give up after about 20 minutes or three expired codes, saying they can type /ghost-onboard
   again whenever they're ready.

## Step 3 — A repo that is already connected (`.ghost/config.json` exists)

Re-run `"<helper>" status --json`. If `problem` is not `none`, relay `message` and stop (the
sign-in above should have fixed it; if it did not, the line says why). If `shadow` is non-empty,
show it — it names the exact `.env` line to delete.

Otherwise show where the repo points — Coven (organization), Séance (portfolio), the key's
source — and offer, in one line: **Keep** (default) / **switch Séance** / **sign in again**.

- Keep → go to Step 5.
- Switch Séance → do Step 4's Séance choice, then `init --force` with the new id (it keeps every
  other setting).
- Sign in again → Step 2 regardless of state.
- The config has no `auth.prod.org_id` (connected before 1.10.0): offer to bind it to the signed-in
  Coven — `"<helper>" init --force --seance <its current seance.id> --org-id <id> --org-name <name>`.
  Binding changes where its key may come from (the signed-in key works; the legacy
  `~/.claude/.env` stops being read), so say that in one line and let them decline.

## Step 4 — A repo that is not connected yet

Don't ask "connect this repo?" — they ran the skill here. Work out everything, then ask **once**.

**Séance (portfolio).** List them with the Coven's key (`<org_id>` from Step 2):

```bash
"<helper>" api GET "/api/agent/seances?limit=100" --org-id <org_id>
```

Pick the Séance whose name matches the repo directory name (case-insensitive, ignoring `-`, `_`
and spaces). No match → propose a NEW Séance named after the repo ("acme-web" → "Acme Web",
keeping the original if it reads better) and list up to five existing ones as alternatives. Zero
Séances → the new one is the only proposal.

**Haunting (project).** For an existing Séance, list its Hauntings
(`"<helper>" api GET "/api/agent/hauntings?portfolio_id=<id>" --org-id <org_id>`) and show the
one named "General", else the first. A new Séance, or one with none, gets a new Haunting "General".

**Tests.** Read the repo (don't ask) and pick the command people actually run:
`scripts/test.sh` → `./scripts/test.sh`; `package.json` with a `test` script → `npm test`
(`pnpm test` / `yarn test` when that lockfile is present); `pyproject.toml`/`pytest.ini`/`tests/`
with pytest → `pytest`; `Cargo.toml` → `cargo test`; `go.mod` → `go test ./...`; a `Makefile`
with a `test:` target → `make test`. One stack → `--tests-all`. Separate frontend and backend
folders with their own runners → `--tests-frontend` and `--tests-backend` (run from the repo
root, e.g. `cd frontend && npm test`). Nothing found → no test flag, and say so.

**The one confirmation.** Show exactly one block and wait:

```
Ready to connect this repo to Ghost Hunting:
  Coven (organization):  Acme
  Séance (portfolio):    acme-web          (new — will be created)
  Haunting (project):    General           (new — will be created)
  Tests:                 npm test
  Will write:            .ghost/config.json, .claude/settings.json
Go ahead? (yes, or tell me what to change)
```

Name the alternatives under it only when there are some ("Other Séances: …", "Other Covens: …").

**On yes:**

1. Create what is new, then read the ids from the replies:

   ```bash
   "<helper>" api POST /api/agent/seances --org-id <org_id> --data '{"name": "<Séance name>"}'
   "<helper>" api POST /api/agent/hauntings --org-id <org_id> --data '{"name": "General", "portfolio_id": "<seance id>"}'
   ```

2. Write the repo files (rites stay off):

   ```bash
   "<helper>" init --seance <seance id> --seance-name "<Séance name>" --org-id <org_id> --org-name "<Coven name>" --tests-all "<cmd>"
   ```

   Use `--tests-frontend` / `--tests-backend` instead of `--tests-all` when you split them; omit
   all three when no test command was found. `init` only adds the ghost-kit marketplace and plugin
   to `.claude/settings.json`; it never removes or changes anything already there.

## Step 5 — The final message

Verify quietly: `"<helper>" status` must exit 0. Show helper or doctor output **only** if that
fails (then run `"<helper>" doctor` and show its PROBLEM lines). On success, say exactly this,
filled in (the user's name is the one in parentheses in "Claude Code (Name)"; drop "Name, " if
there is none):

```
Connected to Ghost Hunting.
  You: Sam, in the Acme Coven (organization), as "Claude Code (Sam)"
  This repo → Séance (portfolio) "acme-web" › Haunting (project) "General"
Commit .ghost/config.json and .claude/settings.json so teammates are set up automatically.
Your API key lives in ~/.config/ghost-hunting/.env, never in the repo.
Next:
  /summon <what needs doing>   create your first ghost (task)
  /haunt                       pick up the next ghost to work on
  /commence-haunt <ghost>      work a ghost start to finish
```

In Codex, write the commands with `$` instead of `/` (`$summon`, `$haunt`, `$commence-haunt`).
Drop the "Commit …" line when nothing was written (Keep on an already-connected repo). Then add
one line: "Running whole Rites (milestones) as automated waves is off for now — ask me to turn on
rites when you want it." (Turning it on: `init --force --seance <id> --org-id <id> --org-name <name> --rites`,
which also renders the workflows; say they then need committing.)

## Never

- Never print, read aloud, or copy an API key, and never ask the user to paste one.
- Never write the bare `GHOST_HUNTING_API_KEY` into any file — only `ghost-kit login` writes keys.
- Never edit `.claude/settings.json` by hand; `init` merges without clobbering.
- Never create a Séance or Haunting before the user says yes.
