<p align="center">
  <img src="https://raw.githubusercontent.com/nkootstra/via/main/docs/assets/logo.svg" alt="" width="96" height="96">
</p>

# via

One OpenAI-compatible endpoint on your machine for your ChatGPT/Codex
subscriptions, OpenCode Go keys and other providers such as OpenRouter.

via hands out its own API keys and serves `/v1/responses`,
`/v1/chat/completions` and `/v1/models` on `127.0.0.1:8317`. Behind that it
talks to:

| Upstream                                         | How you add it                                          | Models                     | When one runs out                                    |
| ------------------------------------------------ | ------------------------------------------------------- | -------------------------- | ---------------------------------------------------- |
| ChatGPT subscriptions, through the Codex backend | Device-code login: `via accounts add` or the web UI     | Any model without a prefix | Pooled: via moves on to the next account             |
| OpenCode Go API keys                             | `via accounts add --provider opencode-go` or the web UI | `opencode-go/<model>`      | Pooled: via moves on to the next key                 |
| Other OpenAI-compatible providers                | An entry in [`config.yaml`](#providers)                 | `<provider>/<model>`       | One key each; its errors are passed back as they are |

Each request goes to the first account that still has capacity; when one hits
its rate limit, via moves on to the next (see
[How the pool picks an account](#how-the-pool-picks-an-account)).

> **Status:** early (`0.x`). Commands and file formats may still change before 1.0.

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
tagged with its version (`X.Y.Z` and `X.Y`) and `latest`; from 1.0.0 on also
the major version (`X`). The examples use `latest`; to upgrade only when you
choose to, pin a version from the
[releases](https://github.com/nkootstra/via/releases) instead.

via keeps its accounts, keys, `config.yaml` and cooldowns in `/data`, so give
that a volume:

```sh
docker run -d --name via --restart unless-stopped \
  -p 127.0.0.1:8317:8317 -v via-data:/data \
  ghcr.io/nkootstra/via:latest

docker exec -it via via accounts add
docker exec via via keys create --name laptop
```

The running server picks up accounts and keys added this way without a
restart, and so does an OpenCode Go key added with
`docker exec -i via via accounts add --provider opencode-go < key.txt`. For
other [providers](#providers), put `config.yaml` in the volume and pass their
keys as environment variables. With Compose:

```yaml
services:
  via:
    image: ghcr.io/nkootstra/via:latest
    restart: unless-stopped
    ports:
      - 127.0.0.1:8317:8317
    volumes:
      - via-data:/data
    environment:
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}

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
  `config.yaml` names. So is `VIA_ADMIN_KEY`, if you want the
  [admin API](#admin-api) and [web UI](#web-ui) instead of `docker exec`.

The image is public, so the host needs no registry login. Add accounts on the
host with `docker exec -it via via accounts add`; the
device-code login needs no browser there. Or copy an existing `~/.config/via`
into the volume, owned by uid 65532, with the files kept at `0600`.

## API

Every `/v1` route needs `Authorization: Bearer <key>` with a key from `via keys create`.

| Route                       | What it does                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `POST /v1/responses`        | Passed through to Codex, or to the provider the model names.                                             |
| `POST /v1/chat/completions` | For Codex, translated to and from the Responses API, streaming included; for a provider, passed through. |
| `GET /v1/models`            | Lists the models Codex offers your accounts, then providers'.                                            |
| `GET /healthz`              | Answers `200 ok`, for health checks. Needs no key.                                                       |

A model named `<provider>/<model>`, such as `opencode-go/kimi-k3` or
`openrouter/qwen/qwen3-coder`, goes to that [provider](#providers); any other
model goes to Codex.

The Codex backend refuses sampling and limit options, so via accepts and ignores
them: `temperature`, `top_p`, `max_tokens`, `max_completion_tokens` and
`max_output_tokens`, as well as `user`, `metadata`, `previous_response_id` and
`context_management`.
A refusal comes back as the chat message's `refusal`, as OpenAI sends it.

A streamed answer that goes quiet, as while the model reasons, gets a
`: keepalive` SSE comment every five seconds, so neither via's server nor a proxy
in between closes the connection as idle. SSE clients skip comments.

via bounds what one request can take:

- A request body over 64 MiB is refused with `413`, on every route. OpenAI
  takes up to 50 MB per request, images included, so anything an upstream
  would accept fits.
- Codex has 2 minutes to start answering a response, and a provider 10, as a
  provider that doesn't stream answers only once the model is done. After
  that, a stream runs as long as the model takes. An upstream that doesn't
  start in time answers `502`, like one that can't be reached.
- A non-streaming Codex response that hasn't completed after 30 minutes
  answers `504 upstream_timeout`, and one whose stream runs past 128 MiB
  answers `502 upstream_too_large`.
- Usage, model lists, key checks and sign-in requests to OpenAI give up after
  30 seconds.
- A client that hangs up on a stream ends via's request upstream too.

`/v1/models` lists what the Codex model picker shows your accounts, combined,
since plans offer different models. So new models appear without a via update.
Only accounts that can serve count: enabled ones, including one cooling down,
as it serves again once its cooldown ends, but not one locked out until it
signs in again. With no such account, no Codex models are listed. via fetches
the list as it starts and answers from it at once; once it is five minutes old,
via fetches a new one in the background for the next request. Disabling,
enabling, adding or removing an account, or one being locked out, changes the
list at once. When Codex can't be asked, it lists the models via knows:
`gpt-6-astra`, `gpt-6-sol` and `gpt-6-luna`.

Add an effort suffix to a model id to pick the reasoning effort, as in
`gpt-6-astra-high`. The list shows each model with the suffixes it supports,
from `-none`, `-low`, `-medium`, `-high`, `-xhigh`, `-max` and `-ultra`. Other
model ids are passed through to Codex unchanged.

### Admin API

With `VIA_ADMIN_KEY` set, `via serve` also serves `/admin`, which does what the
`via accounts` and `via keys` commands do, over HTTP. Without it, `/admin`
doesn't exist and answers 404. The key must be at least 32 characters, or
`via serve` refuses to start; `openssl rand -hex 32` makes one.

Every `/admin` route needs `Authorization: Bearer <VIA_ADMIN_KEY>` or a
session cookie from [signing in](#signing-in-from-a-browser), except signing in
itself and the API's description: its OpenAPI spec at `/admin/openapi.json` and
a reference page at `/admin/docs`, where you can also try the routes out. API
keys from `via keys create` don't work on `/admin`, and the admin key doesn't
work on `/v1`.

| Route                                     | What it does                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `POST /admin/session`                     | Sign in with `{"key": "<VIA_ADMIN_KEY>"}`; sets a cookie.                                         |
| `GET /admin/session`                      | 200 while signed in, else 401.                                                                    |
| `DELETE /admin/session`                   | Sign out.                                                                                         |
| `GET /admin/accounts`                     | List accounts in the order they are used, without tokens.                                         |
| `PATCH /admin/accounts/<id>`              | Change `label` and/or `enabled`; returns the account.                                             |
| `DELETE /admin/accounts/<id>`             | Forget an account and delete its tokens.                                                          |
| `POST /admin/accounts/logins`             | Start a device-code login.                                                                        |
| `GET /admin/accounts/logins/<id>`         | Check on a login: `pending`, `added`, `updated` or `failed`.                                      |
| `GET /admin/opencode-go/accounts`         | List OpenCode Go keys, each only by its last four characters.                                     |
| `POST /admin/opencode-go/accounts`        | Add a key from `{"apiKey": "...", "label": "..."}` (label optional), once OpenCode Go accepts it. |
| `PATCH /admin/opencode-go/accounts/<id>`  | Change `label` and/or `enabled`; returns the key's account.                                       |
| `DELETE /admin/opencode-go/accounts/<id>` | Forget an OpenCode Go key.                                                                        |
| `GET /admin/usage`                        | How much of each account's limits is used.                                                        |
| `GET /admin/history/series`               | Tokens per hour or day, by group (see [Usage history](#usage-history)).                           |
| `GET /admin/history/breakdown`            | Requests, tokens, failures, latency and cost over a range, by group.                              |
| `GET /admin/history/requests`             | The requests in a range, newest first, a page at a time.                                          |
| `DELETE /admin/history`                   | Delete the whole usage history; answers `{"deleted": <count>}`.                                   |
| `GET /admin/pool`                         | Each account's and provider's state (see below).                                                  |
| `GET /admin/models`                       | The models `/v1/models` lists.                                                                    |
| `GET /admin/events`                       | The admin state as server-sent events, as it changes.                                             |
| `GET /admin/keys`                         | List API keys and when each was last used, not the keys.                                          |
| `POST /admin/keys`                        | Create a key from `{"name": "..."}`. It is returned once.                                         |
| `PATCH /admin/keys/<id-or-name>`          | Rename a key from `{"name": "..."}`; the key stays the same.                                      |
| `DELETE /admin/keys/<id-or-name>`         | Revoke a key.                                                                                     |

Accounts are named by their `id` from `GET /admin/accounts`. Unlike the
commands, the admin API doesn't take a label or email, which would otherwise
end up in URLs and access logs. An account, login or key that doesn't exist
answers 404; a key name that is taken
answers 409. A name or label over 200 characters, or a key over 1,024,
answers 400.

A key's `lastUsedAt` is `null` until a client first uses it. `via serve` knows
it to the second, but writes it to `keys.json` at most once a minute per key
rather than on every request, so after a restart, or in `via keys list` next
to a running `via serve`, it can be up to a minute behind.

Before it keeps an OpenCode Go key, via asks OpenCode Go for the key's usage:
a key OpenCode Go refuses answers 422, one via can't check because OpenCode Go
is down answers 502, and one via already has answers 409. The key is never
answered back: `key` is its last four characters, as `…abcd`, and the account
imported from the deprecated `apiKeyEnv` variable has `environmentVariable`
set to that variable's name while it is still set.

To add an account, start a login, open `verificationUrl` and enter `userCode`,
then poll the login until it's no longer `pending`:

```sh
curl -X POST -H "Authorization: Bearer $VIA_ADMIN_KEY" http://127.0.0.1:8317/admin/accounts/logins
# {"id":"<id>","userCode":"ABCD-1234","verificationUrl":"https://auth.openai.com/codex/device"}

curl -H "Authorization: Bearer $VIA_ADMIN_KEY" http://127.0.0.1:8317/admin/accounts/logins/<id>
# {"status":"added","account":{"id":"...","label":"you@example.com",...}}
```

A login fails if it isn't approved within 15 minutes. At most 10 logins can
wait for approval at once; starting another answers 429 until one ends. Logins
are kept in memory, so restarting via cancels them, and one that has ended is
forgotten 5 minutes later, when polling it answers 404.

`GET /admin/pool` answers `{"accounts": [...], "opencodeGo": [...], "providers": [...]}`.
It lists every ChatGPT account, and in `opencodeGo` every OpenCode Go account,
with its `id`, `label`, `enabled` and a `state`:
`{"status":"available"}`, `{"status":"cooling","until":"<ISO time>","reason":"..."}`
while Codex has it rate-limited, or `{"status":"auth_error","reason":"..."}` once
Codex rejects its tokens even after a refresh, until you log in to it again (for
an OpenCode Go account, once OpenCode Go refuses its key, until via restarts). A
disabled account keeps its state but isn't used.

Next to the accounts it lists every configured provider with its own key, such
as OpenRouter, with its `name` and `{"status":"available"}`: requests for
`<provider>/<model>` go straight to it.

`GET /admin/usage` answers `{"accounts": [...], "opencodeGo": [...], "refreshing": ...}`
at once from the usage via last fetched, never waiting on ChatGPT or OpenCode
Go. An OpenCode Go account's windows are named as OpenCode Go names them, such
as `rolling`, `weekly` and `monthly`. via fetches every account's usage in the
background: when it starts, every 15 minutes after that, and whenever an answer
would be a minute old or more, or would miss an account. So what you see is at
most about a minute old, and via asks for each account's usage at most once a
minute however often the page refreshes. Each entry in `GET /admin/usage` says when it was fetched
(`fetchedAt`), an account via has no usage for yet is left out, and
`refreshing` is `true` while a fetch runs.

`GET /admin/events` is a stream of
[server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
that pushes the admin state instead of making you poll. Each event is named
`state` and carries all of it as JSON: `pool` and `usage` as the routes above
answer them, `accounts`, `opencodeGo` (keys masked) and `keys` as their lists
do, `models`, `version` (the running via's) and `session: true`. The first
comes as soon as you connect; after that, one comes whenever something in it
changes: an account, OpenCode Go key or API key is added, changed or removed,
an API key is used for the first time in a minute, a cooldown or lockout starts
or is lifted, a cooldown runs out, or a usage fetch starts or ends. Changes
that come together (within about 200 ms) arrive as one event, and a state the
same as the last one isn't sent again. A `: keepalive` comment keeps a quiet
stream open. Changes another process makes, such as `via accounts label`,
show within 15 seconds, and while a stream is open via keeps usage from
getting more than about a minute old, as it does for a page that polls.

#### Signing in from a browser

A browser signs in once with the admin key, and from then on sends a session
cookie instead, so the key is never kept in the page:

- `POST /admin/session` with `{"key": "<VIA_ADMIN_KEY>"}` answers 204 and sets
  `via_session`, an `HttpOnly`, `SameSite=Strict` cookie for the whole
  site (`Path=/`), so loading the web UI at `/ui` sends it too. The cookie
  is `Secure` when the browser signed in over HTTPS, which via tells from the
  request's `Origin` header, so a proxy that ends TLS in front of via needs
  no setting for it.
- A session ends 12 hours after sign-in, after an hour unused, on
  `DELETE /admin/session`, or when via restarts; sessions are kept in memory.
- A request that changes something (anything but `GET`) with only the cookie
  must send `x-via-csrf: 1` and an `Origin` whose host is the `Host` it was
  sent to; otherwise it answers 403. A proxy in front of via must pass the
  `Host` header through unchanged. Requests with the bearer key need neither.
- A wrong key answers 401 after a one-second delay. After 10 wrong keys
  within a minute from one address, sign-ins from that address answer 429,
  after the same delay, until the minute has passed; other addresses can still
  sign in. After 1000 wrong keys within a minute from all addresses together,
  every sign-in answers 429, which keeps many addresses guessing at once from
  getting far. The address is the connection's: via ignores `X-Forwarded-For`
  and similar headers, so behind a proxy every sign-in shares the proxy's
  address. Each failed sign-in is logged, without the key. via never logs the
  key or the cookie.

### Web UI

With `VIA_ADMIN_KEY` set, `via serve` also serves a web UI for the admin API
at `/ui/`, such as `http://127.0.0.1:8317/ui/`. Without the key it answers 404,
as `/admin` does. It's built into the binary and the Docker image, so there is
nothing else to run or download, and it loads nothing from other sites.

Open it and sign in with the admin key. The page [signs in](#signing-in-from-a-browser)
as above: it keeps only the session cookie, never the key, and a reload or a
link to any page keeps you signed in until the session ends. From there you can
see the pool at a glance, add ChatGPT accounts by device-code login or OpenCode
Go keys by pasting them, rename, disable and remove them, create, rename and revoke API
keys, and list the models. The Accounts page lists the ChatGPT accounts under
Codex and the OpenCode Go keys under their own heading, each key only by its
last four characters. The Models page shows each model once: a Codex model
with the reasoning efforts its suffixed ids pick, and a provider's models under
its heading without their `<provider>/` prefix. Search matches every id.

**Settings**, in the menu under **Admin** at the foot of the sidebar, holds the
page's preferences: the theme (System, Light or Dark) and the time format
(Automatic, 12-hour or 24-hour). It also deletes the whole
[usage history](#usage-history), after asking; that one isn't a preference of
the browser, so it's gone for every viewer. Automatic writes times as the browser's
language does. Each choice applies at once, to every open tab, and is kept in
that browser's local storage, not in via, so another browser starts from the
defaults.

The **Usage** page shows the [usage history](#usage-history): requests,
tokens, cache hit rate, API-equivalent cost and time to first token (of
streamed answers that didn't fail) over the
last day, week, 30 or 90 days; tokens per hour or day, stacked by model,
account or key; a table of each; and the requests themselves, newest first.
Pick a model, account or key in its table to list only its requests. The page
asks again every 15 seconds while it's open.

The overview shows each account's usage as via last fetched
it in the background (see [the admin API](#admin-api)), at most about a minute
old, and says how long ago that was.

The page shows the pool as it is right now, without reloading or polling. When
a signed-in browser opens or reloads it, via puts the current state in the
page itself, so it paints straight away without asking `/admin` for anything.
The page then listens to [`GET /admin/events`](#admin-api), and a cooldown,
a lockout, new usage or a change made in another tab shows up the moment via
knows it. If that stream drops, the page asks every few seconds instead until
the browser reconnects. The state in the page is the viewer's, so via tells
browsers and proxies not to cache it.

When via restarts on a new version while the page is open, the page
reconnects, notices that it was built for the old one, and says "via was
updated. Reload to get the new version." until you reload it.

The page is the admin key's reach in a browser, so give it the same care:

- Keep via on `127.0.0.1`, as it is by default, or put it behind TLS before
  you open it anywhere else. Over plain HTTP the key and the cookie cross the
  network readable.
- The page runs only via's own code: its Content Security Policy allows
  scripts, styles and requests from via alone, and it can't be framed by
  another site.

## Commands

| Command                                   | What it does                                                    |
| ----------------------------------------- | --------------------------------------------------------------- |
| `via accounts add`                        | Log in to a ChatGPT account with a device code.                 |
| `via accounts add --provider opencode-go` | Add an OpenCode Go API key as an account.                       |
| `via accounts list`                       | List accounts in the order they are used.                       |
| `via accounts status`                     | Show each account's and provider's limits and how much is used. |
| `via accounts label <account> <label>`    | Rename an account.                                              |
| `via accounts disable <account>`          | Stop using an account without removing it.                      |
| `via accounts enable <account>`           | Use it again.                                                   |
| `via accounts remove <account>`           | Forget an account and delete its tokens.                        |
| `via keys create --name <name>`           | Create an API key. It is printed once.                          |
| `via keys list`                           | List keys, when each was created and when it was last used.     |
| `via keys rename <id-or-name> <new-name>` | Rename a key; clients keep using it.                            |
| `via keys revoke <id-or-name>`            | Revoke a key.                                                   |
| `via serve [--host <addr>] [--port <n>]`  | Serve the API in the foreground.                                |

`<account>` matches an account's id, label or email.

Adding a ChatGPT account that is already in the pool signs it in again: via
replaces its tokens and keeps its label and whether it's enabled, rather than
adding it twice. Adding an OpenCode Go key via already has is refused.

`via accounts add --provider opencode-go` asks for the key without echoing it,
or reads it from standard input when that isn't a terminal, so a script can
pipe it in: `via accounts add --provider opencode-go < key.txt`. It never takes
the key as an argument, which would end up in your shell history. Unlike the
admin API and the web UI, it doesn't ask OpenCode Go whether the key works
first; a key it refuses is taken out of use at its first request. `list` and
`status` show only a key's last four characters.

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
  account is locked out: taken out of use until it signs in again. Sign it in
  from the web UI's **Add account** and it's back in rotation at once. With
  `via accounts add` instead, restart `via serve`: the CLI can't reach the
  running server's lockouts. A login lifts only a lockout, never a cooldown.
- A Codex backend via can't reach at all answers `502` without trying the next
  account. A token refresh that fails because the sign-in server can't be
  reached rests that account for 1 minute, and via tries the next one; only a
  refused refresh locks an account out.
- When no account is left, the client gets `429` with a `Retry-After` header
  (or `503` if waiting won't help). For a model only some accounts offer, only
  those accounts count.
- Running cooldowns are saved in `state.json`, so a restarted `via serve` keeps
  them. Lockouts aren't saved: a restart gives a locked-out account one more try.
- In the background, via also asks ChatGPT for each account's usage when it
  starts and every 15 minutes after that, a few accounts at a time, so an
  already-exhausted account cools down before its next request would hit a 429. The web UI shows the same usage. This never ends a cooldown early, only starts one or
  extends it to a later reset that ChatGPT has confirmed.

OpenCode Go accounts, for `opencode-go/` models, make a pool of their own that
works the same way: fill-first in the order you added the keys, a conversation
kept on the key that last answered it, and a `429` (or every key resting)
handled as above. A key's cooldown lasts until its used-up usage window resets,
or as long as the answer's `Retry-After` asks, whichever is later. A key
OpenCode Go refuses (401) is taken out of use until `via serve` restarts. via
asks OpenCode Go for each key's usage every 15 minutes too.

## Configuration

via keeps everything in `~/.config/via`, or in `$VIA_HOME` if it's set.

| File               | Contents                                            |
| ------------------ | --------------------------------------------------- |
| `config.yaml`      | Optional settings; you write it, via only reads it. |
| `keys.json`        | Your API keys' SHA-256 hashes and last use.         |
| `auth/<id>.json`   | One account's OAuth tokens.                         |
| `state.json`       | Running cooldowns; safe to delete.                  |
| `opencode-go.json` | Your OpenCode Go API keys, as accounts.             |
| `usage.db`         | The [usage history](#usage-history), in SQLite.     |

`config.yaml`, with the defaults:

```yaml
host: 127.0.0.1
port: 8317
codex:
  # Present requests to the upstream as the official Codex CLI.
  cloak: true
```

`via serve --host` and `--port` override the file.

### Model prices

The [usage history](#usage-history) prices tokens with a snapshot of two
price tables that ships with via: [models.dev](https://models.dev) for what
OpenCode Go charges for each of its models, and
[LiteLLM's](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
for the rest. For a model neither lists, or at another price, add it under
`prices`, in USD per million tokens. `cachedInput` is optional: cached input
costs what input does unless it's set. A price that grows past a long context
is taken at its base rate.

```yaml
prices:
  opencode-go/kimi-k3:
    input: 0.6
    cachedInput: 0.1
    output: 2.5
```

A model is looked up as it's asked for, then without its `<provider>/` prefix,
then without a reasoning-effort suffix such as `-high`, ignoring case; a price
in `config.yaml` wins over the snapshot at each step.

### Providers

Add OpenAI-compatible providers under `providers`. Each one reads its API key
from the environment variable `apiKeyEnv` names; `via serve` won't start while
that variable is unset.

OpenCode Go is the exception: it needs no entry at all. Add its keys as
accounts with `via accounts add --provider opencode-go`, and via pools them
like ChatGPT accounts (see [How the pool picks an account](#how-the-pool-picks-an-account)).

> **Deprecated:** reading OpenCode Go's key from `apiKeyEnv` (such as
> `OPENCODE_API_KEY`). While that variable is set, `via serve` and
> `via accounts status` add its key as an account named
> `OpenCode Go (imported)`, once, and `via serve` logs a warning at startup.
> Remove the variable (and the `opencode-go` entry, unless you set its
> `baseUrl` or `sessionHeader`); a later release stops reading it.

```yaml
providers:
  openrouter:
    apiKeyEnv: OPENROUTER_API_KEY
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
`context_length`; a provider that can't be reached is left out, as is OpenCode
Go while none of its accounts is enabled.

To keep a conversation on a warm prompt cache, via gives each request a session
id: the one the client sent, in `x-parent-session-id` (so OpenCode's sub-agents
share their parent's), `x-opencode-session`,
`x-claude-code-session-id`, `session-id`, `session_id`, `x-session-id`, the
body's `session_id` or `prompt_cache_key`, `x-task-id` or `x-kilocode-taskid`;
otherwise one derived from the conversation's first system and user message.
OpenCode Go gets it in `x-opencode-session`, OpenRouter in the body's
`session_id` and, unless the client set one, `prompt_cache_key`, and Codex in
its `session_id` header.

OpenCode also writes its session id into the `<env>` block of its system
prompt, which would keep its sub-agents from sharing a prompt cache with each
other and their parent. via moves that one line, for Chat Completions, to the
start of the first user message; the model still sees it.

### Logs

`via serve` logs one line per request once its answer has been sent, as
`key=value` pairs:

```
timestamp=2026-09-25T16:32:34.464Z level=INFO fiber=#27 message="Sent HTTP response" request_id=592f9436-3ad2-4e0f-a239-d4803bdb9925 http.span=3607ms http.method=POST http.url=/v1/chat/completions http.status=200 key=laptop model=opencode-go/deepseek-v4.1-flash served_by=go-work input_tokens=812 output_tokens=194 headers_ms=2712 first_chunk_ms=3433 stream_end=completed
timestamp=2026-09-25T16:32:37.464Z level=INFO fiber=#28 message="Sent HTTP response" request_id=2a374005-22ec-40ed-a5e5-1dfa5aa6a807 http.span=5ms http.method=POST http.url=/v1/chat/completions http.status=429 key=laptop model=gpt-6-astra error=rate_limit_exceeded retry_after=120
```

- `request_id` correlates the line to the request: the client's `x-request-id`
  header, kept when it's a valid UUID (lower-cased), else one via generates.
  via echoes it back as `x-request-id` on every response, and stamps it on any
  warning logged while handling the request (a cooldown, say), even across a
  retry onto another account.
- `http.span` is the whole time via took, a stream included.
- `key` is the name of the API key the client used, `model` the model asked
  for, and `served_by` the provider, or the Codex or OpenCode Go account, that
  answered.
- `input_tokens` and `output_tokens` are the token counts the upstream
  reported for an answered request, and `cached_tokens` joins them when the
  upstream reports a cache hit. `reasoning_tokens` is the part of the output
  the model spent reasoning, and `cost_usd` what the upstream says it billed,
  when it reports either (OpenRouter reports its cost). Absent usage stays
  absent, never a zero.
- For an answer the client asked to stream, `headers_ms` and `first_chunk_ms`
  say when its headers and first chunk went out, and `stream_end` how it ended: `completed`, `client_aborted`
  (the client went away first) or `failed` (it broke off, such as when the
  upstream dropped the connection).
- For an error via answers itself, `error` is its code and `retry_after` the
  seconds until an account frees up. For an error the upstream answered,
  `upstream_error` is the code it gave, such as `ModelProtocolUnsupported`.
- A request the client gave up on before via answered is logged with
  `http.status=499`, as nginx does. The client never sees that status.
- Opening a page of the [web UI](#web-ui) logs one line for the page; the
  scripts, stylesheet and icon it loads aren't logged.

It also warns when an account cools down, is locked out, or has its token
rejected, and says until when.

### Usage history

`via serve` keeps every request that asks for a model in `usage.db`, a SQLite
database: when it came in, the API key's id and name, the model, the provider
and account that served it, its status, why it failed if it did (the error
code and message, via's own or the upstream's, the message cut to 500
characters), its input, cached,
output and reasoning tokens as the upstream reported them, any cost the
upstream billed (OpenRouter reports one), and how long it took to answer and,
for a streamed answer, to send its first chunk. It never keeps a prompt or an answer. Requests older
than 90 days are deleted at startup and once a day after that.

The [web UI](#web-ui)'s Usage page and the `/admin/history` routes of the
[admin API](#admin-api) read it. Each takes a range, `from` and `to` in epoch
milliseconds; `series` and `breakdown` also take `groupBy` (`model`,
`account`, `key` or `provider`), and `series` takes a `bucket` (`hour` or
`day`) and `tzOffsetMinutes`, so days start at your midnight. A request no
account served, such as one to a plain provider, counts under
`provider:<name>` when grouped by account.

Cost is worked out when you ask, from the tokens and the [model prices](#model-prices),
so a price change applies to old requests too:

- A request whose upstream reported a cost counts at that cost, as billed.
- Every other request counts at API prices, as the **API-equivalent cost**:
  what its tokens would have cost pay-as-you-go. For a ChatGPT or OpenCode Go
  subscription that's what the plan saved, not money spent.
- A model with no known price is named rather than counted as free.

Token totals leave out answered requests whose upstream reported no usage, and
the page says how many. A failed request has no tokens to report, so it isn't
counted there; the Requests list says why it failed.

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
- OpenCode Go API keys are stored the same way, in plaintext in
  `opencode-go.json`, readable only by you.
- The usage history, `usage.db`, holds API key names, account labels and
  models, never prompts or answers, and is readable only by you. It does keep
  an upstream's error message, cut to 500 characters, which could quote part
  of a request the upstream refused.
- API keys are stored only as SHA-256 hashes.
- `VIA_ADMIN_KEY` can add, change and remove accounts and API keys. Keep it
  out of clients; only its SHA-256 hash is compared, in constant time.
- Admin sessions are kept in memory, each only as the SHA-256 hash of its
  cookie, and all end when via restarts.
- The server speaks plain HTTP. Keep it on `127.0.0.1`, or put your own TLS in
  front of it before listening on another interface. That goes double for the
  [web UI](#web-ui), where the admin key is typed in.
- The web UI runs only first-party code, under a Content Security Policy that
  refuses scripts, styles and requests from anywhere but via.

To report a vulnerability, see [SECURITY.md](https://github.com/nkootstra/via/blob/main/SECURITY.md).

## Disclaimer

via is not affiliated with or endorsed by OpenAI. It talks to the backend the
Codex CLI uses and, by default, presents itself as that CLI. Pooling
subscriptions this way may conflict with OpenAI's terms of use. Use only
accounts you own, at your own risk.

## Contributing

See [CONTRIBUTING.md](https://github.com/nkootstra/via/blob/main/CONTRIBUTING.md).

## License

[MIT](https://github.com/nkootstra/via/blob/main/LICENSE)
