import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { completedStream, reply } from "@via/codex-upstream/testing";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { withVia } from "./harness.ts";

const CHAT = "/v1/chat/completions";
const request = {
  model: "gpt-6-astra",
  messages: [{ role: "user", content: "hi" }],
};

/** Which account (as via authenticates to Codex) sent request number `n` (1-based). */
const accountOf = (
  via: { upstreamRequests: ReadonlyArray<{ headers: Record<string, unknown> }> },
  n: number,
) => via.upstreamRequests[n - 1]?.headers.authorization;

layer(BunFileSystem.layer)("sticky sessions", (it) => {
  it.effect(
    "keeps a session on the account that answered it, even once fill-first would pick another",
    () => {
      // "a" cools down on its first request only, so "b" answers the first
      // client request; both accounts succeed on every request after that.
      let firstToA = true;
      const answer = (req: { headers: Readonly<Record<string, string | undefined>> }) => {
        if (req.headers.authorization === "Bearer at-a" && firstToA) {
          firstToA = false;
          return reply.error(429, { error: { code: "usage_limit_reached" } });
        }
        return reply.sse(completedStream("hi"));
      };
      return withVia(answer, (via) =>
        Effect.gen(function* () {
          const headers = { "x-session-id": "s1" };
          const first = yield* via.post(CHAT, request, undefined, headers);
          expect(first.status).toBe(200);
          // "a" failed, then "b" answered: two upstream calls for this one client request.
          expect(accountOf(via, 1)).toBe("Bearer at-a");
          expect(accountOf(via, 2)).toBe("Bearer at-b");

          // Let "a"'s cooldown expire, so plain fill-first would pick it again.
          yield* TestClock.adjust("31 minutes");

          const second = yield* via.post(CHAT, request, undefined, headers);
          expect(second.status).toBe(200);
          // Same session: via stays on "b" instead of going back to "a".
          expect(via.upstreamRequests).toHaveLength(3);
          expect(accountOf(via, 3)).toBe("Bearer at-b");

          // A different, never-seen session has no binding: back to fill-first.
          const third = yield* via.post(CHAT, request, undefined, { "x-session-id": "s2" });
          expect(third.status).toBe(200);
          expect(via.upstreamRequests).toHaveLength(4);
          expect(accountOf(via, 4)).toBe("Bearer at-a");
        }),
      );
    },
  );

  it.effect(
    "moves the binding to whichever account answers after the bound one fails over mid-request",
    () => {
      // "a" answers the session's first request, becoming its binding. It then
      // fails over on the session's next request, so "b" answers that one instead.
      let aCalls = 0;
      const answer = (req: { headers: Readonly<Record<string, string | undefined>> }) => {
        if (req.headers.authorization === "Bearer at-a") {
          aCalls++;
          if (aCalls === 2) return reply.error(429, { error: { code: "usage_limit_reached" } });
        }
        return reply.sse(completedStream("hi"));
      };
      return withVia(answer, (via) =>
        Effect.gen(function* () {
          const headers = { "x-session-id": "s1" };
          // No binding yet: fill-first picks "a", which becomes the binding.
          const first = yield* via.post(CHAT, request, undefined, headers);
          expect(first.status).toBe(200);
          expect(accountOf(via, 1)).toBe("Bearer at-a");

          // Same session: "a" is preferred but fails over mid-request, so "b" answers.
          const second = yield* via.post(CHAT, request, undefined, headers);
          expect(second.status).toBe(200);
          expect(via.upstreamRequests).toHaveLength(3);
          expect(accountOf(via, 2)).toBe("Bearer at-a");
          expect(accountOf(via, 3)).toBe("Bearer at-b");

          // Let "a"'s cooldown expire, so plain fill-first would pick it again.
          yield* TestClock.adjust("31 minutes");

          // The binding moved to "b": a later request on s1 stays there, not back on "a".
          const third = yield* via.post(CHAT, request, undefined, headers);
          expect(third.status).toBe(200);
          expect(via.upstreamRequests).toHaveLength(4);
          expect(accountOf(via, 4)).toBe("Bearer at-b");
        }),
      );
    },
  );
});
