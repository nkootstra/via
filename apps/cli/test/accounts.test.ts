import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { fakeIssuer } from "@via/codex-auth/testing";
import { completedStream, type FakeReply, fakeUpstream } from "@via/codex-upstream/testing";
import { Effect, Layer } from "effect";
import { HttpServer } from "effect/unstable/http";
import { runVia, tempHome } from "./helpers.ts";

/**
 * A `via` runner with its own home, logging in against a local fake issuer and
 * reading usage from a fake Codex backend that answers with `usage`. Times print in UTC.
 */
const withVia = <A, E, R>(
  body: (
    via: (...args: ReadonlyArray<string>) => ReturnType<typeof runVia>,
  ) => Effect.Effect<A, E, R>,
  usage?: () => FakeReply,
) =>
  Effect.gen(function* () {
    const home = yield* tempHome;
    const upstream = yield* Layer.build(
      fakeUpstream(() => ({ status: 200, body: completedStream("hello") }), usage),
    );
    const issuer = yield* Layer.build(fakeIssuer());
    const address = (context: typeof upstream | typeof issuer) =>
      HttpServer.addressFormattedWith(Effect.succeed).pipe(Effect.provide(context));
    const env = {
      VIA_CODEX_ISSUER: yield* address(issuer),
      VIA_CODEX_BASE_URL: yield* address(upstream),
      TZ: "UTC",
    };
    return yield* body((...args) => runVia(home, args, env));
  });

layer(BunFileSystem.layer)("via accounts", (it) => {
  it.effect("add shows the device code, then saves the approved account", () =>
    withVia((via) =>
      Effect.gen(function* () {
        const added = yield* via("accounts", "add");
        expect(added.exitCode).toBe(0);
        expect(added.stdout).toContain("ABCD-1234");
        expect(added.stdout).toContain("/codex/device");
        expect(added.stdout).toContain("dev@example.com");
        expect((yield* via("accounts", "list")).stdout).toMatch(
          /dev@example\.com\s+dev@example\.com\s+pro\s+enabled/,
        );
      }),
    ),
  );

  it.effect("list explains how to add an account when there is none", () =>
    withVia((via) =>
      Effect.gen(function* () {
        expect((yield* via("accounts", "list")).stdout).toContain("via accounts add");
      }),
    ),
  );

  it.effect("label, disable and enable change what list shows", () =>
    withVia((via) =>
      Effect.gen(function* () {
        yield* via("accounts", "add");
        expect((yield* via("accounts", "label", "dev@example.com", "work")).exitCode).toBe(0);
        yield* via("accounts", "disable", "work");
        expect((yield* via("accounts", "list")).stdout).toMatch(
          /work\s+dev@example\.com\s+pro\s+disabled/,
        );
        yield* via("accounts", "enable", "work");
        expect((yield* via("accounts", "list")).stdout).toMatch(
          /work\s+dev@example\.com\s+pro\s+enabled/,
        );
      }),
    ),
  );

  it.effect("remove deletes the account", () =>
    withVia((via) =>
      Effect.gen(function* () {
        yield* via("accounts", "add");
        expect((yield* via("accounts", "remove", "dev@example.com")).exitCode).toBe(0);
        expect((yield* via("accounts", "list")).stdout).toContain("via accounts add");
      }),
    ),
  );

  it.effect("an unknown account fails with a message", () =>
    withVia((via) =>
      Effect.gen(function* () {
        const result = yield* via("accounts", "disable", "nobody");
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('No account with id, label or email "nobody"');
      }),
    ),
  );

  it.effect("status shows how much of each rate limit window every account has used", () =>
    withVia((via) =>
      Effect.gen(function* () {
        yield* via("accounts", "add");
        const status = yield* via("accounts", "status");
        expect(status.exitCode).toBe(0);
        expect(status.stdout).toMatch(/dev@example\.com\s+dev@example\.com\s+pro\s+enabled/);
        expect(status.stdout).toMatch(/5h\s+12% used\s+resets 2023-11-14 23:13/);
        expect(status.stdout).toMatch(/7d\s+40% used\s+resets 2023-11-15 22:13/);
      }),
    ),
  );

  it.effect("status says when an account's usage is unavailable", () =>
    withVia(
      (via) =>
        Effect.gen(function* () {
          yield* via("accounts", "add");
          const status = yield* via("accounts", "status");
          expect(status.exitCode).toBe(0);
          expect(status.stdout).toContain("ChatGPT did not report usage (HTTP 403)");
        }),
      () => ({ status: 403, body: "{}" }),
    ),
  );
});
