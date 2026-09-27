# Sources

All content transcribed from https://github.com/openai/codex via
`gh api repos/openai/codex/contents/<path>` (base64-decoded). Repo is
Rust (`codex-rs/`); JSON was reconstructed from Rust `serde_json::json!{}`
literals, raw `r#"..."#` string literals, and Rust struct literals as noted
per fixture. Every citation below gives the exact commit SHA that last
touched the cited file, obtained via
`gh api "repos/openai/codex/commits?path=<path>&sha=main&per_page=1"`
on 2026-09-24 (i.e. the most recent commit whose content is reflected here,
not a single repo-wide snapshot SHA). `main` HEAD at research time was
`c8c1ee5da8af5c79ec8433ee88d3d4ebdcfd80fd`.

No secrets were found or scrubbed. Every literal transcribed below was
already written by codex's own test authors — these are left exactly as in
the source. No real token, account id, or email appears anywhere in these
fixtures.

## refresh-errors.json

- `invalid_grant`: body is **VERBATIM** from
  `codex-rs/login/src/oauth/error_tests.rs`, function
  `parses_standard_legacy_and_plain_text_rejections`, first tuple, line 11:
  `{"error":"invalid_grant","error_description":"refresh token expired"}`.
  (commit `8f73cdee456b6c46b791780d40cadf9d556d22a4`)
  `status: 400` is **INFERRED**: `request_chatgpt_token_refresh` in
  `codex-rs/login/src/auth/manager.rs` line 1658 computes
  `is_invalid_grant_bad_request = status == StatusCode::BAD_REQUEST && code
== "invalid_grant"`, the one concrete status the source logic keys on for
  this code.
- `refresh_token_expired` / `refresh_token_reused` /
  `refresh_token_invalidated`: the `code` strings and their meaning are
  **VERBATIM** match-arm literals from
  `codex-rs/login/src/auth/manager.rs`, function
  `classify_refresh_token_failure`, lines 1686-1688 (commit
  `22a3f6d5d89c026c6b4f606ae5604f9e00059b23`). The `client_message` values
  are **VERBATIM** constants `REFRESH_TOKEN_EXPIRED_MESSAGE` /
  `REFRESH_TOKEN_REUSED_MESSAGE` / `REFRESH_TOKEN_INVALIDATED_MESSAGE`, same
  file, lines 206-208.
  The HTTP **body envelope and status are INFERRED**: no codex-rs test
  exercises these three codes over the wire — `classify_refresh_token_failure`
  is only unit-tested by constructing a `RefreshTokenFailedError` directly
  in Rust (`codex-rs/login/src/auth/auth_tests.rs`,
  `refresh_failure_is_scoped_to_the_matching_auth_snapshot`, lines
  1176-1233), never through an HTTP response body. The envelope shape
  (`{"error": "<code>", "error_description": "<text>"}`) reuses the one
  format confirmed to parse correctly by
  `TokenErrorDetail::parse` (`codex-rs/login/src/oauth/error.rs`, lines
  121-165), with these three codes substituted in; `status: 400` is
  inferred by analogy with `invalid_grant` (standard OAuth token-endpoint
  failure status) — note `classify_refresh_token_failure` itself is
  status-agnostic for these three specific codes (any status still yields
  `Expired`/`Exhausted`/`Revoked` once the code matches, per lines
  1660-1666).
