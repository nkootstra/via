import { Effect, Redacted } from "effect";
import {
  Cookies,
  HttpEffect,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { session } from "./api.ts";
import { AdminSessions } from "./sessions.ts";

/**
 * Every session cookie `request` carries. A browser can hold more than one under the
 * same name, such as one from before the cookie's path widened from `/admin` to `/`,
 * and sends the one with the more specific path first; a parsed cookie map keeps only
 * one of them.
 */
const sessionTokens = (request: HttpServerRequest.HttpServerRequest) =>
  (request.headers["cookie"] ?? "").split(";").flatMap((pair) => {
    const [name, ...value] = pair.trim().split("=");

    return name === session.key && value.length > 0 ? [value.join("=")] : [];
  });

/** Whether any session cookie `request` carries is a live session, which counts as using it. */
export const hasLiveSession = (
  sessions: AdminSessions["Service"],
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (const token of sessionTokens(request)) {
      if (yield* sessions.verify(Redacted.make(token))) return true;
    }

    return false;
  });

/** Ends every session `request` carries a cookie for. */
export const signOutAll = (
  sessions: AdminSessions["Service"],
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<void> =>
  Effect.forEach(sessionTokens(request), (token) => sessions.signOut(Redacted.make(token)), {
    discard: true,
  });

/** Waits until every session `request` carries a cookie for has ended. */
export const sessionsEnded = (
  sessions: AdminSessions["Service"],
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<void> =>
  Effect.forEach(sessionTokens(request), (token) => sessions.ended(Redacted.make(token)), {
    concurrency: "unbounded",
    discard: true,
  });

/** Deletes the session cookie at `path`, whatever its value. */
const expired = (path: string) =>
  Cookies.makeCookieUnsafe(session.key, "", {
    path,
    maxAge: 0,
    httpOnly: true,
    sameSite: "strict",
  });

/**
 * Deletes session cookies that can no longer sign in, so a browser doesn't keep sending
 * them: the one scoped to `/admin`, from before the cookie's path widened to `/`, always;
 * and the one at `/` too when none of the request's session cookies is live, as after a
 * sign-out elsewhere or a restart of via.
 */
export const staleSessionCookies = HttpRouter.middleware(
  Effect.gen(function* () {
    const sessions = yield* AdminSessions;

    return (app) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;

        if (sessionTokens(request).length === 0) return yield* app;
        const live = yield* hasLiveSession(sessions, request);

        const stale = Cookies.fromReadonlyRecord({
          [`${session.key}:/admin`]: expired("/admin"),
          ...(live ? {} : { [session.key]: expired("/") }),
        });

        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.mergeCookies(response, stale)),
        );

        return yield* app;
      });
  }),
  { global: true },
);
