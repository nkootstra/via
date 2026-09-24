import { Context, Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { prepareBody, type ResponsesBody } from "./prepare-body.ts";

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

const CODEX_TUI_VERSION = "0.154.0";
const IDENTITIES = {
  cloaked: {
    originator: "codex-tui",
    "user-agent": `codex-tui/${CODEX_TUI_VERSION} (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; ${CODEX_TUI_VERSION})`,
  },
  plain: { originator: "via", "user-agent": "via/0.0.0" },
};

export type UpstreamAccount = { readonly accessToken: string; readonly accountId: string };

export type CodexUpstreamOptions = {
  readonly baseUrl?: string;
  /** Present requests as the official Codex TUI. */
  readonly cloak: boolean;
};

const make = ({ baseUrl = CODEX_BASE_URL, cloak }: CodexUpstreamOptions) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const identity = cloak ? IDENTITIES.cloaked : IDENTITIES.plain;

    /** Sends a Responses request as `account`; any status comes back for the caller to judge. */
    const send = Effect.fn("CodexUpstream.send")(function* (
      account: UpstreamAccount,
      body: ResponsesBody,
    ) {
      const sessionId =
        typeof body.prompt_cache_key === "string"
          ? body.prompt_cache_key
          : yield* Effect.sync(() => crypto.randomUUID());
      return yield* HttpClientRequest.post(`${baseUrl}/responses`).pipe(
        HttpClientRequest.setHeaders({
          ...identity,
          authorization: `Bearer ${account.accessToken}`,
          "chatgpt-account-id": account.accountId,
          session_id: sessionId,
          accept: "text/event-stream",
        }),
        HttpClientRequest.bodyJsonUnsafe(prepareBody(body)),
        http.execute,
      );
    });

    return { send };
  });

/** The ChatGPT Codex backend (`/backend-api/codex/responses`). */
export class CodexUpstream extends Context.Service<
  CodexUpstream,
  Effect.Success<ReturnType<typeof make>>
>()("via/CodexUpstream") {
  static readonly layer = (options: CodexUpstreamOptions) =>
    Layer.effect(CodexUpstream, make(options));
}
