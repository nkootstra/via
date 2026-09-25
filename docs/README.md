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

## Docker

Each release publishes `ghcr.io/nkootstra/via` for linux/amd64 and linux/arm64,
tagged with its version (`0.3.1`, `0.3`) and `latest`; from 1.0.0 on also the
major version (`1`). via keeps its accounts, keys, `config.yaml` and cooldowns
in `/data`, so give that a volume:

```sh
docker run -d --name via --restart unless-stopped \
  -p 127.0.0.1:8317:8317 -v via-data:/data \
  ghcr.io/nkootstra/via:0.3.1

docker exec -it via via accounts add
docker exec via via keys create --name laptop
```

The running server picks up accounts and keys added this way without a
restart. For [providers](#providers), put `config.yaml` in the volume and pass
their keys as environment variables. With Compose:

```yaml
services:
  via:
    image: ghcr.io/nkootstra/via:0.3.1
    restart: unless-stopped
    ports:
      - 127.0.0.1:8317:8317
    volumes:
      - via-data:/data
    environment:
      OPENCODE_API_KEY: ${OPENCODE_API_KEY}

volumes:
  via-data:
```

Inside the container via listens on `0.0.0.0`; the `127.0.0.1:` in the port
mapping keeps it off other interfaces. It speaks plain HTTP, so put a TLS proxy
in front of it before exposing it any further. The image runs as a non-root
user (uid 65532) without a shell.

### In the cloud

Any host that runs a container with a persistent disk will do, such as a VPS
with Compose or a platform with volumes. What via needs from it:

- **Exactly one instance, with a persistent volume on `/data`.** Each token
  refresh replaces an account's refresh token and writes it to `/data`, so a
  second instance, or a disk that is thrown away on restart, logs the accounts
  out. That rules out scaling to more instances, and serverless hosts without
  volumes.
- **TLS in front.** Use the host's own, or a proxy such as Caddy, and send it
  to port 8317. Every `/v1` route needs one of your API keys.
- **A health check** on `GET /healthz`. It answers `200 ok` without a key and
  isn't logged.
- **Provider keys as the host's secrets**, passed as the environment variables
  `config.yaml` names.

The image is private while the repository is. Log the host in to ghcr.io
with a GitHub token that has only the `read:packages` scope:

```sh
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
```

Then add accounts on the host with `docker exec -it via via accounts add`; the
device-code login needs no browser there. Or copy an existing `~/.config/via`
into the volume, owned by uid 65532, with the files kept at `0600`.

## API

Every `/v1` route needs `Authorization: Bearer <key>` with a key from `via keys create`.

| Route                       | What it does                                                  |
| --------------------------- | ------------------------------------------------------------- |
| `POST /v1/responses`        | Passed through to the Codex backend.                          |
| `POST /v1/chat/completions` | Translated to and from the Responses API, streaming included. |
| `GET /v1/models`            | Lists the models Codex offers your accounts, then providers'. |
| `GET /healthz`              | Answers `200 ok`, for health checks. Needs no key.            |

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
- A conversation stays on the account that last answered it, so its prompt
  cache stays warm, as long as that account is still available; a new
  conversation, or one whose account failed over, uses fill-first. This is
  kept in memory only, capped at 10,000 conversations, and forgotten after an
  hour of inactivity.
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
- In the background, via also asks ChatGPT for each account's usage every 15
  minutes, so an already-exhausted account cools down before its next request
  would hit a 429. This never ends a cooldown early, only starts one or
  extends it to a later reset that ChatGPT has confirmed.

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

`via serve` logs one line per request once its answer has been sent, as
`key=value` pairs:

```
timestamp=2026-09-25T16:32:34.464Z level=INFO fiber=#27 message="Sent HTTP response" request_id=592f9436-3ad2-4e0f-a239-d4803bdb9925 http.span=3607ms http.method=POST http.url=/v1/chat/completions http.status=200 model=opencode-go/deepseek-v4.1-flash served_by=opencode-go input_tokens=812 output_tokens=194 headers_ms=2712 first_chunk_ms=3433
timestamp=2026-09-25T16:32:37.464Z level=INFO fiber=#28 message="Sent HTTP response" request_id=2a374005-22ec-40ed-a5e5-1dfa5aa6a807 http.span=5ms http.method=POST http.url=/v1/chat/completions http.status=429 model=gpt-6-astra error=rate_limit_exceeded retry_after=120
```

- `request_id` correlates the line to the request: the client's `x-request-id`
  header, kept when it's a valid UUID (lower-cased), else one via generates.
  via echoes it back as `x-request-id` on every response, and stamps it on any
  warning logged while handling the request (a cooldown, say), even across a
  retry onto another account.
- `http.span` is the whole time via took, a stream included.
- `model` is the model asked for, and `served_by` the provider or Codex account
  that answered.
- `input_tokens` and `output_tokens` are the token counts the upstream
  reported for an answered request, and `cached_tokens` joins them when the
  upstream reports a cache hit. Absent usage stays absent, never a zero.
- For a stream, `headers_ms` and `first_chunk_ms` say when its headers and first
  chunk went out.
- For an error via answers itself, `error` is its code and `retry_after` the
  seconds until an account frees up.

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
