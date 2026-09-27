import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { type CodexRequest, type Reply, reply } from "@via/codex-upstream/testing";
import { Clock, Effect, Exit, Option, Queue, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Sse } from "effect/unstable/encoding";
import { type AdminState, StateEvent } from "./admin-api.ts";
import { ok, type Via, withVia } from "./testing/harness.ts";

const adminKey = "admin-key-that-is-long-enough-000";

type State = typeof AdminState.Type;

/**
 * Listens to `/admin/events` for as long as the scope, with the admin key unless
 * `headers` sign in another way, and answers the states it gets, in a queue.
 */
const listen = (via: Via, headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const response = yield* via.get(
      "/admin/events",
      "cookie" in headers ? null : adminKey,
      headers,
    );

    const states = yield* Queue.unbounded<State>();

    yield* response.stream.pipe(
      Stream.decodeText(),
      Stream.pipeThroughChannel(Sse.decodeSchema(StateEvent)),
      Stream.runForEach(({ data }) => Queue.offer(states, data)),
      Effect.forkScoped,
    );

    return { response, states };
  });

/**
 * The next state that `matches`, moving the test clock on 50 ms at a time, a
 * few real milliseconds apart, so a change waiting for others goes out.
 */
const next = (states: Queue.Queue<State>, matches: (state: State) => boolean = () => true) => {
  const loop: Effect.Effect<State> = Effect.flatMap(Queue.poll(states), (taken) =>
    Option.match(taken, {
      onSome: (state) => (matches(state) ? Effect.succeed(state) : loop),
      onNone: () =>
        TestClock.withLive(Effect.sleep("2 millis")).pipe(
          Effect.andThen(TestClock.adjust("50 millis")),
          Effect.andThen(loop),
        ),
    }),
  );

  return loop;
};

/** The first state with no usage refresh running, once the one a page starts has ended. */
const settled = (states: Queue.Queue<State>) => next(states, (state) => !state.usage.refreshing);

/** A few real milliseconds, for via to act on a request that has already been answered. */
const moment = TestClock.withLive(Effect.sleep("30 millis"));

const labels = (state: State) => state.accounts.map(({ label }) => label);

/** The `/wham/usage` lookups the fake Codex received so far. */
const usageLookups = (via: Via) =>
  via.upstreamRequests.filter(({ path }) => path === "/wham/usage").length;

/** Codex rate-limits account "a" for 10 seconds, sooner than a resync, and answers account "b". */
const coolingA = (request: CodexRequest) =>
  request.headers["chatgpt-account-id"] === "acc-a"
    ? reply.error(429, "", { "retry-after": "10" })
    : ok();

/** Runs `body`, in a scope of its own, against a via with the admin key whose Codex gives `answer`. */
const withAdmin = <A, E>(
  answer: (request: CodexRequest) => Reply,
  body: (via: Via) => Effect.Effect<A, E, Scope.Scope>,
) => withVia(answer, (via) => Effect.scoped(body(via)), { adminKey });

/** The id of account `name` in `state`. */
const idOf = (state: State, name: string) =>
  state.accounts.find(({ email }) => email === `${name}@example.com`)?.id ?? "";

