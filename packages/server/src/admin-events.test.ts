import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { type CodexRequest, type Reply, reply } from "@via/codex-upstream/testing";
import { Clock, Effect, Exit, Fiber, Option, Queue, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Sse } from "effect/unstable/encoding";
import { type AdminState, AdminEvent } from "./admin-api.ts";
import { ok, type Via, withVia } from "./testing/harness.ts";

const adminKey = "admin-key-that-is-long-enough-000";

type State = typeof AdminState.Type;

/**
 * Listens to `/admin/events` for as long as the scope, with the admin key unless
 * `headers` sign in another way, and answers the states it gets in one queue,
 * and each `history` event in another.
 */
const listen = (via: Via, headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const response = yield* via.get(
      "/admin/events",
      "cookie" in headers ? null : adminKey,
      headers,
    );

    const states = yield* Queue.unbounded<State>();
    const histories = yield* Queue.unbounded<void>();

    const ended = yield* response.stream.pipe(
      Stream.decodeText(),
      Stream.pipeThroughChannel(Sse.decodeSchema(AdminEvent)),
      Stream.runForEach((event) =>
        event.event === "state"
          ? Queue.offer(states, event.data)
          : Queue.offer(histories, undefined),
      ),
      Effect.forkScoped,
    );

    return { response, states, histories, ended: Fiber.join(ended) };
  });

/** Signs in with the admin key, and answers the `Cookie` header that sends its session back. */
const sessionCookie = (via: Via) =>
  Effect.map(
    via.post("/admin/session", { key: adminKey }, null),
    (response) => (response.headers["set-cookie"] ?? "").split("; ")[0] ?? "",
  );

/** How long via holds a change back for the ones that come with it. */
const COALESCE = "200 millis";

/** How long via holds a usage history change back for the requests that come with it. */
const HISTORY_COALESCE = "1 second";

/**
 * The next state that `matches`. A change goes out once via has held it back
 * for {@link COALESCE}, so whenever via starts to, the test clock moves past it.
 */
const next = (
  via: Via,
  states: Queue.Queue<State>,
  matches: (state: State) => boolean = () => true,
) =>
  Effect.gen(function* () {
    // Taken by a fiber of its own, so a state that arrives as the clock moves isn't lost.
    let taking = yield* Effect.forkChild(Queue.take(states));

    for (;;) {
      const state = yield* Effect.raceFirst(
        Effect.map(Fiber.join(taking), Option.some),
        Effect.as(via.timer(COALESCE), Option.none<State>()),
      );

      if (Option.isNone(state)) yield* TestClock.adjust(COALESCE);
      else if (matches(state.value)) return state.value;
      else taking = yield* Effect.forkChild(Queue.take(states));
    }
  });

/** The first state with no usage refresh running, once the one a page starts has ended. */
const settled = (via: Via, states: Queue.Queue<State>) =>
  next(via, states, (state) => !state.usage.refreshing);

const labels = (state: State) => state.accounts.map(({ label }) => label);

