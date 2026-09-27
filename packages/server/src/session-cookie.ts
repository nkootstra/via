import { Effect, Redacted } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";
import { session } from "./admin-api.ts";
import type { AdminSessions } from "./admin-sessions.ts";

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
