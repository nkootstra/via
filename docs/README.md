# via

Pool several ChatGPT/Codex subscriptions behind one OpenAI-compatible endpoint
on your machine.

via logs in to each of your ChatGPT accounts, hands out its own API keys, and
serves `/v1/responses`, `/v1/chat/completions` and `/v1/models` on
`127.0.0.1:8317`. Each request goes to the first account that still has
capacity; when one hits its rate limit, via moves on to the next.

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
  -d '{"model": "gpt-5.5", "messages": [{"role": "user", "content": "Hello"}]}'
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8317/v1", api_key="via_...")
reply = client.responses.create(model="gpt-5.5-high", input="Hello")
print(reply.output_text)
```

## API

Every route needs `Authorization: Bearer <key>` with a key from `via keys create`.

| Route                       | What it does                                                  |
| --------------------------- | ------------------------------------------------------------- |
| `POST /v1/responses`        | Passed through to the Codex backend.                          |
| `POST /v1/chat/completions` | Translated to and from the Responses API, streaming included. |
| `GET /v1/models`            | Lists the models below.                                       |

Models: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`. Add `-low`,
`-medium`, `-high` or `-xhigh` to a model id to pick the reasoning effort, as in
`gpt-5.5-high`.

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
- A rate-limit or usage-limit answer puts that account on a cooldown until the
  reset time the upstream gives, or 30 minutes if it gives none. A server error
  (5xx) cools it down for 1 minute. Either way, via retries on the next account.
- A 401 makes via refresh the account's token and retry once. If that fails, the
  account is taken out of use. Log in to it again with `via accounts add`, then
  restart `via serve`.
- When no account is left, the client gets `429` with a `Retry-After` header
  (or `503` if waiting won't help).
- Cooldowns live in memory. Restarting `via serve` clears them.

## Configuration

via keeps everything in `~/.config/via`, or in `$VIA_HOME` if it's set.

| File             | Contents                                            |
| ---------------- | --------------------------------------------------- |
| `config.yaml`    | Optional settings; you write it, via only reads it. |
| `keys.json`      | SHA-256 hashes of your API keys.                    |
| `auth/<id>.json` | One account's OAuth tokens.                         |

`config.yaml`, with the defaults:

```yaml
host: 127.0.0.1
port: 8317
codex:
  # Present requests to the upstream as the official Codex CLI.
  cloak: true
```

`via serve --host` and `--port` override the file.

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
