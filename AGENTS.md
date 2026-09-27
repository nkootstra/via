# via — contributor rules

`via` pools multiple ChatGPT/Codex subscriptions behind one OpenAI-compatible
local endpoint. Bun + turborepo, TypeScript 7, Effect v4.

## Workflow

- **TDD.** Every behaviour starts as a failing test. Write the minimal code to
  pass, then refactor. Commit each green step as a small commit.
- **YAGNI.** Build only what a test or a real need demands. No speculative
  options, config keys, or abstractions.
- Merge gates: `bun run lint` (Oxlint plus the anti-slop rules in
  `tools/oxlint/anti-slop`), `bun run format:check`, `bun run knip` (unused
  files, exports and dependencies), `bun run typecheck`, `bun run test`. CI
  runs the same. Fix what the lint finds; don't disable a rule to get past it.
  Every anti-slop rule is on except `no-conditional-empty-object-spread`, whose
  fix trades one object expression for statement-by-statement mutation.
- Tests use `@effect/vitest` via `bun --bun vitest run`. Never use `bun test`.
- Tests never call real OpenAI endpoints. Fake upstreams run as local HTTP
  servers, and base URLs are injected through layers.
- Pure, invariant-heavy logic (the pool's selection and cooldown rules) ships
  with property tests (`it.prop`/`it.effect.prop`), not just examples.

## Versions

- Never write a version by hand: not in a `package.json`, code or docs. The
  release's git tag is the only source. `package.json` versions stay `0.0.0`;
  the build stamps them with `npm/set-version.ts`, and code that needs the
  version is handed the CLI's (`apps/cli/src/version.ts`). Docs use `latest`.

## Commits & PRs

- PR titles and commit subjects read `type(scope): subject`, e.g.
  `fix(pool): hand out a still-valid token`. Types: `feat`, `fix`, `perf`,
  `refactor`, `test`, `docs`, `chore`, `ci`, `build`, `revert`. The scope is
  required, any lowercase word; add `!` after it for a breaking change.
- Sign every commit (SSH or GPG) with a key added to your GitHub account as a
  signing key. `main` rejects unverified commits.
- No AI attribution: no `Co-authored-by` trailers for bots or tools, no
  "Generated with …" footers or badges, in commits or PR descriptions.
- Fill in the PR template; don't delete its sections. CI checks every rule here.

## Effect conventions

- Everything outside the CLI's `main` is an `Effect`. No `async`/`await`,
  `Promise`, `throw` or `try`/`catch` in library code.
- Services: `class Foo extends Context.Service<Foo, { ... }>()("via/Foo") {}`
  plus a `Layer` (`Foo.layer`), with the operations typed inline or as
  `Effect.Success<typeof make>`. Name the type `Foo["Service"]`, never with a
  separate `FooShape`. Depend on services, not modules with side effects.
- Errors: `Schema.TaggedError` (serializable) or `Data.TaggedError`.
  Fail with `yield* new FooError({...})`. Handle with `Effect.catchTag`/`catchTags`.
  Never inspect `_tag` or use `instanceof` by hand.
- Parse all external data (files, HTTP bodies, JWT claims) with `Schema`. No
  `JSON.parse` + casts; use `Schema.fromJsonString` / `Schema.decodeUnknownEffect`.
- JSON whose shape via doesn't own, such as a request body it forwards, is
  `Schema.Json` / `Schema.JsonObject`, not `unknown` or `Record<string, unknown>`.
  Read its fields through `Schema.is` guards or small decoders, and branch on
  values with `Predicate` rather than `typeof`.
- Files go through the platform `FileSystem` service. HTTP goes through
  `HttpClient` / `HttpRouter` from `effect/unstable/http`. Time goes through
  `Clock` (tests use `TestClock`).
- `Effect.die` / `orDie` only at true boundaries, with a comment explaining why.
- Import from package public exports only. Never use relative imports across packages.

## Layout

- `apps/cli`: the `via` binary (`effect/unstable/cli`); the composition root.
- `apps/web`: the admin web UI, a static React SPA (TanStack Start in SPA
  mode, TanStack Query, `@via/ui`) that via serves at `/ui`. It is browser
  React: Effect is used only at its API boundary (`src/api`, a typed client of
  `@via/server/admin-api`), and `Promise` only where TanStack Query or the
  router expects one. Every other rule still applies. Its tests use plain
  `vitest` with happy-dom, Testing Library and MSW standing in for `/admin`.
- `packages/*`: libraries (`config`, `keys`, `codex-auth`, `pool`,
  `codex-upstream`, `account-pool`, `providers`, `translate`, `server`).
  Create a package only when the first test needs it.
- `packages/ui`: the UI components, a React design system (Base UI + StyleX)
  ported from Fluid Functionalism. No network or API code; screens and data
  live in the app. It is browser React, so the Effect conventions don't apply
  there; every other rule does. Tests use plain `vitest` with happy-dom and
  Testing Library.
- `docs/`: user-facing docs; `docs/README.md` is the repo's landing page.
- `tools/oxlint/anti-slop`: vendored Oxlint rules, enabled in `.oxlintrc.json`.
  Changes to them are recorded in its `UPSTREAM.md`.
- `npm/`: distribution. `bun run build` compiles the binary into each
  `npm/via-<os>-<arch>` package; `npm/via` is the Node launcher; `bun run smoke`
  installs the packed packages with npm and runs them under Node.
