#!/usr/bin/env bash
# reckoning-bus.sh — the ONLY way a /reckoning leaf writes anything, and the skill's run plumbing.
#
# The reckoning workflow runs in a sandbox with no filesystem, so everything that must outlive an
# agent's return value (a finder's findings, a warden's themes, the Arbiter's Scroll) is written by an
# agent through this script. (A Part's sealed decisions are returned instead, and written by
# `reckoning-prep.mjs record` after it re-checks the engine's checksum.) It exists so those writes are
# ATOMIC and VERIFIABLE instead of "whatever the model typed into a file":
#
#   commit  <bus> <key> <stub.json> [detail.md]  validate the stub, move the detail into place, write
#                                                <key>.stub.json LAST (it is the completion marker and
#                                                carries the detail's sha256); prints a receipt.
#   check   <bus>                                list complete keys (stub valid, detail sha matches);
#                                                a dead leaf's half-written file never reads as done.
#   lock    <run_dir> acquire|heartbeat|release|status [--force]
#                                                one reckoning per run dir, judged by heartbeat age;
#                                                never silently stolen (pass --force after checking).
#   compose <vendored.js> <args.json> <out.js>   copy the vendored engine with its args embedded as
#                                                a const after the meta block, so a Claude Workflow
#                                                run never needs the model to retype large args.
#   lint-imprints <draft.json>                   measure Imprint titles/content against the API caps
#                                                (models miscount lengths; exit 3 lists the violations).
#   djb2    < content                            print the djb2 the engine uses (for the skill).
#
# Portable: bash 3.2 + BSD tools (macOS) and GNU/Linux. node (>=22) does the hashing and JSON work.
set -uo pipefail

die() { echo "reckoning-bus: $*" >&2; exit "${EXIT_CODE:-2}"; }
need_node() { command -v node >/dev/null 2>&1 || die "node is required"; }
sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }
valid_key() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$'; }

