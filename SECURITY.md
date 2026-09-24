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

- Leaking account tokens or API keys: in logs, error messages, responses to
  clients, or files with loose permissions.
- Reaching the API without a valid via key.
- Files in `~/.config/via` (or `$VIA_HOME`) created with permissions wider than
  owner-only.
- A client request that makes via send headers or requests to the upstream
  that it didn't intend.

Out of scope:

- OpenAI's own services. Report those to OpenAI.
- Running `via serve` on a non-local interface without TLS. The README warns
  against it.
- Other processes running as your own OS user reading your files.
