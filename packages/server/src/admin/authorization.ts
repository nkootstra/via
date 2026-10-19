import { Effect, Layer, Option, Redacted } from "effect";
import { HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { AdminAuthorization, bearer, Forbidden, Unauthorized } from "./api.ts";
import { AdminSessions } from "./sessions.ts";
import { hasLiveSession } from "./session-cookie.ts";

/** A browser's `Origin` header, when it names an http(s) origin. */
export const originOf = (request: HttpServerRequest.HttpServerRequest) => {
  const origin = URL.parse(request.headers.origin ?? "");

  return origin !== null && (origin.protocol === "http:" || origin.protocol === "https:")
    ? origin
    : undefined;
};

/**
 * Whether the browser says the request comes from via's own origin. A browser sets
 * `Origin` itself. The origin's scheme isn't compared: behind a proxy that ends TLS,
 * via sees plain HTTP while the browser says `https`. A URL's host is lower case, and
 * `Host` is compared as such: host names are case-insensitive.
 */
const fromOwnOrigin = (request: HttpServerRequest.HttpServerRequest) =>
  originOf(request)?.host === request.headers.host?.toLowerCase();

/**
 * Whether a request that only has a session cookie comes from via's own page, and
 * so may change something: a cross-site form can't add `x-via-csrf`.
 */
const fromOwnPage = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers["x-via-csrf"] === "1" && fromOwnOrigin(request);

/**
 * Refuses a sign-in another site's page sent, before its key is checked, so it never
 * counts as a failed sign-in against the admin's own address. A sign-in without
 * `Origin`, as the CLI or curl sends, goes through.
 */
export const signInFromOwnOrigin = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;

  if (request.headers.origin !== undefined && !fromOwnOrigin(request)) {
    return yield* new Forbidden({
      message:
        "Open via at its own address; a reverse proxy must pass the Host header through unchanged.",
    });
  }
});

/** Methods that only read, which need no check for a forged request. */
const reads = new Set(["GET", "HEAD"]);

const invalid = new Unauthorized({ message: "Missing or invalid admin key or session" });

/**
 * Who is signing in, for counting their failed sign-ins: the address the
 * connection came from. Never a header such as `X-Forwarded-For`, which the
 * client could make up; behind a proxy, every sign-in is the proxy's.
 */
export const clientOf = (request: HttpServerRequest.HttpServerRequest) =>
  Option.getOrElse(request.remoteAddress, () => "unknown");

/** The bearer key the request carries, unless it carries none. */
export const bearerKey = Effect.map(HttpApiBuilder.securityDecode(bearer), (key) =>
  Redacted.value(key) === "" ? Option.none() : Option.some(key),
);

/** Checks every admin request: see `AdminAuthorization`. */
export const adminAuthorization = Layer.effect(
  AdminAuthorization,
  Effect.gen(function* () {
    const sessions = yield* AdminSessions;

    // The builder tries `bearer`, then `session`, and answers with the last one's error,
    // so `session` decides every request: a bearer key refused because its address is
    // throttled must answer 429, which an error from `bearer` would turn into a 401.
    return AdminAuthorization.of({
      bearer: () => invalid,
      session: (handler) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const key = yield* bearerKey;

          if (Option.isSome(key)) {
            yield* sessions.authorize(key.value, clientOf(request));

            return yield* handler;
          }

          if (!(yield* hasLiveSession(sessions, request))) return yield* invalid;

          if (!reads.has(request.method) && !fromOwnPage(request)) {
            return yield* new Forbidden({
              message: "A change signed in with a session must come from via's own page",
            });
          }

          return yield* handler;
        }),
    });
  }),
);
