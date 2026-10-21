import { describe, expect, it } from "@effect/vitest";
import { Arbitrary, Predicate, Schema } from "effect";
import { capped, redact } from "./redact.ts";

const alnum = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** `length` characters of `alphabet`, from `seed`'s numbers. */
const pick = (alphabet: string, seed: ReadonlyArray<number>, length: number) =>
  Array.from({ length }, (_, i) => alphabet[(seed[i % seed.length] ?? i) % alphabet.length]).join(
    "",
  );

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject => Predicate.isObject(value);

/** `value`'s outline: every key and array length, with each string as only a string. */
const outline = (value: Schema.Json): Schema.Json => {
  if (Predicate.isString(value)) return "string";

  if (Array.isArray(value)) return value.map(outline);

  if (isJsonObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, outline(inner)]));
  }

  return value;
};

const size = (value: Schema.Json) => new TextEncoder().encode(JSON.stringify(value)).length;

/** A secret of each kind via knows, made from a seed. */
const secrets = (seed: ReadonlyArray<number>) => [
  `sk-${pick(alnum, seed, 40)}`,
  `sk-proj-${pick(alnum, seed, 48)}`,
  `sk-ant-api03-${pick(alnum, seed, 40)}`,
  `ghp_${pick(alnum, seed, 36)}`,
  `github_pat_${pick(alnum, seed, 60)}`,
  `AKIA${pick("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", seed, 16)}`,
  `AIza${pick(alnum, seed, 35)}`,
  `xoxb-${pick(alnum, seed, 30)}`,
];

/** What `redact` makes of `text`, as a lone string. */
const redactedText = (text: string) => redact(text).value;

