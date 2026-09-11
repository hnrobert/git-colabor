# git-colabor

**`git colabor`** — switch the Git **committer + pusher identity** and **SSH key** per repository, and manage git-mob-style **co-authors**, from one CLI.

This is the CLI half of Git Colabor. A VS Code extension ([`vscode-git-colabor`](https://github.com/hnrobert/vscode-git-colabor)) bundles this binary and drives it over its `--json` interface — but the CLI is fully standalone and scriptable.

---

## Why (requirements in one paragraph)

You share a machine — a lab workstation, a pair-programming box, a Remote-SSH server, a Codespace. Multiple people (or one person with work / personal / student accounts) commit and push from it. Git's `user.name` / `user.email` / `core.sshCommand` are global-or-manual, so identity bleed is one forgotten `git config` away: commits attributed to the wrong person, pushes with the wrong key, and no trace of *who set what, when*. Meanwhile, pairing sessions need `Co-authored-by:` trailers, which git has no workflow for at all. `git-colabor` treats identity as explicit, per-repo, auditable state — and makes co-author selection a one-liner.

## Features

- **Identities** — named `{ name, email, SSH key }` profiles; `identity use` writes `user.name`, `user.email`, and `core.sshCommand` for the current repo, loads the key into `ssh-agent`, and snapshots prior config so `revert` can restore it.
- **Co-authors** — select people from a `.git-coauthors` catalogue (git-mob-compatible JSON); trailers are seeded into the commit template and stay in sync.
- **Safe key handling** — private keys are referenced in place (never copied or modified), passphrases never appear on `argv` / `ps` (SSH_ASKPASS bridge, optional `--passphrase-command`), a broken key reference degrades to a key-less apply.
- **Coordination** — advisory `heldBy` session locking warns when a second session (another terminal, another VS Code window) is about to override the repo identity; nothing is ever silently clobbered.
- **Audit trail** — every identity action is appended to a local JSONL audit log (fingerprint only — never key bodies or passphrases).
- **Machine-friendly** — every command supports `--json` with a stable envelope and documented exit codes.

## Install

Requires **Node.js >= 24**.

```bash
npm install -g git-colabor        # once published (M6)
# or from source:
git clone git@github.com:hnrobert/git-colabor.git && cd git-colabor
pnpm install && pnpm build && npm link
```

Git finds `git-colabor` on your `PATH`, so the command becomes **`git colabor …`**.

## Quick start

```bash
# 1. Create identities (work + personal, one with an SSH key)
git colabor identity add --name "Robert He" --email robert@work.io --default
git colabor identity add --name "Robert" --email me@personal.io \
    --key ~/.ssh/id_ed25519_personal

# 2. Use one in the current repo
git colabor identity use id_a1b2c3d4      # from `identity ls`

# 3. Pairing: add a co-author and select them for this repo
git colabor coauthor add jd "Jamie Doe" jamie@example.com
git colabor coauthor use jd               # trailers go into .gitmessage

git commit                                # Co-authored-by: trailer included

# 4. Done pairing / leaving the repo
git colabor coauthor solo
git colabor identity revert               # restore pre-tool git config
```

## Command reference

### `git colabor coauthor …`

| Command | Effect |
| --- | --- |
| `coauthor ls [filter]` | List catalogue entries (key / name / email); optional substring filter. |
| `coauthor use <key…>` | Select co-authors for the current repo (no args: print current selection). |
| `coauthor solo` | Clear the selection. |
| `coauthor print [-i]` | Print `Co-authored-by:` trailer blob (`-i`: comma-joined keys instead). |
| `coauthor add <key> "Name" <email>` | Add to `.git-coauthors`. |
| `coauthor suggest [filter]` | Suggest co-authors from `git shortlog` history; interactive pick without `--json`. |

Selecting co-authors rewrites the commit template (`commit.template` / `~/.gitmessage`): all existing `Co-authored-by:` trailers are stripped and the current selection re-appended — the same behavior as git-mob's message formatter.

### `git colabor identity …`

| Command | Effect |
| --- | --- |
| `identity ls` | List identities; `*` marks the default; shows key fingerprint. |
| `identity use <id>` | Apply identity to the current repo (config + agent + state). Flags: `--source cli\|ext`, `--as-name`, `--as-email` (override committer fields), `--no-override` (refuse to take over a repo held by another session → exit 6). |
| `identity add` | `--name`, `--email` (required); `--key <path>` (import), `--passphrase-command <cmd>`, `--host`, `--default`. |
| `identity rm <id>` | Remove from the identity map (logs out first, best-effort). |
| `identity logout [id]` | Remove key from `ssh-agent` — the key file itself is never touched; repo stays configured (use `revert` for that). |
| `identity revert` | Restore the repo's pre-tool `user.*` / `core.sshCommand` / `commit.template` from the first-touch backup, clear markers. |
| `identity status` | Per-repo snapshot: active identity, managed markers, `heldBy`, selected + available co-authors. |
| `identity audit` | `--repo <path>`, `--since <date>`, `--tail <n>` filters over the audit log. |
| `identity doctor` | Self-check: binaries, identity map, key dir, agent, askpass bundle, repo markers. |

### Global flags & exit codes

| Flag | Effect |
| --- | --- |
| `--json` | Machine-readable output (see below). |
| `-C <path>` | Run as if in `<path>`. |
| `--log-level <level>` | CLI debug log level (also env `GIT_COLABOR_LOG_LEVEL`). |
| `--no-color` | Accepted; output is color-free by default. |
| `-h` / `-v` | Help / version. |

| Exit code | Meaning |
| --- | --- |
| 0 | success |
| 1 | runtime / internal error |
| 2 | usage error, invalid email |
| 3 | not inside a git repository |
| 4 | secret unavailable (no passphrase could be obtained) |
| 5 | not found (author / identity), duplicate key |
| 6 | conflict blocked (`--no-override` with a live `heldBy`) |

### JSON envelope

Every command accepts `--json` and prints one compact line:

```json
{"ok":true,"data":{…},"warnings":[{"code":"…","message":"…"}]}
{"ok":false,"error":{"code":"NOT_FOUND","message":"…","hints":[],"exitCode":5},"data":null}
```

This is the contract the VS Code extension consumes.

## What it writes on disk

| Path | Purpose | Mode |
| --- | --- | --- |
| `~/.config/git-colabor/identities.json` | Identity map (referenced key paths + fingerprints; env `GIT_COLABOR_MAP`) | `0600` |
| `~/.config/git-colabor/audit.log` | JSONL audit trail | `0600` |
| `<git-dir>/colabor/state.json` | Per-repo state: active identity, `heldBy`, config backups | `0600` |
| `.git-coauthors` (repo, else `~/.git-coauthors`) | Co-author catalogue, git-mob-compatible JSON | — |
| `~/.gitmessage` (or `commit.template`) | Commit template seeded with trailers | — |

(Windows: the data dir is `%APPDATA%\git-colabor`.)

Git config keys **written locally** per repo: `user.name`, `user.email`, `core.sshCommand` (only when the identity has a key: `ssh -i <key> -o IdentitiesOnly=yes`), and — with a usable key — SSH commit signing (`commit.gpgsign=true`, `gpg.format=ssh`, `user.signingKey=<key path>`; switched to a key-less identity clears them), `colabor.managed=true`, `colabor.managed-by=cli|ext`, and multi-valued `colabor.selected` (`Name <email>` per co-author). `commit.template` is set **globally** only if unset in any scope.

## git-mob compatibility

- Same `.git-coauthors` **JSON** format (`{"coauthors": {"jd": {"name": …, "email": …}}}`) and same 3-tier resolution (env → repo → home).
- Same trailer format `Co-authored-by: NAME <EMAIL>` and template rewrite semantics; same shortlog-derived key generation (`rkrk` for "Richard Kotze" `<rkotze@…>`).
- Does **not** read or write git-mob's `git-mob.co-author` config — the two tools can coexist.

## Security notes

- Private keys are **referenced in place** — the tool never copies, modifies, or deletes them; your file layout and permissions are entirely yours. Importing an unencrypted key raises a warning; a key file that later disappears degrades the identity to key-less with a `key-missing` warning.
- Passphrases are resolved via, in order: the extension's askpass socket bridge → `passphrase-command` → interactive tty prompt. They never appear on `argv`, in `ps`, or in any log (redaction is unit- and e2e-tested).
- The audit log records fingerprints and session metadata only.

Full threat model: [docs/SECURITY.md](../docs/SECURITY.md) in the extension repo.

## Environment variables

| Variable | Overrides |
| --- | --- |
| `GIT_COLABOR_MAP` | identity map path |
| `GIT_COLABOR_AUDIT_FILE` | audit log path |
| `GIT_COLABOR_COAUTHORS_PATH` | `.git-coauthors` path |
| `GIT_COLABOR_MESSAGE_PATH` | commit template path |
| `GIT_COLABOR_LOG_FILE` / `GIT_COLABOR_LOG_LEVEL` | CLI debug log |
| `GIT_COLABOR_ASKPASS_SOCK` / `GIT_COLABOR_ASKPASS_TOKEN` | askpass bridge endpoint (set by the extension) |

## Library

`dist/index.cjs` exports the full core (26 modules): author store, co-author state, identity map/keys/agent/apply/revert/logout, repo state & coordination, git exec/config, message formatter, audit, paths, errors — everything except the CLI layer.

```js
const { loadIdentityMap, applyIdentity, setSelected } = require('git-colabor');
```

## Development

```bash
pnpm install
pnpm typecheck && pnpm lint
pnpm test            # 40 unit tests
pnpm test:e2e        # 15 e2e tests against real git + ssh-keygen in tmp dirs
pnpm build           # tsup → dist/{cli,index,askpass}.cjs (node24, zero deps)
```

Contributions follow the AIM standards — see [CONTRIBUTING.md](../CONTRIBUTING.md) in the extension repo.

## License

MIT — see the [extension repo](https://github.com/hnrobert/vscode-git-colabor).
