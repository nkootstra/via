import { Effect, Schema } from "effect";

const IdTokenClaims = Schema.Struct({
  email: Schema.String,
  "https://api.openai.com/auth": Schema.Struct({
    chatgpt_account_id: Schema.String,
    chatgpt_plan_type: Schema.String,
  }),
});

const IdTokenPayload = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(Schema.fromJsonString(IdTokenClaims)),
);

export class InvalidIdTokenError extends Schema.TaggedError<InvalidIdTokenError>()(
  "InvalidIdTokenError",
  { reason: Schema.String },
) {
  override get message() {
    return `Invalid ID token: ${this.reason}`;
  }
}

export type IdentityClaims = { email: string; accountId: string; plan: string };

/** Reads identity claims from an OpenAI ID token. The signature is not verified: we received it directly from the issuer over TLS. */
export const decodeIdToken = Effect.fn("decodeIdToken")(function* (idToken: string) {
  const [, payload] = idToken.split(".");

  if (payload === undefined) return yield* new InvalidIdTokenError({ reason: "not a JWT" });

  const claims = yield* Schema.decodeEffect(IdTokenPayload)(payload).pipe(
    Effect.mapError((error) => new InvalidIdTokenError({ reason: error.message })),
  );

  const auth = claims["https://api.openai.com/auth"];

  return {
    email: claims.email,
    accountId: auth.chatgpt_account_id,
    plan: auth.chatgpt_plan_type,
  } satisfies IdentityClaims;
});
