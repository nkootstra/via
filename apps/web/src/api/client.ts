/**
 * The admin API, typed by its contract (`@via/server/admin-api`). This is the
 * app's one Effect boundary: screens call `run`, which hands TanStack Query a
 * Promise that resolves with the endpoint's success or rejects with its typed
 * error.
 *
 * The browser holds no key. It signs in once, and via keeps the session in an
 * HttpOnly cookie that `same-origin` requests carry; `x-via-csrf` marks them
 * as coming from this page, which via requires of cookie-signed changes.
 */
import { AdminApi, Unauthorized } from "@via/server/admin-api";
import { Data, Effect, Layer, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

export type AdminClient = HttpApiClient.ForApi<typeof AdminApi>;

/** via couldn't be reached, or answered outside its contract. */
class ViaUnavailable extends Data.TaggedError("ViaUnavailable")<{
  readonly detail: string;
}> {
  override get message() {
    return "Can't reach via right now. Check that it's running, then try again.";
  }
}

const fetchLayer = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { credentials: "same-origin" })),
);

const client = HttpApiClient.make(AdminApi, {
  transformClient: HttpClient.mapRequest(HttpClientRequest.setHeader("x-via-csrf", "1")),
});

const isUnauthorized = Schema.is(Unauthorized);

let signedOut = () => {};

/** What to do when via says the session is gone: the router sends the viewer to sign in. */
export function onSignedOut(handler: () => void) {
  signedOut = handler;
}

/**
 * Runs one admin API call. An Unauthorized the call leaves unhandled means the
 * session ended, so the viewer is sent to sign in; signing in handles its own.
 */
export function run<A, E>(call: (admin: AdminClient) => Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(
    Effect.flatMap(client, call).pipe(
      Effect.mapError((error) =>
        HttpClientError.isHttpClientError(error)
          ? new ViaUnavailable({ detail: error.message })
          : error,
      ),
      Effect.tapError((error) => Effect.sync(() => isUnauthorized(error) && signedOut())),
      Effect.provide(fetchLayer),
    ),
  );
}