describe("redact", () => {
  it.each([
    ["openai-key", "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD"],
    ["openai-key", "sk-proj-Ab3dEfGh1jKlMnOpQrStUvWxYz0123456789_-abcd"],
    ["anthropic-key", "sk-ant-api03-Ab3dEfGh1jKlMnOpQrStUvWxYz0123456789-abcd"],
    ["openrouter-key", `sk-or-v1-${"0a1b2c3d".repeat(8)}`],
    ["github-token", "ghp_Ab3dEfGh1jKlMnOpQrStUvWxYz0123456789"],
    ["github-token", "gho_Ab3dEfGh1jKlMnOpQrStUvWxYz0123456789"],
    ["github-token", "ghs_Ab3dEfGh1jKlMnOpQrStUvWxYz0123456789"],
    ["github-token", "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["aws-access-key", "AKIAIOSFODNN7EXAMPLE"],
    ["google-api-key", "AIzaSyA-1234567890abcdefghijklmnopqrstu"],
    // Assembled so no token-shaped literal sits in the source.
    ["slack-token", ["xoxb", "1234567890", "0987654321", "AbCdEfGhIjKlMnOpQrStUvWx"].join("-")],
    [
      "jwt",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ],
  ])("replaces a %s with a marker", (kind, secret) => {
    const { value, redactions } = redact(`my key is ${secret}, keep it safe`);

    expect(value).toBe(`my key is [redacted:${kind}], keep it safe`);
    expect(redactions).toEqual([{ kind, count: 1 }]);
  });

  it("replaces a PEM private key block whole", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB",
      "aFDrBz9vFqU4yMBHsFbBRm6xHBmNHmD4bJyv0gDq8hTdkWbWjbd3gAzVXX4vU5eG",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");

    expect(redactedText(`key:\n${pem}\ndone`)).toBe("key:\n[redacted:private-key]\ndone");
  });

  it("keeps the scheme of a bearer token or an Authorization header, not the credential", () => {
    expect(redactedText("curl -H 'Authorization: Bearer abc123def456ghi789'")).toBe(
      "curl -H 'Authorization: Bearer [redacted:bearer-token]'",
    );
    expect(redactedText("Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==")).toBe(
      "Authorization: Basic [redacted:authorization]",
    );
  });

  it("leaves bearer in prose alone", () => {
    expect(redactedText("the bearer instruments of the past")).toBe(
      "the bearer instruments of the past",
    );
  });

  it("replaces an AWS secret key assigned by name", () => {
    expect(redactedText("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toBe(
      "aws_secret_access_key = [redacted:aws-secret-key]",
    );
  });

  it("replaces a high-entropy value assigned to a secret-looking name, in text", () => {
    expect(redactedText("export STRIPE_API_KEY=rk9Xq2LmZ7pW4tYc8vBn")).toBe(
      "export STRIPE_API_KEY=[redacted:secret]",
    );
    expect(redactedText('config = { "api_key": "Zq8Lm2Xp9Wt4Yc7Vb3Nn" }')).toBe(
      'config = { "api_key": "[redacted:secret]" }',
    );
  });

  it("leaves a low-entropy or short value assigned to a secret-looking name", () => {
    expect(redactedText("max_tokens=4096")).toBe("max_tokens=4096");
    expect(redactedText("password = hunter2")).toBe("password = hunter2");
    expect(redactedText("token: aaaaaaaaaaaaaaaaaaaa")).toBe("token: aaaaaaaaaaaaaaaaaaaa");
  });

  it("replaces a high-entropy value under a secret-looking key, in JSON", () => {
    const { value, redactions } = redact({
      api_key: "Zq8Lm2Xp9Wt4Yc7Vb3Nn",
      max_tokens: 4096,
      token: "Hello",
    });

    expect(value).toEqual({ api_key: "[redacted:secret]", max_tokens: 4096, token: "Hello" });
    expect(redactions).toEqual([{ kind: "secret", count: 1 }]);
  });

  it("counts each kind it replaced", () => {
    const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD";

    const { redactions } = redact({
      messages: [
        { role: "user", content: `${key} and ${key}` },
        { role: "user", content: "AKIAIOSFODNN7EXAMPLE" },
      ],
    });

    expect(redactions).toEqual([
      { kind: "aws-access-key", count: 1 },
      { kind: "openai-key", count: 2 },
    ]);
  });

  it("replaces an image sent as a data URL with what it was", () => {
    const png = `data:image/png;base64,${"A".repeat(4 * 1024 * 100)}`;

    const { value, redactions } = redact({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: png } },
          ],
        },
      ],
    });

    expect(value).toEqual({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: "[image: png, 300 KB]" } },
          ],
        },
      ],
    });
    expect(redactions).toEqual([{ kind: "image", count: 1 }]);
  });

  it("replaces a Responses input_image and input_file with what they were", () => {
    const { value } = redact({
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: `data:image/jpeg;base64,${"QUJD".repeat(256)}` },
            { type: "input_file", filename: "report.pdf", file_data: "JVBERi0x".repeat(512) },
          ],
        },
      ],
    });

    expect(value).toEqual({
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: "[image: jpeg, 768 B]" },
            { type: "input_file", filename: "report.pdf", file_data: "[file: pdf, 3 KB]" },
          ],
        },
      ],
    });
  });

  it("leaves an image sent by its address", () => {
    const sent = { type: "input_image", image_url: "https://example.com/cat.png" };

    expect(redact(sent).value).toEqual(sent);
  });

  it.each([
    ["Basic dXNlcjpwYXNz", "Basic [redacted:authorization]"],
    ["Token abcdefghijklmnop", "Token [redacted:authorization]"],
    ["ApiKey abcdefghijklmnop", "ApiKey [redacted:authorization]"],
    ["Bearer abc", "Bearer [redacted:authorization]"],
    ["opaque credential", "[redacted:authorization]"],
  ])("replaces the credential of an Authorization header in JSON: %s", (sent, kept) => {
    expect(redact({ headers: { Authorization: sent } }).value).toEqual({
      headers: { Authorization: kept },
    });
  });

  it("replaces a cookie header's value in JSON", () => {
    expect(
      redact({ headers: { Cookie: "session=abc; theme=dark", "set-cookie": "id=x" } }).value,
    ).toEqual({ headers: { Cookie: "[redacted:cookie]", "set-cookie": "[redacted:cookie]" } });
  });

  it("replaces the credential after a scheme under any secret-named key", () => {
    expect(redact({ token: "Bearer abcdef" }).value).toEqual({
      token: "Bearer [redacted:secret]",
    });
  });

  it("replaces a credential under a camelCase secret-named key", () => {
    const secret = "Zq8Lm2Xp9Wt4Yc7Vb3Nn";
    const named = ["accessToken", "clientSecret", "refreshToken", "authToken", "githubToken"];

    expect(redact(Object.fromEntries(named.map((name) => [name, secret]))).value).toEqual(
      Object.fromEntries(named.map((name) => [name, "[redacted:secret]"])),
    );
  });

  it("replaces secrets in an array under a secret-named key", () => {
    expect(redact({ api_keys: ["Zq8Lm2Xp9Wt4Yc7Vb3Nn", "Hello"] }).value).toEqual({
      api_keys: ["[redacted:secret]", "Hello"],
    });
  });

  it.each([
    ["Authorization: opaqueCred3ntial", "Authorization: [redacted:authorization]"],
    ["Authorization: Custom abcdef123456", "Authorization: Custom [redacted:authorization]"],
    ["Proxy-Authorization: Token abcdefgh", "Proxy-Authorization: Token [redacted:authorization]"],
    ["Cookie: session=abc123; theme=dark", "Cookie: [redacted:cookie]"],
    ["Set-Cookie: id=a3fWa; Max-Age=2592000", "Set-Cookie: [redacted:cookie]"],
  ])("replaces a header's credential in text: %s", (sent, kept) => {
    expect(redactedText(`> ${sent}\nnext line`)).toBe(`> ${kept}\nnext line`);
  });

  it("leaves Authorization and cookies in prose alone", () => {
    expect(redactedText("Authorization: required for everything")).toBe(
      "Authorization: required for everything",
    );
    expect(redactedText("cookie: chocolate chip")).toBe("cookie: chocolate chip");
  });

  it("replaces a PEM private key cut off before its end, to the end of the text", () => {
    const head = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
    ].join("\n");

    expect(redactedText(`error: bad key\n${head}`)).toBe("error: bad key\n[redacted:private-key]");
  });

  it("redacts many unfinished PEM headers in linear time", () => {
    const text = "-----BEGIN PRIVATE KEY-----\n".repeat(20_000);
    const started = performance.now();

    expect(redactedText(text)).toBe("[redacted:private-key]");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("leaves text with no secret in it as it was", () => {
    const body = {
      model: "gpt-6",
      stream: true,
      messages: [{ role: "user", content: "Explain how JWTs and API keys differ." }],
    };

    expect(redact(body)).toEqual({ value: body, redactions: [] });
  });
});