cmd="${1:-}"; shift || true
case "$cmd" in
  commit)
    [ $# -ge 3 ] || die "usage: commit <bus> <key> <stub.json> [detail.md]"
    bus="$1"; key="$2"; stub="$3"; detail="${4:-}"
    valid_key "$key" || die "invalid key '$key' (letters, digits, . _ - only; no slashes)"
    [ -f "$stub" ] || die "stub file not found: $stub"
    mkdir -p "$bus" || die "cannot create bus dir $bus"
    need_node
    detail_sha="null"
    [ -z "$detail" ] || [ -f "$detail" ] || die "detail file not found: $detail"
    # Validate the stub BEFORE touching the detail: a rejected re-commit must leave the previous
    # detail + stub pair intact, never a new detail beside an old stub.
    tmps="$bus/.$key.stub.$$"
    tmpd="$bus/.$key.md.$$"
    if [ -n "$detail" ]; then cp "$detail" "$tmpd" || die "cannot stage detail"; detail_sha="\"$(sha256 "$tmpd")\""; fi
    DETAIL_SHA="$detail_sha" KEY="$key" node -e '
      const fs = require("fs");
      let o;
      try { o = JSON.parse(fs.readFileSync(0, "utf8")); } catch (e) { console.error("stub is not valid JSON: " + e.message); process.exit(3); }
      if (!o || typeof o !== "object" || Array.isArray(o)) { console.error("stub must be a JSON object"); process.exit(3); }
      o._key = process.env.KEY; o._detail_sha = JSON.parse(process.env.DETAIL_SHA);
      process.stdout.write(JSON.stringify(o));
    ' < "$stub" > "$tmps" || { rm -f "$tmps" "$tmpd"; EXIT_CODE=3 die "stub rejected (see above) — fix the JSON and re-run the same command"; }
    if [ -n "$detail" ]; then mv -f "$tmpd" "$bus/$key.md" || die "cannot place detail"; fi
    mv -f "$tmps" "$bus/$key.stub.json" || die "cannot place stub"
    items=$(node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const a=Object.values(o).find(Array.isArray); process.stdout.write(String(a?a.length:0))' "$bus/$key.stub.json")
    printf '{"key":"%s","stub_sha":"%s","detail_sha":%s,"items":%s}\n' "$key" "$(sha256 "$bus/$key.stub.json")" "$detail_sha" "$items"
    ;;

  check)
    [ $# -ge 1 ] || die "usage: check <bus>"
    bus="$1"; [ -d "$bus" ] || { echo '{"complete":[],"broken":[],"orphan_details":[],"seals":[]}'; exit 0; }
    need_node
    BUS="$bus" node -e '
      const fs = require("fs"), path = require("path"), cp = require("child_process");
      const bus = process.env.BUS, names = fs.readdirSync(bus);
      const sha = (f) => cp.execFileSync(process.platform === "darwin" ? "shasum" : "sha256sum", process.platform === "darwin" ? ["-a", "256", f] : [f]).toString().split(" ")[0];
      const out = { complete: [], broken: [], orphan_details: [], seals: [] };
      for (const n of names) {
        if (n.endsWith(".seal.json")) { try { JSON.parse(fs.readFileSync(path.join(bus, n), "utf8")); out.seals.push(n.slice(0, -10)); } catch { out.broken.push({ key: n, why: "seal is not valid JSON" }); } continue; }
        if (!n.endsWith(".stub.json")) continue;
        const key = n.slice(0, -10);
        try {
          const o = JSON.parse(fs.readFileSync(path.join(bus, n), "utf8"));
          if (o._detail_sha) {
            const d = path.join(bus, key + ".md");
            if (!fs.existsSync(d)) { out.broken.push({ key, why: "detail missing" }); continue; }
            if (sha(d) !== o._detail_sha) { out.broken.push({ key, why: "detail sha mismatch" }); continue; }
          }
          out.complete.push(key);
        } catch (e) { out.broken.push({ key, why: "stub unreadable: " + e.message }); }
      }
      for (const n of names) if (n.endsWith(".md") && !names.includes(n.slice(0, -3) + ".stub.json")) out.orphan_details.push(n);
      process.stdout.write(JSON.stringify(out) + "\n");
    '
    ;;

  lock)
    [ $# -ge 2 ] || die "usage: lock <run_dir> acquire|heartbeat|release|status [--force]"
    run="$1"; action="$2"; force="${3:-}"; lockf="$run/lock"; host=$(hostname 2>/dev/null || echo unknown)
    mkdir -p "$run" || die "cannot create run dir $run"
    now=$(date +%s)
    case "$action" in
      acquire)
        # Liveness is the HEARTBEAT, not a pid: the skill runs each step in a fresh shell, so no pid
        # outlives it. The skill heartbeats before and after every Part; a Part can run for hours,
        # so a lock is "fresh" for RECKONING_LOCK_FRESH_S (default 8h). Never stolen silently.
        fresh=${RECKONING_LOCK_FRESH_S:-28800}
        if [ -f "$lockf" ] && [ "$force" != "--force" ]; then
          lhost=$(sed -n 's/.*"host":"\([^"]*\)".*/\1/p' "$lockf"); lbeat=$(sed -n 's/.*"heartbeat":\([0-9]*\).*/\1/p' "$lockf")
          age=$(( now - ${lbeat:-0} ))
          if [ "$age" -lt "$fresh" ]; then EXIT_CODE=4 die "run is locked (heartbeat ${age}s ago on $lhost): $lockf — another session may be running it. Pass --force only after confirming that session is gone."; fi
          EXIT_CODE=4 die "stale run lock (heartbeat ${age}s ago on $lhost): $lockf — confirm nothing is running it, then re-run with --force"
        fi
        printf '{"host":"%s","started":%s,"heartbeat":%s}\n' "$host" "$now" "$now" > "$lockf" || die "cannot write lock"
        echo "locked $lockf";;
      heartbeat)
        [ -f "$lockf" ] || die "no lock to heartbeat: $lockf"
        started=$(sed -n 's/.*"started":\([0-9]*\).*/\1/p' "$lockf")
        printf '{"host":"%s","started":%s,"heartbeat":%s}\n' "$host" "${started:-$now}" "$now" > "$lockf"; echo "heartbeat $now";;
      release) rm -f "$lockf"; echo "released $lockf";;
      status) if [ -f "$lockf" ]; then cat "$lockf"; else echo '{"locked":false}'; fi;;
      *) die "unknown lock action '$action'";;
    esac
    ;;

  compose)
    [ $# -ge 3 ] || die "usage: compose <vendored.js> <args.json> <out.js>"
    src="$1"; argsf="$2"; out="$3"
    [ -f "$src" ] || die "workflow not found: $src"; [ -f "$argsf" ] || die "args file not found: $argsf"
    need_node
    SRC="$src" ARGS="$argsf" node -e '
      const fs = require("fs");
      const text = fs.readFileSync(process.env.SRC, "utf8");
      const args = JSON.parse(fs.readFileSync(process.env.ARGS, "utf8"));
      // meta ends at the first line that is exactly "};" after "export const meta" — the vendored
      // file keeps its header comment and meta block byte-identical; only a const is inserted.
      const start = text.indexOf("export const meta");
      if (start < 0) { console.error("no `export const meta` in " + process.env.SRC); process.exit(3); }
      const end = text.indexOf("\n};\n", start);
      if (end < 0) { console.error("could not find the end of the meta block"); process.exit(3); }
      const cut = end + 4;
      process.stdout.write(text.slice(0, cut) + "const __RECKONING_ARGS__ = " + JSON.stringify(args) + ";\n" + text.slice(cut));
    ' > "$out.tmp.$$" || { rm -f "$out.tmp.$$"; die "compose failed"; }
    mv -f "$out.tmp.$$" "$out" && echo "$out"
    ;;

  lint-imprints)
    # The API's Imprint limits, checked where the agent can still fix them: a checker or proposer
    # runs this on its draft BEFORE committing and gets exact lengths back (models do not count).
    [ $# -ge 1 ] || die "usage: lint-imprints <draft.json>   (a {ops:[...]} or {items:[...]} object)"
    [ -f "$1" ] || die "no such file: $1"
    need_node
    node -e '
      const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const TYPES = ["fact", "convention", "preference", "gotcha", "procedure"];
      const bad = [];
      const chk = (i, t, c, ty) => {
        const tl = String(t || "").length, cl = String(c || "").length;
        if (tl < 1 || tl > 200) bad.push({ index: i, field: "title", length: tl, limit: "1-200 characters" });
        if (cl < 1 || cl > 2000) bad.push({ index: i, field: "content", length: cl, limit: "1-2000 characters" });
        if (ty !== undefined && !TYPES.includes(ty)) bad.push({ index: i, field: "memory_type", value: ty, allowed: TYPES });
      };
      (o.ops || []).forEach((x, i) => {
        if (x.op === "supersede" || (x.op === "duplicate_of" && String(x.new_content || "").trim())) chk(i, x.new_title, x.new_content, x.new_type || undefined);
        if (x.op === "edit") {
          // an edit sends only what changes, so only the fields it carries are checked
          const tl = x.new_title === undefined ? null : String(x.new_title).length, cl = x.new_content === undefined ? null : String(x.new_content).length;
          if (tl !== null && (tl < 1 || tl > 200)) bad.push({ index: i, field: "new_title", length: tl, limit: "1-200 characters" });
          if (cl !== null && (cl < 1 || cl > 2000)) bad.push({ index: i, field: "new_content", length: cl, limit: "1-2000 characters" });
          if (x.new_type !== undefined && !TYPES.includes(x.new_type)) bad.push({ index: i, field: "new_type", value: x.new_type, allowed: TYPES });
          if (Array.isArray(x.new_tags) && (x.new_tags.length > 20 || x.new_tags.some((t) => !String(t).trim() || String(t).length > 50))) bad.push({ index: i, field: "new_tags", limit: "at most 20 tags of 1-50 characters" });
          if (Array.isArray(x.new_links) && x.new_links.length > 20) bad.push({ index: i, field: "new_links", limit: "at most 20 links" });
          if (x.new_scope !== undefined) bad.push({ index: i, field: "new_scope", limit: "an edit cannot change scope — use supersede" });
        }
      });
      (o.items || []).forEach((x, i) => chk(i, x.title, x.content, x.memory_type));
      process.stdout.write(JSON.stringify({ ok: !bad.length, violations: bad }) + "\n");
      process.exit(bad.length ? 3 : 0);
    ' "$1"
    ;;

  djb2)
    need_node
    node -e 'let s=require("fs").readFileSync(0,"utf8"); if (s.endsWith("\n")) s=s.slice(0,-1); let h=5381; for (let i=0;i<s.length;i++) h=((h*33)^s.charCodeAt(i))>>>0; process.stdout.write(h.toString(16).padStart(8,"0")+"\n")'
    ;;

  *) die "usage: reckoning-bus.sh commit|check|lock|compose|lint-imprints|djb2 …";;
esac
