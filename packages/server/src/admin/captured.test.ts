import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { reply } from "@via/codex-upstream/testing";
import { Effect, Option, Schema } from "effect";
import { CapturedRequestNotFoundError } from "./api.ts";
import { ok, type Via, withVia } from "../testing/harness.ts";

const adminKey = "admin-key-that-is-long-enough-000";

/** A key a client pasted into its prompt, which via must never keep. */
const KEY = "sk-proj-Ab3dEfGh1jKlMnOpQrStUvWxYz0123456789_-abcd";

/** Codex refuses every account: their usage limits are reached. */
const usageLimit = () =>
  reply.error(429, { error: { type: "usage_limit_reached", message: "The usage limit" } });

/** A turn of OpenCode's session `ses_1`, once via has kept it, and its request id. */
const turn = (via: Via, input: string) =>
  Effect.gen(function* () {
    const response = yield* via.post("/v1/responses", { model: "gpt-6-astra", input }, undefined, {
      "x-session-id": "ses_1",
    });

    yield* response.text;
    yield* via.logged("Sent HTTP response");

    return response.headers["x-request-id"] ?? "";
  });

const json = (via: Via, path: string) =>
  Effect.flatMap(via.get(path, adminKey), (response) => response.json);

layer(BunFileSystem.layer)("captured requests in the admin API", (it) => {
  it.effect("keeps no prompts until told to, and says so", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect(yield* json(via, "/admin/history/capture")).toEqual({ keepFailedPrompts: false });

          const set = yield* via.put(
            "/admin/history/capture",
            { keepFailedPrompts: true },
            adminKey,
          );

          expect(set.status).toBe(200);
          expect(yield* set.json).toEqual({ keepFailedPrompts: true });
          expect(yield* json(via, "/admin/history/capture")).toEqual({ keepFailedPrompts: true });
        }),
      { adminKey },
    ),
  );

  it.effect("gives a failed turn's captured request, and names it in its conversation", () =>
    withVia(
      usageLimit,
      (via) =>
        Effect.gen(function* () {
          const requestId = yield* turn(via, `try ${KEY}`);
          const captured = yield* via.get(`/admin/history/requests/${requestId}/body`, adminKey);

          expect(captured.status).toBe(200);

          expect(yield* captured.json).toMatchObject({
            requestId,
            endpoint: "responses",
            request: { model: "gpt-6-astra", input: "try [redacted:openai-key]" },
            upstreamErrors: [
              { seq: 0, status: 429 },
              { seq: 1, status: 429 },
            ],
            redactions: [{ kind: "openai-key", count: 1 }],
            truncated: false,
          });

          expect(yield* json(via, "/admin/history/conversations/ses_1")).toMatchObject({
            captured: [requestId],
          });
        }),
      { adminKey, keepFailedPrompts: true },
    ),
  );

  it.effect("finds no captured request for a turn it kept none of", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          const requestId = yield* turn(via, "hi");
          const missing = yield* via.get(`/admin/history/requests/${requestId}/body`, adminKey);

          expect(missing.status).toBe(404);

          const refused = Schema.decodeUnknownOption(CapturedRequestNotFoundError)(
            yield* missing.json,
          );

          expect(Option.map(refused, (error) => error.requestId)).toEqual(Option.some(requestId));

          expect(yield* json(via, "/admin/history/conversations/ses_1")).toMatchObject({
            captured: [],
          });
        }),
      { adminKey, keepFailedPrompts: true },
    ),
  );

  it.effect("deletes the captured requests, and keeps the history", () =>
    withVia(
      usageLimit,
      (via) =>
        Effect.gen(function* () {
          const requestId = yield* turn(via, "hi");
          const deleted = yield* via.delete("/admin/history/bodies", adminKey);

          expect(deleted.status).toBe(200);
          expect(yield* deleted.json).toEqual({ deleted: 1 });

          const missing = yield* via.get(`/admin/history/requests/${requestId}/body`, adminKey);
          expect(missing.status).toBe(404);

          expect(yield* json(via, "/admin/history/conversations/ses_1")).toMatchObject({
            summary: { turns: 1 },
            captured: [],
          });
        }),
      { adminKey, keepFailedPrompts: true },
    ),
  );

  it.effect("deletes the captured requests with the whole history", () =>
    withVia(
      usageLimit,
      (via) =>
        Effect.gen(function* () {
          const requestId = yield* turn(via, "hi");
          yield* via.delete("/admin/history", adminKey);

          const missing = yield* via.get(`/admin/history/requests/${requestId}/body`, adminKey);
          expect(missing.status).toBe(404);
        }),
      { adminKey, keepFailedPrompts: true },
    ),
  );

  it.effect("needs the admin key", () =>
    withVia(
      ok,
      (via) =>
        Effect.gen(function* () {
          expect((yield* via.get("/admin/history/requests/r1/body", null)).status).toBe(401);
          expect((yield* via.delete("/admin/history/bodies", null)).status).toBe(401);
          expect((yield* via.get("/admin/history/capture", null)).status).toBe(401);

          const set = yield* via.put("/admin/history/capture", { keepFailedPrompts: true }, null);
          expect(set.status).toBe(401);
        }),
      { adminKey },
    ),
  );
});
