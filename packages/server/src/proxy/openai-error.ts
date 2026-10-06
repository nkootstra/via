import { Effect } from "effect";
import { HttpServerResponse } from "effect/unstable/http";
import { RequestLog } from "../usage/request-log.ts";

/** An error in the shape OpenAI clients expect, noted in the request's log line. */
export const openAiError = (
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    yield* (yield* RequestLog).refused(code, message);

    return HttpServerResponse.jsonUnsafe(
      {
        error: {
          message,
          type: status >= 500 ? "server_error" : "invalid_request_error",
          code,
        },
      },
      { status, headers },
    );
  });
