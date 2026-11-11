---
name: validate-haunt
description: Quick, read-only acceptance check of ONE pull request against its ghost and EVERY wisp at the PR's head commit. Each acceptance criterion and fix step is judged met, partly, not met or can't tell by reading, with a cited line. It posts one Validation EVP on the ghost and prints a one-line verdict (PASS / GAPS / INCOMPLETE) plus the must-fix list for the session that built the PR. It runs no tests, servers, installs or browsers. Use when the user says "validate haunt", "validate the PR", "validate PR #N", "does PR #N meet its ghost", "check the PR against the ghost", "acceptance check", or when a build session reports "PR opened".
---

# Validate Haunt

## Codex host

When running in Codex, apply the [Codex host adapter](../../runtime/CODEX.md)
before the steps below. It maps skill/agent/workflow calls to Codex while
preserving these instructions, result contracts, and gates. Claude follows its
existing execution path.

An independent check of one pull request against what its ghost and wisps wrote
down. It answers "can I merge this?" in one line.

- **Read-only.** It reads the PR's head commit in a detached tree it pins and then
  removes. It runs no tests, servers, installs, migrations or browsers, and it
  edits nothing, so it is safe beside sessions running test suites.
- **Pinned model.** One Opus judge (effort xhigh) reads and judges. Fable is never
  used, whatever this session runs on. On a ghost of 9 to 13 units a round 1
  takes about 5 to 6 minutes and a brief round 2 about 2. The EVP's Run line
  says how long each run took.
- **Evidence up front.** Prep hands the judge one pack in its prompt: the PR,
  every unit's text and the whole diff with line numbers. For anything else the
  judge has one command, `look`, that takes many file ranges and searches per
  call. (A judge left to read one range at a time spent most of a run fetching.)
- **Scripted verdict.** A script decides the verdict from cited, re-checked
  evidence. A dead agent never yields PASS.
- **No key in prompts.** The prep script makes every Ghost Hunting and GitHub
  call; agents only read files.

**Invocation input** means the user's text after `/validate-haunt` (Claude) or
`$validate-haunt` (Codex). On a host that expands `$ARGUMENTS`, that expansion is
the same input. Never require literal `$ARGUMENTS` expansion.

Arguments provided: `$ARGUMENTS`

## Forms and flags

| Command | What it resolves |
|---|---|
| `/validate-haunt <ghost-id>` | the ghost's open PR: branch `ext/ch<id>`, `Ghost: <uuid>` in a PR body, or its linked PRs |
| `/validate-haunt --pr N` | the ghost from the PR: its branch, `Ghost: <uuid>` in the body, `ghost <id>:` commit subjects |
| `/validate-haunt <ghost-id> --pr N` | both given; a PR that does not name the ghost is a warning |

- `--base <ref>` judges a stacked PR against its parent, so the parent's work is
  not reported as this PR's. Prep detects the common cases and tells you the sha.
- `--round 2` checks the builder's fixes after it replies `fixed <sha>`. It is brief
  by default: one Opus agent re-judges round 1's must-fix items, reads everything
  changed since round 1, and checks what those changes touch. `--full` re-runs
  the whole check instead.
- `--double-check` adds a second Opus reader that searches harder on every
  must-fix and overturns one only with a citation. It adds 2–3 minutes. In
  testing it overturned none of about 45, so it is off by default.
- `--ask "<question>"` (up to 5) hands the judge something specific to settle,
  for example "the PR body says a live journey refuses unrelated edits; does
  it?". Each answer comes back yes, no or can't tell, with the code that
  settles it, in its own EVP section. The hand checks got their best findings
  this way.
- `--judges N` (1 to 3) splits a round 1 between N judges that run at once. Each
  owns a share of the units and sees the whole PR. Two take about a minute less
  on a large ghost and cost roughly half as much again. The default is one.
- `--effort high` runs the judges at high effort, not xhigh. It takes about
  half the time. In testing it found the same gaps but graded one borderline
  acceptance criterion a note where xhigh called it a must-fix, so xhigh is the
  default.
- `--no-post` writes the EVP locally and posts nothing.

Repo settings in `.ghost/config.json` → `validate` (all optional):

