import type { UpstreamFailedError } from "@via/codex-upstream";
import {
  type ChatRequest,
  CompletedResponse,
  MessagesMessage,
  toChatCompletion,
  toChatCompletionFromMessage,
  toChatStream,
  toChatStreamFromMessages,
} from "@via/translate";
import { Clock, Effect, Option, Schema } from "effect";
import { type HttpClientResponse, HttpServerResponse } from "effect/unstable/http";
import { openAiError } from "./openai-error.ts";
import { collected, relayed } from "./relay.ts";
import { RequestLog } from "./request-log.ts";
import { usageOf } from "./token-usage.ts";

const decodeCompleted = Schema.decodeUnknownEffect(CompletedResponse);

/**
 * A Chat Completions answer to `chat` from `upstream`'s Responses stream: its
 * chunks as they come for a streaming client, else the completion it ends in.
 * A response failed in a stream relayed as it comes is told to `onFailed`.
 */
export const chatFromResponses = (
  upstream: HttpClientResponse.HttpClientResponse,
  chat: typeof ChatRequest.Type,
  onFailed?: (error: UpstreamFailedError) => Effect.Effect<void>,
) =>
  chat.stream === true
    ? relayed(
        upstream,
        {
          contentType: "text/event-stream",
          sse: true,
          ...(onFailed === undefined ? {} : { onFailed }),
        },
        (events) =>
          toChatStream(events, { includeUsage: chat.stream_options?.include_usage === true }),
      )
    : collected(upstream, (response) =>
        decodeCompleted(response).pipe(
          Effect.map((completed) => HttpServerResponse.jsonUnsafe(toChatCompletion(completed))),
        ),
      );

const decodeMessage = Schema.decodeUnknownEffect(MessagesMessage);

/** Notes the Chat usage a translated answer reports, if it's a usage object. */
const noteUsage = (usage: Schema.Json) =>
  Effect.flatMap(RequestLog, (log) =>
    Option.match(usageOf(usage), { onNone: () => Effect.void, onSome: log.usage }),
  );

/**
 * A Chat Completions answer to `chat` from `upstream`'s Anthropic Messages
 * answer: its chunks as they come for a streaming client, else the completion
 * its message makes. The translation reports the usage: Messages splits it
 * between the stream's first event and its last.
 */
export const chatFromMessages = (
  upstream: HttpClientResponse.HttpClientResponse,
  chat: typeof ChatRequest.Type,
) =>
  Effect.gen(function* () {
    const created = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const context = yield* Effect.context<RequestLog>();

    if (chat.stream === true) {
      return yield* relayed(
        upstream,
        { contentType: "text/event-stream", sse: true, spotUsage: false },
        (events) =>
          toChatStreamFromMessages(events, {
            includeUsage: chat.stream_options?.include_usage === true,
            created,
            onUsage: (usage) => noteUsage(usage).pipe(Effect.provideContext(context)),
          }),
      );
    }

    return yield* upstream.json.pipe(
      Effect.flatMap(decodeMessage),
      Effect.map((message) => toChatCompletionFromMessage(message, created)),
      Effect.tap((completion) => noteUsage(completion.usage)),
      Effect.map((completion) => HttpServerResponse.jsonUnsafe(completion)),
      // The body broke off, or wasn't a Messages message.
      Effect.catch(() =>
        openAiError(502, "upstream_unreadable", "The Messages answer could not be read"),
      ),
    );
  });