layer(BunFileSystem.layer)("GET /admin/events", (it) => {
  it.effect("refuses a request without the admin key or a session", () =>
    withAdmin(ok, (via) =>
      Effect.gen(function* () {
        expect((yield* via.get("/admin/events", null)).status).toBe(401);
        expect((yield* via.get("/admin/events")).status).toBe(401);
      }),
    ),
  );

  it.effect("sends the admin state at once, to the admin key or a session cookie", () =>
    withAdmin(ok, (via) =>
      Effect.gen(function* () {
        const { response, states } = yield* listen(via);

        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toBe("text/event-stream");
        expect(response.headers["cache-control"]).toBe("no-store");
        const first = yield* Queue.take(states);
        expect(first.session).toBe(true);
        expect(labels(first)).toEqual(["a@example.com", "b@example.com"]);
        expect(first.keys.map(({ name }) => name)).toEqual(["test"]);

        const signedIn = yield* via.post("/admin/session", { key: adminKey }, null);
        const cookie = (signedIn.headers["set-cookie"] ?? "").split("; ")[0] ?? "";
        const session = yield* listen(via, { cookie });
        expect(labels(yield* Queue.take(session.states))).toEqual([
          "a@example.com",
          "b@example.com",
        ]);
      }),
    ),
  );

  it.effect("sends the state again when an account or a key changes", () =>
    withAdmin(ok, (via) =>
      Effect.gen(function* () {
        const { states } = yield* listen(via);
        const first = yield* settled(states);
        const since = yield* Clock.currentTimeMillis;

        yield* via.patch(`/admin/accounts/${idOf(first, "a")}`, { label: "work" }, adminKey);
        expect(labels(yield* next(states))).toEqual(["work", "b@example.com"]);

        yield* via.post("/admin/keys", { name: "laptop" }, adminKey);
        expect((yield* next(states)).keys.map(({ name }) => name)).toEqual(["test", "laptop"]);
        // Sent as they happened, not on the next resync.
        expect((yield* Clock.currentTimeMillis) - since).toBeLessThan(1_000);
      }),
    ),
  );

  it.effect("sends a burst of changes as one state, once they have settled", () =>
    withAdmin(ok, (via) =>
      Effect.gen(function* () {
        const { states } = yield* listen(via);
        const first = yield* settled(states);

        yield* via.patch(`/admin/accounts/${idOf(first, "a")}`, { label: "work" }, adminKey);
        yield* via.patch(`/admin/accounts/${idOf(first, "b")}`, { label: "home" }, adminKey);
        yield* via.post("/admin/keys", { name: "laptop" }, adminKey);
        yield* moment;
        expect(yield* Queue.size(states)).toBe(0);

        yield* TestClock.adjust("200 millis");
        const burst = yield* Queue.take(states);
        expect(labels(burst)).toEqual(["work", "home"]);
        expect(burst.keys).toHaveLength(2);
        yield* moment;
        expect(yield* Queue.size(states)).toBe(0);
      }),
    ),
  );

  it.effect("sends nothing while nothing it shows changes", () =>
    withAdmin(ok, (via) =>
      Effect.gen(function* () {
        const { states } = yield* listen(via);
        yield* settled(states);

        for (let second = 0; second < 30; second++) {
          yield* TestClock.adjust("1 second");
          yield* TestClock.withLive(Effect.sleep("1 millis"));
        }

        expect(yield* Queue.size(states)).toBe(0);
      }),
    ),
  );

  it.effect("shows a cooldown as it starts, and again the moment it runs out", () =>
    withAdmin(coolingA, (via) =>
      Effect.gen(function* () {
        const { states } = yield* listen(via);
        yield* settled(states);

        yield* via.post("/v1/responses", { model: "gpt-5.1-codex", input: "hi" });

        const cooling = yield* next(states, (state) =>
          state.pool.accounts.some(({ state: { status } }) => status === "cooling"),
        );

        const until = cooling.pool.accounts.flatMap(({ state }) =>
          "until" in state ? [Date.parse(state.until)] : [],
        );

        const [end = 0] = until;
        expect(until).toHaveLength(1);

        yield* moment;

        // Up to when the cooldown ends, before any resync: nothing else would send it.
        yield* TestClock.adjust(end - (yield* Clock.currentTimeMillis));
        yield* next(states, (state) =>
          state.pool.accounts.every(({ state: { status } }) => status === "available"),
        );
        expect((yield* Clock.currentTimeMillis) - end).toBeLessThan(1_000);
      }),
    ),
  );

  it.effect("keeps the usage fresh while a page listens, and lets go once it leaves", () =>
    withAdmin(ok, (via) =>
      Effect.gen(function* () {
        const page = yield* Scope.make();
        const { states } = yield* listen(via).pipe(Scope.provide(page));
        yield* settled(states);
        const before = usageLookups(via);

        // A snapshot a minute old is refreshed, as it was when the page asked every few seconds.
        yield* TestClock.adjust("75 seconds");
        yield* settled(states);
        expect(usageLookups(via)).toBeGreaterThan(before);

        yield* Scope.close(page, Exit.void);
        yield* via.logged("client_aborted");
        const after = usageLookups(via);

        for (let minute = 0; minute < 5; minute++) {
          yield* TestClock.adjust("1 minute");
          yield* moment;
        }

        expect(usageLookups(via)).toBe(after);
      }),
    ),
  );
});