- `rules`: rule files, such as `.ghost/tenets.md`, that an extra Opus pass checks
  the changed lines against.
- `wording: true`: for a repo whose owner approves user-visible copy. Each line
  of the PR body's wording list is checked against the code (matches, differs or
  not found), and the sentences the diff adds that the list leaves out are
  listed.
- `judges` and `effort`: the repo's standing choice for the two flags above.
- `--local` targets the local API. It is honored only when `.ghost/config.json`
  sets `api.allow_local_switch: true`: `export GK_LOCAL=1` before Phase 0.

A ghost id may be a full id or an 8+ character prefix. Passing a wisp validates
that wisp alone.

## Phase 0 — Bootstrap

Run the canonical Phase-0 block (if `--local` was given and is allowed, `export GK_LOCAL=1` first):

```bash
# ── Ghost-kit Phase 0 (canonical — edit PHASE0.md first) ──
# A line starting "STOP:" (exit code 3) means STOP: relay that line to the user as-is and run
# nothing else. Never go looking for an API key anywhere this block did not look.
command -v jq >/dev/null 2>&1 || { echo "STOP: ghost-kit needs jq, which is not installed on this computer. Install it (macOS: brew install jq; Linux: your package manager), then try again."; exit 3; }
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
CFG="$REPO_ROOT/.ghost/config.json"
cfg() { [ -f "$CFG" ] && jq -r "$* // empty" "$CFG" 2>/dev/null || true; }

GK_AUTH=prod
API_BASE=$(cfg '.api.base'); API_BASE=${API_BASE:-https://backend-production-ea01.up.railway.app}
if [ "${GK_LOCAL:-0}" = "1" ] && [ "$(cfg '.api.allow_local_switch')" = "true" ]; then
  GK_AUTH=local; API_BASE=$(cfg '.api.local_base'); API_BASE=${API_BASE:-http://localhost:8000}
fi
KEY_VAR=$(cfg ".auth.$GK_AUTH.env_var"); KEY_VAR=${KEY_VAR:-GHOST_HUNTING_API_KEY}
ENV_FILES=$(cfg ".auth.$GK_AUTH.env_files[]"); ENV_FILES=${ENV_FILES:-.env}
CFG_ORG_ID=$(cfg ".auth.$GK_AUTH.org_id"); CFG_ORG_NAME=$(cfg ".auth.$GK_AUTH.org_name")

# Key lookup, in the SAME order as runtime/project.mjs credential() and the engines:
# 1 the env var, 2 this checkout's env_files, 3 the main checkout's (same key name only),
# 4 ONLY when the config names org_id: the per-user file, by GHOST_HUNTING_API_KEY__<ORG8>.
# A config without org_id keeps the legacy ~/.claude/.env instead. Never evaluate .env as shell.
gk_key() { sed -n -e 's/^[[:space:]]*//' -e 's/^export[[:space:]][[:space:]]*//' -e "s/^$GK_K=//p" "$*" 2>/dev/null | head -n 1 | tr -d "\"'[:space:]"; }
TALISMAN=$(printenv "$KEY_VAR" 2>/dev/null || true); KEY_SRC=${TALISMAN:+the $KEY_VAR environment variable}
GK_K=$KEY_VAR
for f in $(printf '%s\n' "$ENV_FILES"); do
  [ -z "$TALISMAN" ] && TALISMAN=$(gk_key "$REPO_ROOT/$f") && [ -n "$TALISMAN" ] && KEY_SRC="$REPO_ROOT/$f"
done
# Linked worktrees do not carry ignored .env files. Only fall back to THIS git
# repository's main checkout, and only if it configures the same key name.
MAIN_ROOT=$(git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
MAIN_KEY=$(jq -r --arg local "${GK_LOCAL:-0}" 'if $local == "1" and .api.allow_local_switch then .auth.local.env_var else .auth.prod.env_var end // empty' "$MAIN_ROOT/.ghost/config.json" 2>/dev/null)
if [ -z "$TALISMAN" ] && [ "$MAIN_KEY" = "$KEY_VAR" ] && [ "$MAIN_ROOT" != "$REPO_ROOT" ]; then
  for f in $(printf '%s\n' "$ENV_FILES"); do
    [ -z "$TALISMAN" ] && TALISMAN=$(gk_key "$MAIN_ROOT/$f") && [ -n "$TALISMAN" ] && KEY_SRC="$MAIN_ROOT/$f"
  done
fi
GHOST_USER_ENV="${XDG_CONFIG_HOME:-$HOME/.config}/ghost-hunting/.env"
ORG8=$(printf '%s' "$CFG_ORG_ID" | cut -c1-8 | tr '[:lower:]' '[:upper:]')
if [ -z "$TALISMAN" ] && [ -n "$CFG_ORG_ID" ]; then
  GK_K="GHOST_HUNTING_API_KEY__$ORG8"; TALISMAN=$(gk_key "$GHOST_USER_ENV"); [ -n "$TALISMAN" ] && KEY_SRC="$GHOST_USER_ENV"
fi
if [ -z "$TALISMAN" ] && [ -z "$CFG_ORG_ID" ]; then
  GK_K=$KEY_VAR; TALISMAN=$(gk_key "$HOME/.claude/.env"); [ -n "$TALISMAN" ] && KEY_SRC="$HOME/.claude/.env"
fi
AUTH="Authorization: Bearer $TALISMAN"
KEY_SHOW=$KEY_SRC
case "$KEY_SRC" in "$REPO_ROOT"/*) KEY_SHOW="./${KEY_SRC#"$REPO_ROOT"/}" ;; "$HOME"/*) KEY_SHOW="~/${KEY_SRC#"$HOME"/}" ;; esac

# The version of the PROSE you are executing — stamped at release by
# scripts/ghost-kit-release.sh. Deliberately NOT read from disk: a session loads skill
# text once at start and holds it, so a runtime read reports what is on disk NOW, not
# what is running. That is how a session executing v1.3.7 reported plugin/1.4.0.
PLUGIN_VERSION="1.12.0"
GK_ROOT="${GHOST_KIT_ROOT:-${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}}"
[ -z "$GK_ROOT" ] && [ -x "$REPO_ROOT/.ghost/bin/resolve-plugin" ] && GK_ROOT=$("$REPO_ROOT/.ghost/bin/resolve-plugin" 2>/dev/null)
GK_SRC=$(jq -r '.["ghost-kit"].installLocation // empty' "$HOME/.claude/plugins/known_marketplaces.json" 2>/dev/null)
# Loud, local, and it CAN fire: prose (above) vs the newest ghost-kit on disk.
GK_DISK=$(setopt nonomatch 2>/dev/null || true
  jq -r '.version // empty' \
  "$GK_ROOT/.claude-plugin/plugin.json" \
  "$REPO_ROOT/plugins/ghost-hunting-core/.claude-plugin/plugin.json" \
  "$GK_SRC/plugins/ghost-hunting-core/.claude-plugin/plugin.json" \
  "$HOME"/.claude/plugins/cache/ghost-kit/ghost-hunting-core/*/.claude-plugin/plugin.json \
  "$HOME"/.codex/plugins/cache/*/ghost-hunting-core/*/.codex-plugin/plugin.json \
  "$HOME"/.codex/plugins/cache/*/ghost-hunting-core/*/.claude-plugin/plugin.json \
  "$HOME"/.codex/plugins/cache/*/ghost-hunting-core/*/plugin.json \
  2>/dev/null | sed 's/+.*//' | sort -V | tail -1)
[ -n "$GK_DISK" ] && [ "$GK_DISK" != "$PLUGIN_VERSION" ] && \
  echo "⚠ ghost-kit: this session runs v$PLUGIN_VERSION prose; v$GK_DISK is on disk — refresh ghost-hunting-core for this host, then RESTART"
REPO_SLUG=$(cfg '.repo'); REPO_SLUG=${REPO_SLUG:-$(basename "$REPO_ROOT")}
WF_STAMP=$(jq -r '.bundle // empty' "$REPO_ROOT/.ghost/sync-state.json" 2>/dev/null)
GH_CLIENT="X-Ghost-Client: plugin/${PLUGIN_VERSION:-0.0.0} repo/$REPO_SLUG skill/validate-haunt${WF_STAMP:+ wf/$WF_STAMP}"

[ -n "$TALISMAN" ] || { echo "STOP: There is no Ghost Hunting API key on this computer for this repo${CFG_ORG_NAME:+ ($CFG_ORG_NAME)}. Type /ghost-onboard to connect."; exit 3; }
ME_RAW=$(curl -s --max-time 30 -w '\n%{http_code}' "$API_BASE/api/agent/me" -H "$AUTH" -H "$GH_CLIENT")
ME_HTTP=$(printf '%s' "$ME_RAW" | tail -n 1); ME=$(printf '%s' "$ME_RAW" | sed '$d')
case "$ME_HTTP" in
  401|403) echo "STOP: Ghost Hunting rejected the API key from $KEY_SHOW — revoked or expired. Type /ghost-onboard to reconnect."; exit 3 ;;
  000) echo "STOP: Could not reach Ghost Hunting at $API_BASE. Check your connection, then try again."; exit 3 ;;
  200) ;;
  *) echo "⚠ Ghost Hunting answered HTTP $ME_HTTP for the identity check; continuing." ;;
esac
ME_ORG=$(printf '%s' "$ME" | jq -r '.org_id // empty' 2>/dev/null)
if [ "$ME_HTTP" = 200 ] && [ -n "$CFG_ORG_ID" ] && [ "$ME_ORG" != "$CFG_ORG_ID" ]; then
  echo "STOP: You're signed in to $(printf '%s' "$ME" | jq -r '.org_name // "a different Coven"' 2>/dev/null), but this repo belongs to ${CFG_ORG_NAME:-Coven $CFG_ORG_ID}. The API key from $KEY_SHOW is for the wrong Coven (organization). Type /ghost-onboard to connect to ${CFG_ORG_NAME:-the right one}."; exit 3
fi
echo "$ME" | jq -r '"agent: \(.name)  contract: \(.client_contract.status // "unknown")"'
echo "$ME" | jq -r '.client_contract.message // empty'
# ── End Ghost-kit Phase 0 ──
```

