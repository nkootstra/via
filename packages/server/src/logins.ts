import { type Account, AccountStore, CodexAuth } from "@via/codex-auth";
import { Context, Effect, Layer, Ref, Schema } from "effect";

/** Where a device-code login started through the admin API stands. */
type LoginState =
  | { readonly status: "pending" }
  | { readonly status: "added"; readonly account: Account }
  | { readonly status: "failed"; readonly error: string };

/** No login with this id was started since the server did; the admin API answers it as a 404. */
export class LoginNotFoundError extends Schema.TaggedError<LoginNotFoundError>()(
  "LoginNotFoundError",
  { id: Schema.String },
) {}

const make = Effect.gen(function* () {
  const auth = yield* CodexAuth;
  const store = yield* AccountStore;
  // Logins outlive the request that started them, but not the server.
  const scope = yield* Effect.scope;
  const logins = yield* Ref.make<ReadonlyMap<string, LoginState>>(new Map());

  const set = (id: string, state: LoginState) =>
    Ref.update(logins, (all) => new Map(all).set(id, state));

  /** Asks for a device code and waits for its approval in the background. */
  const start = Effect.fn("Logins.start")(function* () {
    const code = yield* auth.requestDeviceCode;
    const id = crypto.randomUUID();
    yield* set(id, { status: "pending" });
    yield* auth.awaitDeviceTokens(code).pipe(
      Effect.flatMap(store.save),
      Effect.flatMap((account) => set(id, { status: "added", account })),
      Effect.catch((error) => set(id, { status: "failed", error: error.message })),
      Effect.forkIn(scope),
    );

    return { id, userCode: code.userCode, verificationUrl: code.verificationUrl };
  });

  const status = Effect.fn("Logins.status")(function* (id: string) {
    return (yield* Ref.get(logins)).get(id) ?? (yield* new LoginNotFoundError({ id }));
  });

  return { start, status };
});

/** Device-code logins started through the admin API, kept in memory. */
export class Logins extends Context.Service<Logins, Effect.Success<typeof make>>()("via/Logins") {
  static readonly layer = Layer.effect(Logins, make);
}
