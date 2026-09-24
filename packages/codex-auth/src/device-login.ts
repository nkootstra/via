import { Context, Duration, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

export const ISSUER = "https://auth.openai.com";
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const LOGIN_TIMEOUT = Duration.minutes(15);

const UserCodeResponse = Schema.Struct({
  device_auth_id: Schema.String,
  user_code: Schema.String,
  interval: Schema.Union([Schema.Finite, Schema.FiniteFromString]),
});
const ApprovedCode = Schema.Struct({
  authorization_code: Schema.String,
  code_verifier: Schema.String,
});
const TokenResponse = Schema.Struct({
  id_token: Schema.String,
  access_token: Schema.String,
  refresh_token: Schema.String,
});
const AccessTokenExpiry = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(Schema.fromJsonString(Schema.Struct({ exp: Schema.Finite }))),
);

export class AuthRequestError extends Schema.TaggedError<AuthRequestError>()("AuthRequestError", {
  reason: Schema.String,
}) {
  override get message() {
    return `OpenAI auth request failed: ${this.reason}`;
  }
}

export class DeviceLoginTimeoutError extends Schema.TaggedError<DeviceLoginTimeoutError>()(
  "DeviceLoginTimeoutError",
  {},
) {
  override get message() {
    return `Device login was not approved within ${Duration.format(LOGIN_TIMEOUT)}`;
  }
}

export type DeviceCode = {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
};

export type Tokens = {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

const decodeJson =
  <S extends Schema.Codec<unknown, unknown>>(schema: S) =>
  (response: HttpClientResponse.HttpClientResponse) =>
    response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));

const toAuthRequestError = (error: { message: string }) =>
  new AuthRequestError({ reason: error.message });
const failAuthRequest = (error: { message: string }) => Effect.fail(toAuthRequestError(error));

const toTokens = Effect.fn("toTokens")(function* (response: typeof TokenResponse.Type) {
  const [, payload = ""] = response.access_token.split(".");
  const { exp } = yield* Schema.decodeEffect(AccessTokenExpiry)(payload);
  return {
    idToken: response.id_token,
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: exp * 1000,
  } satisfies Tokens;
});

const make = (issuer: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const httpOk = http.pipe(HttpClient.filterStatusOk);

    const requestDeviceCode = HttpClientRequest.post(
      `${issuer}/api/accounts/deviceauth/usercode`,
    ).pipe(
      HttpClientRequest.bodyJsonUnsafe({ client_id: CLIENT_ID }),
      httpOk.execute,
      Effect.flatMap(decodeJson(UserCodeResponse)),
      Effect.map((body): DeviceCode => ({
        deviceAuthId: body.device_auth_id,
        userCode: body.user_code,
        verificationUrl: `${issuer}/codex/device`,
        intervalSeconds: body.interval,
      })),
      Effect.mapError(toAuthRequestError),
      Effect.withSpan("CodexAuth.requestDeviceCode"),
    );

    // 403/404 mean the user has not approved yet.
    const pollOnce = (code: DeviceCode) =>
      HttpClientRequest.post(`${issuer}/api/accounts/deviceauth/token`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          device_auth_id: code.deviceAuthId,
          user_code: code.userCode,
        }),
        http.execute,
        Effect.flatMap(
          HttpClientResponse.matchStatus({
            200: (response) => decodeJson(ApprovedCode)(response).pipe(Effect.asSome),
            403: () => Effect.succeedNone,
            404: () => Effect.succeedNone,
            orElse: (response) =>
              Effect.fail(
                new AuthRequestError({
                  reason: `device token poll returned HTTP ${response.status}`,
                }),
              ),
          }),
        ),
        Effect.catchTags({ HttpClientError: failAuthRequest, SchemaError: failAuthRequest }),
      );

    const awaitApproval = Effect.fn("CodexAuth.awaitApproval")(function* (code: DeviceCode) {
      while (true) {
        const approved = yield* pollOnce(code);
        if (Option.isSome(approved)) return approved.value;
        yield* Effect.sleep(Duration.seconds(code.intervalSeconds));
      }
    });

    const exchangeCode = (approved: typeof ApprovedCode.Type) =>
      HttpClientRequest.post(`${issuer}/oauth/token`).pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: "authorization_code",
          code: approved.authorization_code,
          redirect_uri: `${issuer}/deviceauth/callback`,
          client_id: CLIENT_ID,
          code_verifier: approved.code_verifier,
        }),
        httpOk.execute,
        Effect.flatMap(decodeJson(TokenResponse)),
        Effect.flatMap(toTokens),
        Effect.mapError(toAuthRequestError),
      );

    const awaitDeviceTokens = Effect.fn("CodexAuth.awaitDeviceTokens")(function* (
      code: DeviceCode,
    ) {
      const approved = yield* awaitApproval(code).pipe(
        Effect.timeoutOrElse({
          duration: LOGIN_TIMEOUT,
          orElse: () => Effect.fail(new DeviceLoginTimeoutError()),
        }),
      );
      return yield* exchangeCode(approved);
    });

    return { requestDeviceCode, awaitDeviceTokens };
  });

/** OpenAI (ChatGPT) OAuth for Codex: device-code login. */
export class CodexAuth extends Context.Service<
  CodexAuth,
  Effect.Success<ReturnType<typeof make>>
>()("via/CodexAuth") {
  static readonly layer = (issuer: string = ISSUER) => Layer.effect(CodexAuth, make(issuer));
}
