# Contributing to via

Thanks for helping out. Bug reports, fixes and improvements are all welcome.

## Ways to contribute

- **Bug reports:** open an issue with the via version, your OS, the client you
  used, and the smallest request that shows the problem. Leave out tokens and keys.
- **Feature requests:** open an issue describing what you need and why.
- **Pull requests:** fixes and improvements. For anything large, open an issue
  first so we can agree on the approach.

Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Setup

You need [Bun](https://bun.sh) 1.4.0 (pinned in `package.json`). Node 24 is only
needed for `bun run smoke`.

```sh
git clone https://github.com/nkootstra/via.git
cd via
bun install
bun apps/cli/src/index.ts --help   # run the CLI from source
```

## Commands

| Command                 | What it does                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `bun run check`         | Lint, format check, knip, typecheck and tests: everything CI gates on.                  |
| `bun run test`          | Tests (`@effect/vitest`, run as `bun --bun vitest run`).                                |
| `bun run typecheck`     | TypeScript 7 plus Effect diagnostics.                                                   |
| `bun run lint`          | oxlint, warnings are errors.                                                            |
| `bun run format`        | oxfmt. `format:check` only checks.                                                      |
| `bun run knip`          | Finds unused files, exports and dependencies.                                           |
| `bun run build`         | Compiles the binary, web UI included, for every package in `npm/`.                      |
| `bun run smoke`         | Installs the packed npm packages and runs them under Node.                              |
| `bun run prices:update` | Refreshes the model prices via ships with from models.dev and LiteLLM; review the diff. |

Never use `bun test`; it's a different test runner.

### The web UI

`apps/web` is the admin UI, which via serves at `/ui`. For a quick loop, run
via with an admin key in one terminal and Vite in another; Vite sends `/admin`
to via (or to `VIA_DEV_ADMIN_URL`), the `/admin/events` stream included:

```sh
VIA_ADMIN_KEY=$(openssl rand -hex 32) bun apps/cli/src/index.ts serve
bun run --cwd apps/web dev    # http://localhost:5173/ui/
```

In dev the page comes from Vite, which can't put via's state in it as via
does for a signed-in page, so the page fetches that state once when it loads
and then listens to `/admin/events` as it would in production.

The binary embeds the production build instead: `bun run --cwd apps/web build`
writes `apps/web/dist`, and `dist/embedded.ts` lists its files and the CSP
hashes of the shell's inline scripts. `bun run build`, `bun run test` and
`bun run smoke` build it first; run it yourself before `bun apps/cli/src/index.ts`
or `bun --bun vitest` in `apps/web`, `apps/cli` or `apps/e2e` straight.

The browser tests in `apps/e2e` drive Chromium through Playwright, against a
compiled binary only:

```sh
(cd apps/e2e && bunx playwright install chromium)   # once: e2e's version
bun run build
VIA_E2E_BIN=$PWD/npm/via-darwin-arm64/bin/via bun run --filter @via/e2e test
```

A failed browser test leaves a trace in `apps/e2e/test-results/`; open it with
`bunx playwright show-trace <file>`.

## How we work

- **Test first.** Every behaviour starts as a failing test. Write the least code
  that makes it pass, then refactor. Commit each green step.
- **Build only what's needed.** No speculative options, config keys or
  abstractions.
- **No real upstream calls in tests:** not to OpenAI, OpenCode Go or any
  other provider. Fake upstreams run as local HTTP servers and their base URLs
  are injected through layers.
- **Effect everywhere outside the CLI's `main`:** no `async`/`await`, `Promise`,
  `throw` or `try`/`catch` in library code. Parse external data with `Schema`,
  and use the `FileSystem`, `HttpClient` and `Clock` services.

[AGENTS.md](AGENTS.md) has the full conventions (services, errors, imports) and
the package layout. It's written for coding agents, but it's the reference for
everyone.

## Commit messages

Commit subjects and PR titles read `type(scope): subject`. CI checks both.

```
fix(pool): hand out a still-valid token without re-reading every account
feat(cli)!: rename --listen to --host
```

- **type** is one of the list below, lowercase.
- **scope** is required: one lowercase word or kebab-case name for the area,
  like `pool`, `cli`, `codex-upstream`, `ci` or `docs`.
- **`!`** after the scope marks a breaking change.
- **subject** follows `: ` and says what the change does.

| Type       | Use it for                             |
| ---------- | -------------------------------------- |
| `feat`     | New behaviour                          |
| `fix`      | A bug fix                              |
| `perf`     | A performance improvement              |
| `refactor` | Restructuring without behaviour change |
| `test`     | Adding or changing tests only          |
| `docs`     | Documentation only                     |
| `build`    | Build, packaging, dependencies         |
| `ci`       | CI workflows                           |
| `chore`    | Anything else that isn't user-visible  |
| `revert`   | Reverting an earlier commit            |

These fail:

```
Add account labels              # no type
fix: handle 429                 # no scope
Fix(pool): handle 429           # type must be lowercase
fix(Pool): handle 429           # scope must be lowercase
fix(pool):handle 429            # no space after the colon
Revert "fix(pool): handle 429"  # git's default; reword it to revert(pool): ...
```

## Signed commits

Every commit must be signed, and GitHub must show it as **Verified**. `main`
rejects anything else. SSH signing is the quickest to set up:

```sh
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
```

Then add the same public key on GitHub under **Settings → SSH and GPG keys** as
a **Signing key**. (An authentication key alone isn't enough.) GitHub's guide:
[About commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification).

To sign commits you already made on your branch:

```sh
git rebase --exec 'git commit --amend --no-edit -S' origin/main
git push --force-with-lease
```

## No AI attribution

Commits and PR descriptions carry no AI attribution: no `Co-authored-by`
trailers for bots or tools, and no "Generated with …" footers or badges.
Attribution is for people. Co-authoring a person is always fine.

CI rejects a co-author whose address belongs to a GitHub bot account or is a
`noreply@` mailbox on another domain (`dependabot[bot]` is allowed), plus known
generator footers. To fix the last commit, `git commit --amend` and delete the
lines; for earlier ones, reword them in a rebase onto `origin/main`. Then
`git push --force-with-lease`.

This repo's `.claude/settings.json` already stops Claude Code from adding them.

## Pull requests

1. Branch off `main`.
2. Keep the PR to one change.
3. Update the docs in the same PR when the change is something a user or
   contributor sees: `docs/README.md`, this file, `SECURITY.md` or `AGENTS.md`.
4. Fill in the PR template, and keep its Summary, Type of change and Checklist
   sections.
5. Link related issues with `Closes #N`.

These checks must pass:

| Check                                        | What it checks                                            |
| -------------------------------------------- | --------------------------------------------------------- |
| Lint & format                                | `bun run lint`, `bun run format:check` and `bun run knip` |
| Typecheck (TS 7 + Effect diagnostics)        | `bun run typecheck`                                       |
| Test (ubuntu-latest), Test (macos-latest)    | `bun run test`                                            |
| Build & npm smoke test                       | The binaries build and run under Node                     |
| Docker image                                 | The image builds for amd64 and arm64 and runs as deployed |
| PR body keeps the required template sections | The template wasn't deleted                               |
| PR title follows type(scope) subject         | The PR title format                                       |
| Commits follow type(scope) subject           | Every commit subject                                      |
| Commits are signed and verified              | Every commit shows as Verified                            |
| Commits omit AI attribution trailers         | No bot co-authors or generator footers                    |

## Tests in pull requests

- New behaviour comes with tests that show it.
- A bug fix comes with a regression test, wherever that's realistic.
- Changes to request handling, translation, the pool or stored files update or
  add tests.
- Docs, formatting and other changes that don't alter behaviour may need none,
  but the existing suite still has to pass.

If your PR adds no tests, say why in the description.

## Releases

A maintainer releases from GitHub: **Actions → Release → Run workflow** on
`main`, choosing whether to raise the patch, minor or major version. The
workflow checks that CI passed for that commit, then takes the latest `vX.Y.Z`
tag and raises it (from `v0.0.0` for the first release). It publishes the
Docker image to `ghcr.io`, runs the image smoke test against it, and tags the
commit with a GitHub release whose notes list the merged pull requests.

That tag is the only place a version is written down. Every `package.json` in
the repository stays at `0.0.0`: the build runs `npm/set-version.ts` to stamp
the release's version on the packages users get, and code that needs it, such
as a user agent, is handed the CLI's. Docs name no version, so none go stale.

Before a release, `.github/scripts/docker-smoke.sh <image> <version>` runs the
same smoke test against a local build:

```sh
docker build --build-arg VERSION=0.0.0-dev -t via:dev .
.github/scripts/docker-smoke.sh via:dev 0.0.0-dev
```
