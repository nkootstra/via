import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";
import { clientOf } from "./client.ts";

describe("clientOf", () => {
  it("names the harness and its version from the User-Agent's first product", () => {
    expect(clientOf({ "user-agent": "opencode/1.19.3 ai-sdk/provider-utils/3.0.0" })).toEqual(
      Option.some("opencode/1.19.3"),
    );

    expect(
      clientOf({
        "user-agent": "codex_cli_rs/0.40.0 (Mac OS 15.5.0; arm64) iTerm.app/3.5.14",
        originator: "codex_cli_rs",
      }),
    ).toEqual(Option.some("codex_cli_rs/0.40.0"));

    expect(clientOf({ "user-agent": "claude-cli/2.0.14 (external, cli)" })).toEqual(
      Option.some("claude-cli/2.0.14"),
    );
  });

  it("finds the version among a product's other segments", () => {
    expect(
      clientOf({
        "user-agent": "opencode/latest/2.0.32/cli",
        "x-opencode-client": "cli",
        "x-opencode-project": "global",
      }),
    ).toEqual(Option.some("opencode/2.0.32"));

    expect(clientOf({ "user-agent": "opencode/beta/2.1.0-beta.3/cli" })).toEqual(
      Option.some("opencode/2.1.0-beta.3"),
    );

    expect(clientOf({ "user-agent": "opencode/latest/cli" })).toEqual(
      Option.some("opencode/latest"),
    );
  });

  it("takes the harness's own header over an OpenAI SDK's User-Agent", () => {
    expect(clientOf({ "user-agent": "OpenAI/JS 5.10.1", "x-title": "Roo Code" })).toEqual(
      Option.some("Roo Code"),
    );

    expect(clientOf({ "user-agent": "OpenAI/JS 5.10.1" })).toEqual(Option.some("OpenAI/JS"));
    expect(clientOf({ originator: "codex_cli_rs" })).toEqual(Option.some("codex_cli_rs"));
  });

  it("keeps nothing it can't read as a client's name", () => {
    expect(clientOf({})).toEqual(Option.none());
    expect(clientOf({ "user-agent": "" })).toEqual(Option.none());
    expect(clientOf({ "user-agent": "(compatible)" })).toEqual(Option.none());
    expect(clientOf({ "x-title": "line\nbreak" })).toEqual(Option.none());
  });

  it.prop(
    "names a client in at most 64 printable characters",
    { userAgent: Schema.optional(Schema.String), title: Schema.optional(Schema.String) },
    ({ userAgent, title }) => {
      const client = clientOf({ "user-agent": userAgent, "x-title": title });

      return Option.match(client, {
        onNone: () => true,
        onSome: (name) => name.length > 0 && name.length <= 64 && /^[\x20-\x7e]+$/.test(name),
      });
    },
  );

  it.prop(
    "names a User-Agent's product by at most its name and one version",
    { userAgent: Schema.String },
    ({ userAgent }) =>
      Option.match(clientOf({ "user-agent": userAgent }), {
        onNone: () => true,
        onSome: (name) => name.split("/").length <= 2,
      }),
  );
});
