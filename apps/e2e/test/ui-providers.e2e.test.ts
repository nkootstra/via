import { BunFileSystem } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { providerReply, startFakeProvider } from "@via/providers/testing";
import { Effect, Schema } from "effect";
import type { Page } from "playwright";
import {
  adminKey,
  json,
  launchVia,
  openPage,
  post,
  rowAction,
  signIn,
  startCodex,
  toast,
  type Via,
  visible,
  withBinary,
} from "./harness.ts";

const Models = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });

/** The ids of the models via lists at `/v1/models`. */
const modelIds = (via: Via) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      fetch(`${via.url}/v1/models`, { headers: { authorization: `Bearer ${via.key}` } }),
    );

    const { data } = yield* Schema.decodeUnknownEffect(Models)(yield* json(response));

    return data.map(({ id }) => id);
  });

/** A chat completion for `model` through via, as its status and body. */
const chatWith = (via: Via, model: string) =>
  Effect.gen(function* () {
    const response = yield* post(via, "/v1/chat/completions", {
      model,
      messages: [{ role: "user", content: "hi" }],
    });

    return { status: response.status, body: yield* json(response) };
  });

/** Fills the open dialog's `field` with `value` and submits it with Save. */
const saveDialog = (page: Page, field: string, value: string) =>
  Effect.gen(function* () {
    const dialog = page.getByRole("dialog");
    yield* Effect.promise(() => dialog.getByRole("textbox", { name: field }).fill(value));
    yield* Effect.promise(() => dialog.getByRole("button", { name: "Save" }).click());
  });

/** Signs in and opens the Accounts page. */
const openAccounts = (page: Page, via: Via) =>
  Effect.gen(function* () {
    yield* signIn(page, via.url);
    yield* Effect.promise(() => page.getByRole("link", { name: "Accounts" }).click());
    yield* visible(page, "Accounts");
  });

