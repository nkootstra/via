import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { RequestLog } from "../usage/request-log.ts";

/**
 * An error in the shape OpenAI clients expect, noted in the request's log line.
 * A `message` that passes on an upstream's words, which can quote the request,
 * is noted as via's own `noted` instead.
 */
export const openAiError = (
  status: number,
  code: string,
  message: string,
  { headers = {}, noted = message }: { headers?: Record<string, string>; noted?: string } = {},
) =>
  Effect.gen(function* () {
    yield* (yield* RequestLog).refused(code, noted);

    return HttpServerResponse.jsonUnsafe(openAiErrorBody(status, code, message), {
      status,
      headers,
    });
  });

/** The body of an error in the shape OpenAI clients expect, a server's or the request's. */
export const openAiErrorBody = (status: number, code: string | null, message: string) => ({
  error: { message, type: status >= 500 ? "server_error" : "invalid_request_error", code },
});