Preflight verdict: `unsupported` → STOP and tell the user to update ghost-kit; `outdated` → print
the message and continue.

Then locate the engine and the script. Refuse loudly; never fall back:

```bash
MAIN=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
ENGINE="$MAIN/.claude/workflows/validate.js"
[ -n "$GK_ROOT" ] && [ -f "$GK_ROOT/scripts/validate-prep.mjs" ] || echo "STOP: ghost-kit root not found (GK_ROOT='$GK_ROOT')"
PREP="$GK_ROOT/scripts/validate-prep.mjs"
[ -f "$ENGINE" ] || echo "STOP: $ENGINE missing — add \"validate\" to .ghost/config.json workflows.vendor, run ghost-hunting-core:ghost-sync, commit"
HDR=$(sed -n '1p' "$ENGINE"); SYNC=$(jq -r '"v\(.plugin_version) (bundle \(.bundle))"' "$MAIN/.ghost/sync-state.json" 2>/dev/null)
case "$HDR" in *"$SYNC"*) echo "engine: $HDR";; *) echo "STOP: engine stamp '$HDR' does not match sync-state $SYNC — run ghost-sync";; esac
command -v gh >/dev/null && command -v node >/dev/null || echo "STOP: gh and node are required"
```

Any `STOP` line ends the skill with that message.

