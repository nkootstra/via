# Security policy

## Supported versions

via is pre-1.0. Only the latest release, and `main`, get security fixes.

## Reporting a vulnerability

Please **don't** open a public issue for a security problem.

Report it privately through
[GitHub private vulnerability reporting](https://github.com/nkootstra/via/security/advisories/new).
That opens a private thread with the maintainer.

Expect an acknowledgement within a few days. Once the problem is confirmed, we
agree on a fix and a release, and publish an advisory where it's warranted.

## What counts

Examples of what's in scope:

- Leaking ChatGPT account tokens, OpenCode Go or provider API keys, via's own
  API keys, the admin key or an admin session: in logs, error messages,
  responses to clients, or files with loose permissions.
- Reaching `/v1` without a valid via key, or `/admin` and the web UI without
  the admin key or a session.
- Files in `~/.config/via` (or `$VIA_HOME`) created with permissions wider than
  owner-only.
- A prompt, an answer or a secret ending up in the usage history
  (`usage.db`), which keeps only what the README lists.
- A client request that makes via send headers or requests to an upstream
  (Codex, OpenCode Go or a configured provider) that it didn't intend.

Out of scope:

- The upstreams' own services, such as OpenAI's, OpenCode's or OpenRouter's.
  Report those to their owners.
- Running `via serve` on a non-local interface without TLS. The README warns
  against it.
- Other processes running as your own OS user reading your files.