describe("redact, as properties", () => {
  const seeds = Arbitrary.array(
    Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000 }))),
    { minLength: 1, maxLength: 64 },
  );

  const prose = Arbitrary.schema(Schema.String);

  it.prop(
    "never keeps a known secret, wherever it is",
    { seed: seeds, before: prose, after: prose },
    ({ seed, before, after }) =>
      secrets(seed).every((secret) => {
        const text = `${before} ${secret} ${after}`;
        const body = { messages: [{ content: text }], nested: [[text]] };

        return !JSON.stringify(redact(body).value).includes(secret);
      }),
  );

  const names = Arbitrary.schema(
    Schema.Literals([
      "api_key",
      "apiKey",
      "API-KEY",
      "x-api-key",
      "accessToken",
      "client_secret",
      "clientSecret",
      "refresh_token",
      "GITHUB_TOKEN",
      "password",
      "Authorization",
      "proxy-authorization",
    ]),
  );

  const scheme = Arbitrary.schema(
    Schema.Literals(["", "Basic ", "Bearer ", "Token ", "ApiKey ", "Digest "]),
  );

  it.prop(
    "never keeps a random credential under a secret-named key, however it's nested",
    { name: names, seed: seeds, scheme },
    ({ name, seed, scheme: prefix }) => {
      // Random enough to be a secret, whatever the seed.
      const secret = `${pick(alnum, seed, 8)}Zq8Lm2Xp9Wt4Yc7V`;
      const value = `${prefix}${secret}`;

      const body = {
        headers: { [name]: value },
        [name]: [value, { [name]: value }],
        text: `${name}: ${value}`,
      };

      expect(JSON.stringify(redact(body).value)).not.toContain(secret);
    },
  );

  it.prop(
    "never keeps a private key's body, finished or cut off",
    {
      seed: seeds,
      cut: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 40 }))),
      before: prose,
    },
    ({ seed, cut, before }) => {
      const key = `MIIE${pick(alnum, seed, 40)}`;
      const pem = `-----BEGIN RSA PRIVATE KEY-----\n${key}\n-----END RSA PRIVATE KEY-----`;
      const text = `${before}\n${pem.slice(0, pem.indexOf(key) + key.length + cut)}`;

      expect(JSON.stringify(redact(text).value)).not.toContain(key);
    },
  );

  const json = Arbitrary.schema(Schema.Json);

  it.prop(
    "keeps the JSON's keys, array lengths and every non-string value",
    { json },
    ({ json: value }) => {
      expect(outline(redact(value).value)).toEqual(outline(value));
    },
  );

  it.prop(
    "changes nothing more when run again",
    { json, seed: seeds, text: prose },
    ({ json: value, seed, text }) => {
      const once = redact({
        json: value,
        text: `${text} ${secrets(seed).join(" ")} Authorization: ${pick(alnum, seed, 20)}`,
        headers: { Authorization: `Basic ${text}`, Cookie: `a=${text}` },
        tokens: [text],
      });

      const twice = redact(once.value);

      expect(twice).toEqual({ value: once.value, redactions: [] });
    },
  );
});

describe("capped", () => {
  it("leaves JSON that fits as it was", () => {
    const body = { messages: [{ content: "hello" }] };

    expect(capped(body, 1_000)).toEqual({ value: body, truncated: false });
  });

  it("cuts the longest strings until the JSON fits, and says so", () => {
    const body = { short: "hello", messages: [{ content: "x".repeat(10_000) }] };
    const { value, truncated } = capped(body, 1_000);

    expect(truncated).toBe(true);
    expect(size(value)).toBeLessThanOrEqual(1_000);
    expect(value).toMatchObject({ short: "hello" });
  });

  it.prop(
    "always fits, and keeps the shape when only strings had to be cut",
    {
      json: Arbitrary.schema(Schema.Json),
      limit: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 4_000 }))),
    },
    ({ json, limit }) => {
      const { value, truncated } = capped(json, limit);

      expect(size(value)).toBeLessThanOrEqual(limit);

      if (!truncated) expect(value).toEqual(json);
    },
  );
});