## Phase 1 — Prep (script, no model)

```bash
node "$PREP" prep <ghost-id> [--pr N] [--base REF] [--round N [--full]] [--double-check] [--ask "question" …] [--judges N] [--effort high] [--local] --engine "$ENGINE"
```

If the agent type `ghost-hunting-core:validate-leaf` is not available in this
session, add `--leaf-agent-type ''`.

It resolves the PR and the ghost, fetches the PR head into its own ref, pins a
detached tree at that commit under `.ghost/validations/<run>/tree`, picks the
base, snapshots the ghost and every wisp, and composes the engine. It prints one
JSON object: `run`, `script`, `args_file`, the units, the estimate and `warnings`.

- **Exit 5** (ambiguous, or a stacked PR): show the candidates, or the parent
  commits and the suggested `--base <sha>`. Ask which, then re-run.
- **Exit 3** (refused): the round limit, nothing to validate (already merged), or
  too many units for one run. Relay the message and stop.
- **Exit 7** (API errors): STOP and show them. A bundle with holes would read a
  missing EVP or wisp as a fact.
- Show every warning in one short list. Do not ask to launch; the run is small.

## Phase 2 — Run the workflow

- **Claude:** `Workflow({scriptPath: "<script>"})` with no args (they are
  embedded). It runs in the background; wait for its notification. Then save the
  result **verbatim** from the Workflow task's output file, never from the
  notification text (which is truncated and HTML-escaped):
  `jq '.result | if type=="string" then fromjson else . end' <output file> > "<run>/result.json"`
