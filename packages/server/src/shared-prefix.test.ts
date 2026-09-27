import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { Arbitrary } from "effect/unstable/arbitrary";
import { withSharedPrefix } from "./shared-prefix.ts";

const system = (session: string) =>
  [
    "You are an AI agent running in OpenCode.",
    "<env>",
    `  Current conversation session ID: ${session}`,
    "  Working directory: /work",
    "</env>",
    "Skills provide specialized instructions.",
  ].join("\n");

const subAgent = (session: string, task: Schema.Json) => ({
  model: "m",
  messages: [
    { role: "system", content: system(session) },
    { role: "user", content: task },
  ],
  tools: [{ type: "function", function: { name: "read" } }],
});

/** An opencode session id made from any text; the id sits on one line. */
const id = (text: string) => `ses_${text.replaceAll(/[\r\n]/g, "")}`;

/** A request, serialized, up to its first user message. */
const prefix = (session: string, task: string) =>
  JSON.stringify(withSharedPrefix(subAgent(session, task))).split('"role":"user"')[0];

describe("withSharedPrefix", () => {
  it("moves opencode's session line from the system prompt to the first user message", () => {
    expect(withSharedPrefix(subAgent("ses_a", "Tell a joke."))).toEqual({
      model: "m",
      messages: [
        {
          role: "system",
          content: [
            "You are an AI agent running in OpenCode.",
            "<env>",
            "  Working directory: /work",
            "</env>",
            "Skills provide specialized instructions.",
          ].join("\n"),
        },
        { role: "user", content: "Current conversation session ID: ses_a\n\nTell a joke." },
      ],
      tools: [{ type: "function", function: { name: "read" } }],
    });
  });

  it("puts the line in a text part of its own when the user message has parts", () => {
    const moved = withSharedPrefix(subAgent("ses_a", [{ type: "text", text: "Tell a joke." }]));
    expect(moved["messages"]).toEqual([
      expect.anything(),
      {
        role: "user",
        content: [
          { type: "text", text: "Current conversation session ID: ses_a" },
          { type: "text", text: "Tell a joke." },
        ],
      },
    ]);
  });

  it("moves the line only into the first user message, leaving later turns as they are", () => {
    const later = [
      { role: "assistant", content: "Why did the chicken cross the road?" },
      { role: "user", content: "Why?" },
    ];

    const body = subAgent("ses_a", "Tell a joke.");
    const moved = withSharedPrefix({ ...body, messages: [...body.messages, ...later] });
    expect(moved["messages"]).toEqual([
      expect.anything(),
      { role: "user", content: "Current conversation session ID: ses_a\n\nTell a joke." },
      ...later,
    ]);
  });

  it.prop(
    "gives two sessions' requests the same bytes up to their first user message",
    {
      a: Arbitrary.schema(Schema.String),
      b: Arbitrary.schema(Schema.String),
    },
    ({ a, b }) => {
      expect(prefix(id(a), "cats")).toBe(prefix(id(b), "dogs"));
    },
  );

  it("leaves a request without the line as it is", () => {
    const body = { model: "m", messages: [{ role: "system", content: "Be brief." }] };
    expect(withSharedPrefix(body)).toBe(body);
  });

  it("leaves the line where it is when there is no user message to take it", () => {
    const body = { model: "m", messages: [{ role: "system", content: system("ses_a") }] };
    expect(withSharedPrefix(body)).toBe(body);
  });

  it("leaves the line where it is when the user message has neither text nor parts", () => {
    const body = subAgent("ses_a", null);
    expect(withSharedPrefix(body)).toBe(body);
  });
});
