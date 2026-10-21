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
- Getting the admin state from `/admin/events` after the session that opened
  the stream has ended.
- Guessing the admin key faster than the sign-in limits allow, through
  `POST /admin/session` or a bearer key, or another site's page getting the
  admin's own address locked out of signing in.
- Files in `~/.config/via` (or `$VIA_HOME`) created with permissions wider than
  owner-only.
- A prompt, an answer, a secret, or an upstream's error message other than one
  answered with a 401, 402, 403, 429 or 5xx, ending up in the usage history
  (`usage.db`) or the turns in flight `/admin/events` sends, which carry only
  what the README lists.
- A prompt or an upstream's error answer kept in `bodies.db` while keeping
  failed turns' prompts is off (it is off until turned on), kept for a turn that
  neither failed nor fell back, kept past its 7 days or a delete, or a secret of
  a kind the README says redaction replaces kept unredacted there. With the
  setting on, via keeps those turns' request bodies, redacted, for 7 days,
  owner-only, in `~/.config/via/bodies.db` (or `$VIA_HOME/bodies.db`), and
  `DELETE /admin/history/bodies` or deleting the history deletes them.
  Redaction works by pattern: a secret of a kind it has no pattern for, such as
  a plain password, is kept as written, and that is a known limit, not a
  vulnerability.
- A prompt, an answer or an upstream's error message ending up in via's log
  or in `state.json`.
- A client request that makes via send headers or requests to an upstream
  (Codex, OpenCode Go or a configured provider) that it didn't intend.

Out of scope:

- The upstreams' own services, such as OpenAI's, OpenCode's or OpenRouter's.
  Report those to their owners.
- Running `via serve` on a non-local interface without TLS. The README warns
  against it.
- Other processes running as your own OS user reading your files.
- Another service on via's host reading the admin session cookie, which
  browsers send to every port on a host. The README says how to avoid it.
