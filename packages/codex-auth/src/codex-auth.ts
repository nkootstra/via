import { Context, Duration, Effect, Layer, Option, Predicate, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { JwtPayload } from "./claims.ts";
import { AuthRequestError } from "./errors.ts";

const ISSUER = "https://auth.openai.com";

export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const LOGIN_TIMEOUT = Duration.minutes(15);

/** How long one request to the issuer may take, which it answers at once. */
const REQUEST_TIMEOUT = Duration.seconds(30);

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

// The issuer may omit tokens it does not rotate; the caller keeps its current ones.
const RefreshResponse = Schema.Struct({
  access_token: Schema.String,
  id_token: Schema.optionalKey(Schema.String),
  refresh_token: Schema.optionalKey(Schema.String),
});

// Codes meaning the refresh token is dead and the account has to log in again.
const RejectedCode = Schema.Literals([
  "invalid_grant",
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
]);

const RefreshErrorBody = Schema.Struct({
  error: Schema.Union([RejectedCode, Schema.Struct({ code: RejectedCode })]),
});

const AccessTokenExpiry = JwtPayload(Schema.Struct({ exp: Schema.Finite }));

export class DeviceLoginTimeoutError extends Schema.TaggedError<DeviceLoginTimeoutError>()(
  "DeviceLoginTimeoutError",
  {},
) {
  override get message() {
    return `Device login was not approved within ${Duration.format(LOGIN_TIMEOUT)}`;
  }
}

export class RefreshRejectedError extends Schema.TaggedError<RefreshRejectedError>()(
  "RefreshRejectedError",
  { code: Schema.String },
) {
  override get message() {
    return `The refresh token was rejected (${this.code}); log in to this account again`;
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

/** `effect`, failing once it has run for `REQUEST_TIMEOUT`, as a request the issuer never answered. */
const answeredInTime = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.timeoutOrElse(effect, {
    duration: REQUEST_TIMEOUT,
    orElse: () =>
      Effect.fail(
        new AuthRequestError({ reason: `no answer within ${Duration.format(REQUEST_TIMEOUT)}` }),
      ),
  });

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
      answeredInTime,
      Effect.withSpan("CodexAuth.requestDeviceCode"),
    );

    // 403/404 mean the user has not approved yet. A poll is not timed on its own:
    // `LOGIN_TIMEOUT` ends the wait for approval, polls and all.
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
        // Not `mapError`: the poll's own AuthRequestError passes through as is.
        Effect.catchTag(["HttpClientError", "SchemaError"], (error) =>
          Effect.fail(toAuthRequestError(error)),
        ),
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
        answeredInTime,
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

    const refresh = Effect.fn("CodexAuth.refresh")(function* (current: Tokens) {
      const response = yield* HttpClientRequest.post(`${issuer}/oauth/token`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
          scope: "openid profile email",
        }),
        http.execute,
        Effect.mapError(toAuthRequestError),
      );

      if (response.status === 400 || response.status === 401) {
        const rejected = yield* decodeJson(RefreshErrorBody)(response).pipe(Effect.option);

        if (Option.isSome(rejected)) {
          const { error } = rejected.value;

          return yield* new RefreshRejectedError({
            code: Predicate.isString(error) ? error : error.code,
          });
        }
      }

      if (response.status !== 200) {
        return yield* new AuthRequestError({
          reason: `token refresh returned HTTP ${response.status}`,
        });
      }

      return yield* decodeJson(RefreshResponse)(response).pipe(
        Effect.flatMap((body) =>
          toTokens({
            access_token: body.access_token,
            id_token: body.id_token ?? current.idToken,
            refresh_token: body.refresh_token ?? current.refreshToken,
          }),
        ),
        Effect.mapError(toAuthRequestError),
      );
    }, answeredInTime);

    return { requestDeviceCode, awaitDeviceTokens, refresh };
  });

/** OpenAI (ChatGPT) OAuth for Codex: device-code login and token refresh. */
export class CodexAuth extends Context.Service<
  CodexAuth,
  Effect.Success<ReturnType<typeof make>>
>()("via/CodexAuth") {
  static readonly layer = (issuer: string = ISSUER) => Layer.effect(CodexAuth, make(issuer));
}
