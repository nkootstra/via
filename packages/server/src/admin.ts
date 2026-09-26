import { createHash, timingSafeEqual } from "node:crypto";
import { AccountStore } from "@via/codex-auth";
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSecurity,
} from "effect/unstable/httpapi";

/** An account as the admin API shows it: everything but its tokens. */
const AdminAccount = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  email: Schema.String,
  plan: Schema.String,
  enabled: Schema.Boolean,
  createdAt: Schema.String,
});

class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

/** Lets a request through only with `Authorization: Bearer <VIA_ADMIN_KEY>`. */
class AdminAuthorization extends HttpApiMiddleware.Service<AdminAuthorization>()(
  "via/AdminAuthorization",
  { security: { bearer: HttpApiSecurity.bearer }, error: Unauthorized },
) {}

class AccountsGroup extends HttpApiGroup.make("accounts")
  .add(HttpApiEndpoint.get("list", "/accounts", { success: Schema.Array(AdminAccount) }))
  .middleware(AdminAuthorization)
  .prefix("/admin") {}

class AdminApi extends HttpApi.make("via-admin").add(AccountsGroup) {}

/** `VIA_ADMIN_KEY` is set, but too short to withstand guessing. */
class AdminKeyTooShortError extends Schema.TaggedError<AdminKeyTooShortError>()(
  "AdminKeyTooShortError",
  { length: Schema.Number },
) {
  override get message() {
    return `VIA_ADMIN_KEY must be at least 32 characters; it has ${this.length}`;
  }
}

const hash = (key: string) => createHash("sha256").update(key).digest();

const authorization = (adminKey: Redacted.Redacted<string>) => {
  const expected = hash(Redacted.value(adminKey));
  return Layer.succeed(
    AdminAuthorization,
    AdminAuthorization.of({
      // Comparing hashes keeps the comparison constant-time whatever the length.
      bearer: (handler, { credential }) =>
        timingSafeEqual(hash(Redacted.value(credential)), expected)
          ? handler
          : Effect.fail(new Unauthorized({ message: "Missing or invalid admin key" })),
    }),
  );
};

const accounts = HttpApiBuilder.group(AdminApi, "accounts", (handlers) =>
  handlers.handle("list", () =>
    Effect.gen(function* () {
      const all = yield* (yield* AccountStore).list;
      return all.map(({ id, label, email, plan, enabled, createdAt }) => ({
        id,
        label,
        email,
        plan,
        enabled,
        createdAt,
      }));
    }).pipe(
      // The account files are via's own; one it can't read is a bug, not a request error.
      Effect.orDie,
    ),
  ),
);

/**
 * The admin API under `/admin`, behind `VIA_ADMIN_KEY`. Without that key the
 * routes are not registered at all, so `/admin` answers 404 like any unknown path.
 */
export const adminRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const adminKey = yield* Config.option(Config.Redacted("VIA_ADMIN_KEY"));
    if (Option.isNone(adminKey)) return Layer.empty;
    const { length } = Redacted.value(adminKey.value);
    if (length < 32) return yield* new AdminKeyTooShortError({ length });
    return HttpApiBuilder.layer(AdminApi).pipe(
      Layer.provide(accounts),
      Layer.provide(authorization(adminKey.value)),
    );
  }),
);