- **Codex:** `.ghost/bin/run-workflow --workflow validate --args-file "<args_file>" --repo "<run>/tree" > "<run>/result.json"`.
  Always redirect stdout: the redirect is the verbatim save.

## Phase 3 — Finish (script)

```bash
node "$PREP" finish --run "<run>"
```

It checks the result's checksum and that the pinned tree is untouched. It
anchors every citation in the tree by its quote, applies the verdict rules,
renders `<run>/evp.md` and `<run>/final.json`, and removes the tree.

- **Exit 4:** the saved result does not match its checksum. Re-save it verbatim
  (Phase 2), then run finish again. Never retype it.
- **Exit 6:** the pinned tree changed during the run, so an agent broke the
  read-only rule. STOP, show the paths, and offer one re-run. Post nothing.

The verdict:

| Verdict | Meaning |
|---|---|
| **PASS** | Every criterion and fix step of every built unit is met, with a citation that held. Notes, items deferred to a wisp left open, wisps not in this PR, untested items and the walk-by-hand list are shown but do not block. |
| **GAPS** | At least one must-fix item: the unit's text requires it and the code is missing or wrong, or a named rule's blocker. |
| **INCOMPLETE** | The check could not be finished: an agent died, an item went unverified or over the cap, or a unit could not really be read. |

## Phase 4 — Post

Unless `--no-post`:

```bash
node "$PREP" post --run "<run>"
```

It posts `<run>/evp.md` on the ghost, and skips when an EVP with the same
validation line is already there (a retried post would duplicate).

## Phase 5 — Report

Show the EVP's **Must fix** section when there is one, then end with the
**headline** finish printed, as the last line. For example:
`PR #549 · GAPS · 2 must-fix (a4034449.FS4, e897b739.FS2) · 5 note(s) · 6 to walk by hand · head 12fd34d6`.
Add nothing else unless asked.

The Must fix section is the fix list. It already ends with the rule for the
builder: fix only these, do not grow the scope, reply `fixed <sha>` or
`disputed <id>: why`. To hand it to the session that built the PR, tell that
session to read the validation EVP on the ghost. The EVP is the record, and it
survives a cleared session.

## The fix loop

- **`fixed <sha>`:** run `/validate-haunt <ghost-id> --pr N --round 2`. One Opus
  agent does four things at the new head:
  - re-judges each of round 1's must-fix items;
  - reads the whole diff since round 1;
  - checks who else uses any shared module that diff changed;
  - searches the files the PR changes for other instances of each round-1 gap,
    and checks what the PR body says the fixes did.

  Its short EVP marks each item fixed, partly fixed or not fixed, lists anything
  new, and carries round 1's walk-by-hand list forward. Round 1's EVP stays the
  full record. Pass `--full` when the change since round 1 is large; prep also
  runs in full by itself when the PR was rewritten or round 1's result is not on
  this machine.
- After round 2 the open items go to the Hunter. The skill refuses a round 3.
- **`disputed <id>: why`:** goes to the Hunter. Never send it back to the
  builder, and never re-run to settle it.

## Error handling

- Never run tests, servers, installs, migrations or a browser. Never edit the
  pinned tree. Never post an EVP for a run whose finish failed.
- Finish removes the tree on success. Prep prunes trees from finished or
  day-old runs. To clear one by hand: `git worktree remove --force <run>/tree`.
- API 401/403 at prep means the key is wrong for this repo. Never borrow
  another repo's key.