layer(BunFileSystem.layer)("providers in the admin UI", (it) => {
  it.effect.runIf(withBinary)(
    "adds an OpenRouter key and offers only the models chosen, keeping them when the key is replaced",
    () =>
      Effect.gen(function* () {
        const codex = yield* startCodex;
        const openrouter = yield* startFakeProvider;
        openrouter.openrouterKey("sk-or-first", { label: "sk-or-fir...", usage: 0, limit: null });
        openrouter.openrouterKey("sk-or-second", { label: "sk-or-sec...", usage: 0, limit: null });

        openrouter.models([
          {
            id: "openai/gpt-6",
            name: "OpenAI: GPT-6",
            pricing: { prompt: "0.000002", completion: "0.00001" },
            context_length: 400_000,
          },
          { id: "anthropic/claude-5", name: "Anthropic: Claude 5" },
        ]);

        openrouter.respond(providerReply.json({ id: "chatcmpl-or" }));

        // No apiKeyEnv: the key comes from the web UI, and this only moves where it goes.
        const via = yield* launchVia({
          upstream: codex.url,
          accounts: [{ name: "a" }],
          env: { VIA_ADMIN_KEY: adminKey },
          config: `providers:\n  openrouter:\n    baseUrl: ${openrouter.url}\n`,
        });

        const { page, problems } = yield* openPage("openrouter");
        yield* openAccounts(page, via);

        yield* Effect.promise(() =>
          page.getByRole("button", { name: "Add OpenRouter key" }).click(),
        );

        yield* visible(page, "Add an OpenRouter key");

        // A key OpenRouter refuses is never kept.
        yield* saveDialog(page, "API key", "sk-or-wrong");
        yield* Effect.promise(() => page.getByRole("dialog").getByText(/401/).first().waitFor());

        yield* saveDialog(page, "API key", "sk-or-first");
        yield* toast(page, "OpenRouter key added");

        // None of its models is offered until chosen.
        expect((yield* modelIds(via)).filter((id) => id.startsWith("openrouter/"))).toEqual([]);

        yield* rowAction(page, "OpenRouter", "Choose models…");
        yield* visible(page, "Choose OpenRouter models");
        const dialog = page.getByRole("dialog");
        yield* Effect.promise(() =>
          dialog.getByRole("searchbox", { name: "Search models" }).fill("gpt"),
        );
        yield* Effect.promise(() => dialog.getByRole("switch", { name: "OpenAI: GPT-6" }).click());
        yield* Effect.promise(() => dialog.getByRole("button", { name: "Save" }).click());
        yield* toast(page, "OpenRouter models saved");

        const listed = (yield* modelIds(via)).filter((id) => id.startsWith("openrouter/"));
        expect(listed).toEqual(["openrouter/openai/gpt-6"]);

        const served = yield* chatWith(via, "openrouter/openai/gpt-6");
        expect(served).toEqual({ status: 200, body: { id: "chatcmpl-or" } });

        expect(openrouter.requests.at(-1)).toMatchObject({
          headers: { authorization: "Bearer sk-or-first" },
          body: { model: "openai/gpt-6" },
        });

        const notChosen = yield* chatWith(via, "openrouter/anthropic/claude-5");
        expect(notChosen.status).toBe(404);
        expect(notChosen.body).toMatchObject({ error: { code: "model_not_found" } });

        // A new key keeps the models chosen.
        yield* rowAction(page, "OpenRouter", "Replace key…");
        yield* visible(page, "Replace the OpenRouter key");
        yield* saveDialog(page, "API key", "sk-or-second");
        yield* toast(page, "OpenRouter key replaced");

        expect((yield* chatWith(via, "openrouter/openai/gpt-6")).status).toBe(200);
        expect(openrouter.requests.at(-1)?.headers["authorization"]).toBe("Bearer sk-or-second");
        // Chromium logs the refused key's answer; nothing else went wrong.
        expect(problems).toEqual([
          "Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)",
        ]);
      }),
  );

  it.effect.runIf(withBinary)(
    "adds Ollama by its address and serves System One with it at once, until it is removed",
    () =>
      Effect.gen(function* () {
        const codex = yield* startCodex;
        const ollama = yield* startFakeProvider;
        ollama.ollama("0.35.0");
        ollama.models(["nimble"]);
        ollama.respond(providerReply.json({ answers: { label: "bug" } }));

        const via = yield* launchVia({
          upstream: codex.url,
          accounts: [{ name: "a" }],
          env: { VIA_ADMIN_KEY: adminKey },
        });

        const systemOne = (model: string) =>
          Effect.gen(function* () {
            const response = yield* post(via, "/v1/systemone", {
              model,
              state: "Checkout has returned 500s since 9am.",
              questions: {
                label: {
                  type: "choice",
                  instructions: "Which label fits?",
                  criteria: { billing: "Payments", bug: "Software errors" },
                },
              },
            });

            return { status: response.status, body: yield* json(response) };
          });

        const { page, problems } = yield* openPage("ollama");
        yield* openAccounts(page, via);

        yield* Effect.promise(() => page.getByRole("button", { name: "Add Ollama" }).click());
        yield* visible(page, "Add Ollama");
        yield* saveDialog(page, "Address", ollama.url);
        yield* toast(page, "Ollama added");

        const table = page.getByRole("table", { name: "Ollama" });
        yield* Effect.promise(() =>
          table
            .getByText(/0\.35\.0/)
            .first()
            .waitFor(),
        );

        expect(yield* systemOne("ollama/nimble")).toEqual({
          status: 200,
          body: { answers: { label: "bug" } },
        });

        expect(ollama.requests.at(-1)).toMatchObject({
          path: "/v1/systemone",
          body: { model: "nimble" },
        });

        // A model with no provider would go to Codex, which has no System One.
        expect((yield* systemOne("nimble")).status).toBe(400);

        yield* rowAction(page, "Ollama", "Remove…");
        yield* Effect.promise(() => page.getByRole("button", { name: "Remove Ollama" }).click());
        yield* toast(page, "Ollama removed");

        const afterRemoval = yield* systemOne("ollama/nimble");
        expect(afterRemoval).toMatchObject({
          status: 400,
          body: { error: { code: "invalid_request" } },
        });
        expect(ollama.requests).toHaveLength(1);
        expect(problems).toEqual([]);
      }),
  );
});
