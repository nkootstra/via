import { Context, Effect, Layer, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { prepareBody, type ResponsesBody } from "./prepare-body.ts";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

const CODEX_TUI_VERSION = "0.154.0";
const IDENTITIES = {
  cloaked: {
    originator: "codex-tui",
    "user-agent": `codex-tui/${CODEX_TUI_VERSION} (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; ${CODEX_TUI_VERSION})`,
  },
  plain: (version: string) => ({ originator: "via", "user-agent": `via/${version}` }),
};

export type UpstreamAccount = { readonly accessToken: string; readonly accountId: string };

export type CodexUpstreamOptions = {
  readonly baseUrl?: string;
  /** Present requests as the official Codex TUI. */
  readonly cloak: boolean;
  /** via's own version, which it says it is when it doesn't cloak. */
  readonly version: string;
};

export class UsageUnavailableError extends Schema.TaggedError<UsageUnavailableError>()(
  "UsageUnavailableError",
  { status: Schema.Finite },
) {
  override get message() {
    return `ChatGPT did not report usage (HTTP ${this.status})`;
  }
}

export class ModelsUnavailableError extends Schema.TaggedError<ModelsUnavailableError>()(
  "ModelsUnavailableError",
  { status: Schema.Finite },
) {
  override get message() {
    return `Codex did not list its models (HTTP ${this.status})`;
  }
}

const ModelsPayload = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      visibility: Schema.optionalKey(Schema.String),
      supported_reasoning_levels: Schema.optionalKey(
        Schema.Array(Schema.Struct({ effort: Schema.String })),
      ),
    }),
  ),
});

/** A model an account can pick, with the reasoning efforts it supports. */
export type CatalogModel = { readonly model: string; readonly efforts: ReadonlyArray<string> };

const Window = Schema.Struct({
  used_percent: Schema.Finite,
  limit_window_seconds: Schema.Finite,
  reset_at: Schema.Finite,
});
const UsagePayload = Schema.Struct({
  rate_limit: Schema.Struct({
    primary_window: Schema.NullOr(Window),
    secondary_window: Schema.NullOr(Window),
  }),
});

/** How much of one rate limit window an account has used, and when it starts over. */
export type UsageWindow = {
  readonly windowMinutes: number;
  readonly usedPercent: number;
  /** Epoch milliseconds. */
  readonly resetsAt: number;
};

const make = ({ baseUrl = CODEX_BASE_URL, cloak, version }: CodexUpstreamOptions) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const identity = cloak ? IDENTITIES.cloaked : IDENTITIES.plain(version);

    /**
     * Sends a Responses request as `account` in conversation `session`, which
     * Codex caches prompts on; any status comes back for the caller to judge.
     */
    const send = Effect.fn("CodexUpstream.send")(function* (
      account: UpstreamAccount,
      body: ResponsesBody,
      session: string,
    ) {
      return yield* HttpClientRequest.post(`${baseUrl}/codex/responses`).pipe(
        HttpClientRequest.setHeaders({
          ...identity,
          authorization: `Bearer ${account.accessToken}`,
          "chatgpt-account-id": account.accountId,
          session_id: session,
          accept: "text/event-stream",
        }),
        // A raw string goes to fetch as-is; bodyJsonUnsafe would copy it into bytes first.
        HttpClientRequest.setBody(
          HttpBody.raw(JSON.stringify(prepareBody({ prompt_cache_key: session, ...body })), {
            contentType: "application/json",
          }),
        ),
        http.execute,
      );
    });

    /** The account's rate limit windows: the short (5-hour) one first, then the weekly one. */
    const usage = Effect.fn("CodexUpstream.usage")(function* (account: UpstreamAccount) {
      const response = yield* HttpClientRequest.get(`${baseUrl}/wham/usage`).pipe(
        HttpClientRequest.setHeaders({
          ...identity,
          authorization: `Bearer ${account.accessToken}`,
          "chatgpt-account-id": account.accountId,
        }),
        http.execute,
      );
      if (response.status !== 200) {
        return yield* new UsageUnavailableError({ status: response.status });
      }
      const { rate_limit } = yield* HttpClientResponse.schemaBodyJson(UsagePayload)(response);
      return [rate_limit.primary_window, rate_limit.secondary_window].flatMap(
        (window): Array<UsageWindow> =>
          window === null
            ? []
            : [
                {
                  windowMinutes: window.limit_window_seconds / 60,
                  usedPercent: window.used_percent,
                  resetsAt: window.reset_at * 1000,
                },
              ],
      );
    });

    /**
     * The models the account can pick, as the Codex model picker lists them;
     * hidden models are left out. The catalog differs by plan.
     */
    const models = Effect.fn("CodexUpstream.models")(function* (account: UpstreamAccount) {
      const response = yield* HttpClientRequest.get(`${baseUrl}/codex/models`).pipe(
        HttpClientRequest.setUrlParam("client_version", CODEX_TUI_VERSION),
        HttpClientRequest.setHeaders({
          ...identity,
          authorization: `Bearer ${account.accessToken}`,
          "chatgpt-account-id": account.accountId,
        }),
        http.execute,
      );
      if (response.status !== 200) {
        return yield* new ModelsUnavailableError({ status: response.status });
      }
      const payload = yield* HttpClientResponse.schemaBodyJson(ModelsPayload)(response);
      return payload.models
        .filter((model) => model.visibility === undefined || model.visibility === "list")
        .map((model): CatalogModel => ({
          model: model.slug,
          efforts: (model.supported_reasoning_levels ?? []).map((level) => level.effort),
        }));
    });

    return { send, usage, models };
  });

/** The ChatGPT backend that serves Codex (`chatgpt.com/backend-api`). */
export class CodexUpstream extends Context.Service<
  CodexUpstream,
  Effect.Success<ReturnType<typeof make>>
>()("via/CodexUpstream") {
  static readonly layer = (options: CodexUpstreamOptions) =>
    Layer.effect(CodexUpstream, make(options));
}
