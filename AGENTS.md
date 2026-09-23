# via — contributor rules

`via` pools multiple ChatGPT/Codex subscriptions behind one OpenAI-compatible
local endpoint. Bun + turborepo, TypeScript 7, Effect v4.

## Workflow

- **TDD.** Every behaviour starts as a failing test. Write the minimal code to
  pass, then refactor. Commit each green step as a small commit.
- **YAGNI.** Build only what a test or a real need demands. No speculative
  options, config keys, or abstractions.
- Merge gates: `bun run lint`, `bun run format:check`, `bun run typecheck`,
  `bun run test`. CI runs the same.
- Tests use `@effect/vitest` via `bun --bun vitest run`. Never use `bun test`.
- Tests never call real OpenAI endpoints. Fake upstreams run as local HTTP
  servers, and base URLs are injected through layers.

## Effect conventions

- Everything outside the CLI's `main` is an `Effect`. No `async`/`await`,
  `Promise`, `throw` or `try`/`catch` in library code.
- Services: `class Foo extends Context.Service<Foo, FooShape>()("via/Foo") {}`
  plus a `Layer` (`Foo.layer`). Depend on services, not modules with side effects.
- Errors: `Schema.TaggedError` (serializable) or `Data.TaggedError`.
  Fail with `yield* new FooError({...})`. Handle with `Effect.catchTag`/`catchTags`.
  Never inspect `_tag` or use `instanceof` by hand.
- Parse all external data (files, HTTP bodies, JWT claims) with `Schema`. No
  `JSON.parse` + casts; use `Schema.fromJsonString` / `Schema.decodeUnknownEffect`.
- Files go through the platform `FileSystem` service. HTTP goes through
  `HttpClient` / `HttpRouter` from `effect/unstable/http`. Time goes through
  `Clock` (tests use `TestClock`).
- `Effect.die` / `orDie` only at true boundaries, with a comment explaining why.
- Import from package public exports only. Never use relative imports across packages.

## Layout

- `apps/cli`: the `via` binary (`effect/unstable/cli`); the composition root.
- `packages/*`: libraries (`config`, `keys`, `codex-auth`, `pool`,
  `codex-upstream`, `translate`, `server`). Create a package only when the first
  test needs it.