/** The Codex models `state` lists: those without a provider's prefix. */
const codexModels = (state: State) =>
  state.models.map(({ id }) => id).filter((id) => !id.includes("/"));

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
  options: { readonly openrouterFromUi?: boolean } = {},
) => withVia(answer, (via) => Effect.scoped(body(via)), { adminKey, ...options });

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
        // The via that sends it, so a page can tell when via was updated under it.
        expect(first.version).toBe("1.2.3-test");
        expect(labels(first)).toEqual(["a@example.com", "b@example.com"]);
        expect(first.keys.map(({ name }) => name)).toEqual(["test"]);

        const session = yield* listen(via, { cookie: yield* sessionCookie(via) });
        expect(labels(yield* Queue.take(session.states))).toEqual([
          "a@example.com",
          "b@example.com",
        ]);
      }),
    ),
  );

  it.effect("ends a session's stream when it signs out, but not the admin key's", () =>
    withAdmin(ok, (via) =>
      Effect.gen(function* () {
        const cookie = yield* sessionCookie(via);
        const session = yield* listen(via, { cookie });
        const bearer = yield* listen(via);
        yield* Queue.take(session.states);
        yield* settled(via, bearer.states);

        yield* via.delete("/admin/session", null, {
          cookie,
          origin: via.baseUrl,
          "x-via-csrf": "1",
        });
        yield* session.ended;

        yield* via.post("/admin/keys", { name: "laptop" }, adminKey);
        expect((yield* next(via, bearer.states)).keys.map(({ name }) => name)).toEqual([
          "test",
          "laptop",
        ]);
      }),
    ),
  );

  it.effect("ends a session's stream once the session is left unused for an hour", () =>
    withAdmin(ok, (via) =>
      Effect.gen(function* () {
        const session = yield* listen(via, { cookie: yield* sessionCookie(via) });
        yield* settled(via, session.states);

        // The stream itself doesn't count as using the session.
        yield* via.timer("1 hour");
        yield* TestClock.adjust("1 hour");
        yield* session.ended;
      }),
    ),
  );

  it.effect("sends the state again when an account, an OpenCode Go key or a key changes", () =>
    withAdmin(ok, (via) =>
      Effect.gen(function* () {
        const { states } = yield* listen(via);
        const first = yield* settled(via, states);
        const since = yield* Clock.currentTimeMillis;

        yield* via.patch(`/admin/accounts/${idOf(first, "a")}`, { label: "work" }, adminKey);
        expect(labels(yield* next(via, states))).toEqual(["work", "b@example.com"]);

        yield* via.post("/admin/keys", { name: "laptop" }, adminKey);
        expect((yield* next(via, states)).keys.map(({ name }) => name)).toEqual(["test", "laptop"]);

        yield* via.patch("/admin/keys/laptop", { name: "desktop" }, adminKey);
        expect((yield* next(via, states)).keys.map(({ name }) => name)).toEqual([
          "test",
          "desktop",
        ]);

        // OpenCode Go takes the key: it reports its usage.
        via.provider.usageFor("sk-go-5678", { usage: {} });
        yield* via.post("/admin/opencode-go/accounts", { apiKey: "sk-go-5678" }, adminKey);
        const added = yield* next(via, states, (state) => state.opencodeGo.length === 2);
        expect(added.opencodeGo.map(({ key }) => key)).toEqual(["…ider", "…5678"]);
        expect(added.pool.opencodeGo).toHaveLength(2);

        // A key's first use is written down, so the page can say when it was used.
        yield* via.post("/v1/responses", { model: "gpt-5.1-codex", input: "hi" });
        yield* next(via, states, (state) =>
          state.keys.some(({ name, lastUsedAt }) => name === "test" && lastUsedAt !== null),
        );
        // Sent as they happened, well before the next resync (15 s) would have.
        expect((yield* Clock.currentTimeMillis) - since).toBeLessThan(5_000);
      }),
    ),
  );

  it.effect("sends the state again when Ollama's address is saved or removed", () =>
    withAdmin(ok, (via) =>
      Effect.gen(function* () {
        const { states } = yield* listen(via);
        expect((yield* settled(via, states)).ollama).toBeNull();

        yield* via.put("/admin/ollama", { address: via.provider.url }, adminKey);
        const saved = yield* next(via, states, (state) => state.ollama !== null);
        expect(saved.ollama).toEqual({ address: via.provider.url, fromConfig: false });
        expect(saved.pool.providers.map(({ name }) => name)).toContain("ollama");

        yield* via.delete("/admin/ollama", adminKey);
        expect((yield* next(via, states, (state) => state.ollama === null)).ollama).toBeNull();
      }),
    ),
  );

  it.effect("sends the state again when OpenRouter's key or models change", () =>
    withAdmin(
      ok,
      (via) =>
        Effect.gen(function* () {
          via.provider.openrouterKey("sk-or-v1-abcd", { usage: 0, limit: null });
          const { states } = yield* listen(via);
          expect((yield* settled(via, states)).openrouter).toBeNull();

          yield* via.put("/admin/openrouter/key", { apiKey: "sk-or-v1-abcd" }, adminKey);
          const saved = yield* next(via, states, (state) => state.openrouter !== null);
          expect(saved.openrouter).toEqual({ key: "…abcd", models: [], fromConfig: false });

          yield* via.put("/admin/openrouter/models", { models: ["openai/gpt-6"] }, adminKey);

          const enabled = yield* next(
            via,
            states,
            (state) => (state.openrouter?.models.length ?? 0) > 0,
          );

          expect(enabled.openrouter?.models).toEqual(["openai/gpt-6"]);
        }),
      { openrouterFromUi: true },
    ),
  );

  it.effect("sends the models again when accounts are disabled and enabled", () =>
    withAdmin(ok, (via) =>
      Effect.gen(function* () {
        const { states } = yield* listen(via);
        const first = yield* settled(via, states);
        expect(codexModels(first)).toContain("gpt-6-astra");

        yield* via.patch(`/admin/accounts/${idOf(first, "a")}`, { enabled: false }, adminKey);
        yield* via.patch(`/admin/accounts/${idOf(first, "b")}`, { enabled: false }, adminKey);

        const disabled = yield* next(via, states, (state) =>
          state.accounts.every(({ enabled }) => !enabled),
        );

        expect(codexModels(disabled)).toEqual([]);

        yield* via.patch(`/admin/accounts/${idOf(first, "b")}`, { enabled: true }, adminKey);
        const enabled = yield* next(via, states, (state) => state.accounts.some((a) => a.enabled));
        expect(codexModels(enabled)).toContain("gpt-6-astra");
      }),
    ),
  );

  it.effect("sends a burst of changes as one state, once they have settled", () =>
    withAdmin(ok, (via) =>
      Effect.gen(function* () {
        const { states } = yield* listen(via);
        const first = yield* settled(via, states);

        yield* via.patch(`/admin/accounts/${idOf(first, "a")}`, { label: "work" }, adminKey);
        yield* via.patch(`/admin/accounts/${idOf(first, "b")}`, { label: "home" }, adminKey);
        yield* via.post("/admin/keys", { name: "laptop" }, adminKey);
        yield* via.timer(COALESCE);
        expect(yield* Queue.size(states)).toBe(0);

        yield* TestClock.adjust(COALESCE);
        const burst = yield* Queue.take(states);
        expect(labels(burst)).toEqual(["work", "home"]);
        expect(burst.keys).toHaveLength(2);

        // Nothing follows the burst: the next state is the next change's.
        yield* via.patch(`/admin/accounts/${idOf(first, "a")}`, { label: "office" }, adminKey);
        expect(labels(yield* next(via, states))).toEqual(["office", "home"]);
      }),
    ),
  );

  it.effect("says the usage history changed once a request is kept, a burst of them as one", () =>
    withAdmin(ok, (via) =>
      Effect.gen(function* () {
        const { histories } = yield* listen(via);

        for (let request = 0; request < 3; request++) {
          yield* via.post("/v1/responses", { model: "gpt-6-astra", input: "hi" });
        }

        // Held back a second for the rest of the burst, then sent once.
        yield* via.timer(HISTORY_COALESCE);
        expect(yield* Queue.size(histories)).toBe(0);
        yield* TestClock.adjust(HISTORY_COALESCE);
        yield* Queue.take(histories);

        yield* TestClock.adjust("5 seconds");
        expect(yield* Queue.size(histories)).toBe(0);
      }),
    ),
  );

  it.effect("sends nothing while nothing it shows changes", () =>
    withAdmin(ok, (via) =>
      Effect.gen(function* () {
        const { states } = yield* listen(via);
        yield* settled(via, states);

        // Two resyncs look at the state again, and find nothing new to send.
        for (let resync = 0; resync < 2; resync++) {
          yield* TestClock.adjust("15 seconds");
          yield* via.timer(COALESCE);
          yield* TestClock.adjust(COALESCE);
        }

        // Had either sent a state, it would come before this change's.
        yield* via.post("/admin/keys", { name: "laptop" }, adminKey);
        expect((yield* next(via, states)).keys.map(({ name }) => name)).toEqual(["test", "laptop"]);
      }),
    ),
  );

  it.effect("shows a cooldown as it starts, and again the moment it runs out", () =>
    withAdmin(coolingA, (via) =>
      Effect.gen(function* () {
        const { states } = yield* listen(via);
        yield* settled(via, states);

        yield* via.post("/v1/responses", { model: "gpt-5.1-codex", input: "hi" });

        const cooling = yield* next(via, states, (state) =>
          state.pool.accounts.some(({ state: { status } }) => status === "cooling"),
        );

        const until = cooling.pool.accounts.flatMap(({ state }) =>
          "until" in state ? [Date.parse(state.until)] : [],
        );

        const [end = 0] = until;
        expect(until).toHaveLength(1);

        // via sets itself a timer for when the cooldown ends.
        yield* via.timer(end - (yield* Clock.currentTimeMillis));

        // Up to when the cooldown ends, before any resync: nothing else would send it.
        yield* TestClock.adjust(end - (yield* Clock.currentTimeMillis));
        yield* next(via, states, (state) =>
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
        yield* settled(via, states);
        const before = usageLookups(via);

        // A snapshot a minute old is refreshed, as it was when the page asked every few seconds.
        yield* TestClock.adjust("75 seconds");
        yield* settled(via, states);
        expect(usageLookups(via)).toBeGreaterThan(before);

        yield* Scope.close(page, Exit.void);
        yield* via.logged("client_aborted");
        const after = usageLookups(via);
        // Its resync is let go, so nothing looks at the usage any more.
        yield* via.noTimer("15 seconds");
        yield* TestClock.adjust("5 minutes");
        expect(usageLookups(via)).toBe(after);
      }),
    ),
  );
});
