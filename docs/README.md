# via

Pool several ChatGPT/Codex subscriptions behind one OpenAI-compatible endpoint
on your machine.

via logs in to each of your ChatGPT accounts, hands out its own API keys, and
serves `/v1/responses`, `/v1/chat/completions` and `/v1/models` on
`127.0.0.1:8317`. Each request goes to the first account that still has
capacity; when one hits its rate limit, via moves on to the next. It can also
pass requests on to OpenAI-compatible providers such as OpenRouter and
OpenCode Go.

> **Status:** pre-release (`0.0.0`). Commands and file formats may still change.

## Platforms

macOS and Linux, on arm64 and x64. There is no Windows build.

## Install

Prebuilt npm packages are coming. Until then, build from source with
[Bun](https://bun.sh) 1.4:

```sh
git clone https://github.com/nkootstra/via.git
cd via
bun install
cd npm && bun build.ts --host
```

That writes a standalone binary to `npm/via-<os>-<arch>/bin/via`, for example
`npm/via-darwin-arm64/bin/via`. Copy it onto your `PATH`. It doesn't need Bun
or Node to run.

## Quick start

```sh
# 1. Add an account. Repeat for each subscription you want in the pool.
via accounts add
# Open https://auth.openai.com/codex/device and enter the code <code>

# 2. Create an API key for your clients. It is shown only once.
via keys create --name laptop

# 3. Serve.
via serve
```

Point any OpenAI client at it:

```sh
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer $VIA_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-6-astra", "messages": [{"role": "user", "content": "Hello"}]}'
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8317/v1", api_key="via_...")
reply = client.responses.create(model="gpt-6-astra-high", input="Hello")
print(reply.output_text)
```

## API

Every route needs `Authorization: Bearer <key>` with a key from `via keys create`.

| Route                       | What it does                                                  |
| --------------------------- | ------------------------------------------------------------- |
| `POST /v1/responses`        | Passed through to the Codex backend.                          |
| `POST /v1/chat/completions` | Translated to and from the Responses API, streaming included. |
| `GET /v1/models`            | Lists the models Codex offers your accounts, then providers'. |

A model named `<provider>/<model>` goes to that [provider](#providers) instead.

`/v1/models` lists what the Codex model picker shows your accounts, combined,
since plans offer different models. So new models appear without a via update.
via fetches the list as it starts and answers from it at once; once it is five
minutes old, via fetches a new one in the background for the next request. When Codex can't be
asked, it lists the models via knows: `gpt-6-astra`, `gpt-6-sol` and
`gpt-6-luna`.

Add an effort suffix to a model id to pick the reasoning effort, as in
`gpt-6-astra-high`. The list shows each model with the suffixes it supports,
from `-none`, `-low`, `-medium`, `-high`, `-xhigh`, `-max` and `-ultra`. Other
model ids are passed through to Codex unchanged.

## Commands

| Command                                  | What it does                                                  |
| ---------------------------------------- | ------------------------------------------------------------- |
| `via accounts add`                       | Log in to a ChatGPT account with a device code.               |
| `via accounts list`                      | List accounts in the order they are used.                     |
| `via accounts status`                    | Show how much of each account's 5h and weekly limits is used. |
| `via accounts label <account> <label>`   | Rename an account.                                            |
| `via accounts disable <account>`         | Stop using an account without removing it.                    |
| `via accounts enable <account>`          | Use it again.                                                 |
| `via accounts remove <account>`          | Forget an account and delete its tokens.                      |
| `via keys create --name <name>`          | Create an API key. It is printed once.                        |
| `via keys list`                          | List keys.                                                    |
| `via keys revoke <id-or-name>`           | Revoke a key.                                                 |
| `via serve [--host <addr>] [--port <n>]` | Serve the API in the foreground.                              |

`<account>` matches an account's id, label or email.

## How the pool picks an account

- Accounts are used **fill-first**, in the order you added them: via stays on
  the first account until it can't serve a request.
- Plans differ, so a model goes only to accounts whose model list includes it,
  such as `daybreak` or `daybreak-high` to the one account that offers
  `daybreak`. A model no account's list includes is tried on every account
  anyway, as it may be newer than the list.
- A rate-limit or usage-limit answer puts that account on a cooldown until the
  reset time the upstream gives, or 30 minutes if it gives none. A server error
  (5xx) cools it down for 1 minute. Either way, via retries on the next account.
- A 401 makes via refresh the account's token and retry once. If that fails, the
  account is taken out of use. Log in to it again with `via accounts add`, then
  restart `via serve`.
- When no account is left, the client gets `429` with a `Retry-After` header
  (or `503` if waiting won't help). For a model only some accounts offer, only
  those accounts count.
- Running cooldowns are saved in `state.json`, so a restarted `via serve` keeps
  them. Lockouts aren't saved: a restart gives a locked-out account one more try.

## Configuration

via keeps everything in `~/.config/via`, or in `$VIA_HOME` if it's set.

| File             | Contents                                            |
| ---------------- | --------------------------------------------------- |
| `config.yaml`    | Optional settings; you write it, via only reads it. |
| `keys.json`      | SHA-256 hashes of your API keys.                    |
| `auth/<id>.json` | One account's OAuth tokens.                         |
| `state.json`     | Running cooldowns; safe to delete.                  |

`config.yaml`, with the defaults:

```yaml
host: 127.0.0.1
port: 8317
codex:
  # Present requests to the upstream as the official Codex CLI.
  cloak: true
```

`via serve --host` and `--port` override the file.

### Providers

Add OpenAI-compatible providers under `providers`. Each one reads its API key
from the environment variable `apiKeyEnv` names; `via serve` won't start while
that variable is unset.

```yaml
providers:
  openrouter:
    apiKeyEnv: OPENROUTER_API_KEY
  opencode-go:
    apiKeyEnv: OPENCODE_API_KEY
  # Any other OpenAI-compatible endpoint needs its baseUrl.
  local:
    baseUrl: http://localhost:11434/v1
    apiKeyEnv: LOCAL_KEY
    # Optional: the header the provider reads a session id from.
    sessionHeader: x-session-id
```

Prefix a model with the provider's name to use it, as in
`openrouter/qwen/qwen3-coder` or `opencode-go/kimi-k3`. via passes
`/v1/chat/completions` and `/v1/responses` requests on as they are, with only
the prefix taken off the model, and passes the provider's answer back the same
way, errors included. Models OpenCode Go serves only through Anthropic's
`/messages` API don't work through via. `/v1/models` lists every provider's
models with their prefix and the details the provider gives, such as
`context_length`; a provider that can't be reached is left out.

To keep a conversation on a warm prompt cache, via gives each request a session
id: the one the client sent, in `x-opencode-session`,
`x-claude-code-session-id`, `session-id`, `session_id`, `x-session-id`, the
body's `session_id` or `prompt_cache_key`, `x-task-id` or `x-kilocode-taskid`;
otherwise one derived from the conversation's first system and user message.
OpenCode Go gets it in `x-opencode-session`, OpenRouter in the body's
`session_id`, and Codex in its `session_id` header.

### Logs

`via serve` logs each request once its answer has been sent. `http.span` is
the whole time via took, and the model, the provider or Codex account that
answered and, for a streamed answer, when its headers and first chunk went out
come with it:

```
[18:26:23.520] INFO (#30) http.span=1875ms: Sent HTTP response {
  "http.method": "POST",
  "http.url": "/v1/chat/completions",
  "http.status": 200,
  model: "opencode-go/deepseek-v4.1-flash",
  served_by: "opencode-go",
  headers_ms: 1478,
  first_chunk_ms: 1478,
}
```

It also warns when an account cools down, is locked out, or has its token
rejected, and says until when.

### Tracing

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to an OpenTelemetry collector's OTLP/HTTP
address, such as `http://localhost:4318`, and `via serve` exports a trace of
each request it serves. The other standard variables work too:
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
`OTEL_BSP_SCHEDULE_DELAY`, and `OTEL_SDK_DISABLED=true` to turn it off.

## Security

- Account tokens are stored as plaintext JSON, readable only by you (files
  `0600`, directory `0700`). Anyone who can read them can use your ChatGPT
  accounts.
- API keys are stored only as SHA-256 hashes.
- The server speaks plain HTTP. Keep it on `127.0.0.1`, or put your own TLS in
  front of it before listening on another interface.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Disclaimer

via is not affiliated with or endorsed by OpenAI. It talks to the backend the
Codex CLI uses and, by default, presents itself as that CLI. Pooling
subscriptions this way may conflict with OpenAI's terms of use. Use only
accounts you own, at your own risk.

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md).

## License

[MIT](../LICENSE)
