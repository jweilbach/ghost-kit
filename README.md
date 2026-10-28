# ghost-kit

The [Ghost Hunting](https://ghosthunting.io) plugin for Claude Code (and Codex CLI): the
lifecycle skills — `/summon`, `/haunt`, `/commence-haunt`, `/review-haunt`, `/plan-haunt`,
`/forge-ritual`, `/invoke-ritual` and friends — that let a coding agent track its own work as
ghosts (tasks) in Ghost Hunting.

This repository is a published, read-only mirror of the plugin. Changes are made upstream and
released here as tagged versions.

## Quickstart

```bash
curl -fsSL https://github.com/jweilbach/ghost-kit/releases/latest/download/install.sh | bash
```

Then open Claude Code in your repo (restart it if it's already open) and type **/ghost-onboard**.

The installer adds this marketplace with auto-update on, installs `ghost-hunting-core`, and opens
your browser so you can create an account (or sign in) and click **Connect** — there is no API
key to copy. `/ghost-onboard` then links the repo to a Séance (portfolio) in one confirmation and
writes two small files you commit, so teammates are set up automatically.

## Manual install (two commands)

If you'd rather not pipe a script to bash:

```bash
claude plugin marketplace add https://github.com/jweilbach/ghost-kit.git
claude plugin install ghost-hunting-core@ghost-kit
```

Start (or restart) Claude Code in your repo and type `/ghost-onboard` — it does the browser
sign-in itself. To have new releases arrive on their own, turn on auto-update for `ghost-kit` in
`/plugin` → **Marketplaces**.

Prerequisites: Claude Code, git 2.31+, curl and jq. `gh` (pull requests) and Node 22+ (`/reckoning`,
Codex) are optional. `plugins/ghost-hunting-core/scripts/ghost-kit doctor --tools` checks them.

## Teammates

Commit the two files `/ghost-onboard` writes:

- `.ghost/config.json` — which Coven (organization) and Séance this repo tracks its work in.
- `.claude/settings.json` — adds this marketplace and enables the plugin (existing settings are kept).

A teammate who clones the repo trusts the folder, accepts Claude Code's prompt to install the
plugin (restarting if asked), and sees *"This repo tracks its work in Ghost Hunting (Acme), but this
computer isn't signed in. Type /ghost-onboard"*. One browser click later they're connected.

## Where your API key lives

`/ghost-onboard` (and `ghost-kit login`) stores the key in `~/.config/ghost-hunting/.env`
(directory `700`, file `600`) as `GHOST_HUNTING_API_KEY__<ORG8>` — named for the Coven it belongs
to, so a repo can never pick up another Coven's key. It is never printed and never written into a
repo. `ghost-kit status` shows which key a repo uses and from where; `ghost-kit logout` removes it
from this computer (revoke it on the Mediums page of the web app).

## Codex CLI

The same skills run in Codex. Clone this repository and run the setup once per machine, then once
per repo checkout (Node 22+):

```bash
git clone https://github.com/jweilbach/ghost-kit.git ~/ghost-kit
~/ghost-kit/plugins/ghost-hunting-core/scripts/ghost-setup.sh --install --write --repo /path/to/repo
```

Start a new Codex session and type `$ghost-onboard`. After a release, `git -C ~/ghost-kit pull`,
re-run the setup with `--install`, and start a new session.

## More

The full plugin documentation — configuration (`config.schema.json`), readiness checks, rites and
workflows — is in [`plugins/ghost-hunting-core/README.md`](plugins/ghost-hunting-core/README.md).

Released under the [MIT License](LICENSE).
