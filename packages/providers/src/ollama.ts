import { Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { OllamaUnreachableError } from "./errors.ts";
import { LOOKUP_TIMEOUT, ModelList, unansweredWithin } from "./provider.ts";

/** The provider an Ollama added in the web UI goes by. */
export const OLLAMA = "ollama";

/** Where Ollama listens unless told otherwise. */
export const OLLAMA_DEFAULT = "http://localhost:11434";

const OllamaVersion = Schema.Struct({ version: Schema.String });

const unreachable = (reason: string) => new OllamaUnreachableError({ reason });

/** Asks the Ollama at `address` for `path`: nothing there, or something that isn't Ollama, says so. */
const askOllama = <S extends Schema.Codec<unknown, unknown>>(
  http: HttpClient.HttpClient,
  address: string,
  path: string,
  schema: S,
) =>
  http.get(`${address}${path}`).pipe(
    Effect.catchTag("HttpClientError", () => Effect.fail(unreachable("nothing answered there"))),
    Effect.flatMap((response) =>
      HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        Effect.mapError(() => unreachable("what answered there isn't Ollama")),
      ),
    ),
  );

/**
 * The Ollama version at `address`, from Ollama's own API, and the models its
 * OpenAI-compatible one lists: what via will send to.
 */
export const checkOllama = (http: HttpClient.HttpClient, address: string) =>
  Effect.gen(function* () {
    const { version } = yield* askOllama(http, address, "/api/version", OllamaVersion);
    const { data } = yield* askOllama(http, address, "/v1/models", ModelList);

    return { version, models: data.map(({ id }) => id) };
  }).pipe(
    Effect.timeoutOrElse({
      duration: LOOKUP_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new OllamaUnreachableError({ reason: `it gave ${unansweredWithin(LOOKUP_TIMEOUT)}` }),
        ),
    }),
  );
