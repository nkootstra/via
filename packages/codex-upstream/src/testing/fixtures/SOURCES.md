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
already written by codex's own test authors using obviously-synthetic
values (`org-AAA`, `req-401`, `ray-401`, `resp_689bcf18...` / `resp_5c66275b...`
which are OpenAI _response-id-shaped_ test fixtures, not credentials, `9.99`
balances, etc.) — these are left exactly as in the source. No real token,
account id, or email appears anywhere in these fixtures.

## SSE fixtures

### text-reply.sse

Base skeleton (`response.created` → `response.output_item.added` (empty
text) → `response.output_text.delta` → `response.output_item.done` (full
text) → `response.completed`) is **VERBATIM**: the exact literal
`sse(vec![...])` in
`codex-rs/core/tests/suite/items.rs`, function
`agent_message_content_delta_has_item_metadata`, lines 408-414.
(commit `7b8b17b97a5f08f088852e8bc9ae388cff38c714`)

`response.in_progress`, `response.content_part.added`,
`response.output_text.done`, `response.content_part.done` are **INFERRED**.
Their event-kind strings are verbatim — they appear in the match-arm list of
`process_responses_event` in `codex-rs/codex-api/src/sse/responses.rs`,
lines 539-548 (commit `9d8de196748b57d7f463a7757eaa447b6483a331`), which
recognizes these kinds but only traces them (see "Surprises" below) — no
codex-rs test ever constructs a literal JSON body for them, so their bodies
here are a plausible reconstruction of the real OpenAI Responses API wire
shape (`item_id`/`output_index`/`content_index`/`part` fields), not
transcribed from any codex source.

### function-call.sse

**VERBATIM subset** (3 of 4 events) of the literal `first_response =
sse(vec![...])` in `codex-rs/core/tests/suite/request_user_input.rs`, lines
117-122, combined with the helper bodies `ev_response_created`,
`ev_function_call`, `ev_completed` from
`codex-rs/core/tests/common/responses.rs` lines 760-778 and 956-966.
(commits `cbb7e82a8bdd2b59b6f25619e1db4b4c74de1b04` and
`4b3b569f3975ba4e3bf64589e4d15039066077f8`)
The `codex.rate_limits` event present in the same original 4-event sequence
is intentionally dropped here and kept intact in `rate-limits.sse` instead,
so each fixture demonstrates one thing.

### rate-limits.sse

**Fully VERBATIM, unmodified.** The complete 4-event literal from
`codex-rs/core/tests/suite/request_user_input.rs`: `first_response =
sse(vec![ev_response_created("resp-1"), ev_function_call(call_id,
"request_user_input", &request_args), ev_rate_limits(), ev_completed("resp-1")])`,
lines 117-122, plus the `ev_rate_limits()` helper body itself, lines
218-236. (commit `cbb7e82a8bdd2b59b6f25619e1db4b4c74de1b04`)
This is the only place in the repo where a `codex.rate_limits` SSE event
appears as a literal JSON test fixture (as opposed to only being described
by the `RateLimitEvent` deserialization struct in `rate_limits.rs`).

### reasoning-plus-text.sse

**VERBATIM.** The literal `initial_sse = sse(vec![ev_response_created(...),
ev_reasoning_item(...), ev_assistant_message(...), ev_completed(...)])` in
`codex-rs/core/tests/suite/resume.rs`, function
`resume_includes_initial_messages_from_reasoning_events`, lines 218-228.
(commit `12cb14f7b70f57aaf643d10ca072c44b555992d1`)
`encrypted_content` is computed by executing `ev_reasoning_item`'s own
verbatim algorithm (`codex-rs/core/tests/common/responses.rs` lines
851-881: base64-standard-encode of 550 `'b'` characters followed by the
joined `raw_content` strings) — this is a deterministic recomputation of a
documented algorithm, not a fabricated value.

### response-failed-rate-limit.sse

**VERBATIM** raw string literal (`let raw_error = r#"..."#;`) from
`codex-rs/codex-api/src/sse/responses.rs`, function
`rate_limit_error_preserves_retry_delay`, line 1128.
(commit `9d8de196748b57d7f463a7757eaa447b6483a331`)
Preserves a source quirk exactly: a stray space after the `error` object's
closing brace (`}, "usage":null`) — not normalized.

### response-failed-context-length.sse

**VERBATIM** raw string literal from the same file, function
`context_window_error_is_fatal`, line 1198.
(commit `9d8de196748b57d7f463a7757eaa447b6483a331`)

### response-failed-server-overloaded.sse

**VERBATIM** shape produced by the `sse_failed(id, code, message)` helper
(`codex-rs/core/tests/common/responses.rs`, lines 1060-1068), called as
`sse_failed("disabled-model", "server_is_overloaded", "This model is
disabled.")` in `codex-rs/core/tests/suite/retry_after.rs`, functions
`sse_overload_with_retry_after_is_terminal` (line 1278) and
`sse_overload_without_retry_after_is_terminal` (line 1351).
(commits `4b3b569f3975ba4e3bf64589e4d15039066077f8` and
`282cd7b019378746cb87bd91a95d8b4bcae12aa3`)

### response-failed-quota-exceeded.sse (bonus, not explicitly requested but cheap given the research already done)

**VERBATIM** (with `code` fixed to `"insufficient_quota"`, the first of 4
`#[test_case::test_case(...)]` parameterizations) from
`codex-rs/core/tests/suite/quota_exceeded.rs`, function
`quota_exceeded_emits_single_error_event`, lines 29-41.
(commit `31ffe2bc9adccfe5fd3d29208250f796a13aa7a0`)
The same literal is exercised over 3 other codes that are drop-in
substitutions for `"code"`: `credit_balance_exhausted`,
`organization_spend_limit_exceeded`, `project_spend_limit_exceeded`.

### response-incomplete.sse

**VERBATIM.** The literal `incomplete_response = sse(vec![...])` in
`codex-rs/core/tests/suite/client.rs`, function
`incomplete_response_emits_content_filter_error_message`, lines 3696-3711.
(commit `8de2d336b880bed7e6135fedfc2e65e722a744b3`)

## errors.json

- `usage_limit_reached`: **VERBATIM** headers (9 `x-codex-*` headers) and
  body from `codex-rs/core/tests/suite/client.rs`, function
  `usage_limit_error_emits_rate_limit_event`, lines 3506-3526.
  (commit `8de2d336b880bed7e6135fedfc2e65e722a744b3`)
- `unauthorized_401`: **VERBATIM** headers (`x-request-id`, `cf-ray`,
  `x-openai-authorization-error`) and body from
  `codex-rs/codex-api/src/api_bridge_tests.rs`, function
  `map_api_error_extracts_identity_auth_details_from_headers`, lines
  624-645. (commit `9d8de196748b57d7f463a7757eaa447b6483a331`)
  `x-error-json` is the base64 (standard alphabet, matching
  `base64::engine::general_purpose::STANDARD` used by the source) of the
  same source's literal `{"error":{"code":"token_expired"}}` — recomputed,
  not fabricated.
- `server_overloaded_503`: **VERBATIM** header (`Retry-After: 1`) and body
  from `codex-rs/core/tests/suite/retry_after.rs`, function
  `responses_http_uses_retry_after`, lines 288-290.
  (commit `282cd7b019378746cb87bd91a95d8b4bcae12aa3`)
- `cloudflare_blocked_403`: **VERBATIM** header (`cf-ray: ray-id`) and
  HTML body from `codex-rs/codex-api/src/api_bridge_tests.rs`, function
  `map_api_error_maps_cloudflare_blocked_response_to_user_message`, lines
  164-175. The body is a string, not JSON.
  (commit `6ba4bf9e647cf8bc17eb9005af5ca9498bd7e654`)
- `misalignment_policy_violation_403`: **VERBATIM** body from the same file,
  function `assert_misalignment_policy_violation_from_http_body`, lines
  353-361, which codex runs with both 400 and 403; this is the 403 one. No
  headers. (commit `6ba4bf9e647cf8bc17eb9005af5ca9498bd7e654`)
- `internal_server_error_500`: **INFERRED.** `map_api_error` in
  `codex-rs/codex-api/src/api_bridge.rs` line 174-175 maps _any_ HTTP 500 to
  `CodexErr::InternalServerError` purely on status code — it never parses
  the body — so no codex-rs test constructs a literal 500 body to
  transcribe. The body here is a generic placeholder OpenAI-style error
  envelope for completeness; its field values are not verified against any
  source and are not read by codex or by via's classifier either.

## usage.json

**Field names VERBATIM**, values **transcribed from a Rust struct
literal** (not itself a JSON literal — this endpoint has no JSON test
fixture in the repo, only Rust-typed ones):

- Field names (serde `rename` attributes) from
  `codex-rs/codex-backend-openapi-models/src/models/`:
  `rate_limit_status_payload.rs` (commit
  `657bd889ae28edcbf5395c103b479bf8b328704e`),
  `rate_limit_status_details.rs` (commit
  `5c680c6587e5a2c3e65b8b7b45c9df52c69bc8a6`),
  `rate_limit_window_snapshot.rs` (commit
  `4fb714fb46ac729f38ba8219fba59b491717c100`),
  `additional_rate_limit_details.rs` (commit
  `fdd0cd1de974bebe26c8c31d955eea628c8ef96a`),
  `credit_status_details.rs` (commit `4288091f63cdffc21cfeaea4290c734056188808`),
  `spend_control_status_details.rs` and `spend_control_limit_details.rs`
  (both commit `c8e5db16c9994affe8e1959fb76d58c3775d4075`).
- Values from the Rust struct literal in
  `codex-rs/backend-client/src/client.rs`, function
  `usage_payload_maps_primary_and_additional_rate_limits`, lines 866-923.
  (commit `22a3f6d5d89c026c6b4f606ae5604f9e00059b23`)
- Endpoint confirmed as `GET {base}/wham/usage` (ChatGPT-API path style) in
  `codex-rs/backend-client/src/client/rate_limit_resets.rs`, lines 124-129.
  (commit `50379197779be0e5afcbddb014a34cd1fc08af53`)
- Fields the test literal leaves at `Default::default()` under
  `..Default::default()` (`allowed`/`limit_reached` bools default `false`;
  `Option<Option<T>>` fields such as `approx_local_messages`,
  `approx_cloud_messages`, `source`, and the omitted `secondary_window` on
  the `codex_other` limit default to the _outer_ `None`) are **omitted**
  from `usage.json` entirely rather than written as `null`, because every
  one of these fields is annotated `skip_serializing_if = "Option::is_none"`
  together with `serde_with::rust::double_option` — the real serializer
  would omit the key, not emit `null`, in this state. This is a structural
  inference (how absence serializes) layered on top of verbatim field names
  and verbatim present-field values.

## Surprises (for via's maintainers)

- **`packages/codex-upstream/src/collect-response.ts`** only inspects the
  _terminal_ SSE event (`response.completed` or `response.failed`) and
  passes everything else through as an untyped `Progress` value — it never
  parses `response.output_text.delta`, `response.output_item.*`,
  `response.in_progress`, `response.content_part.*`, or
  `codex.rate_limits`. That means `text-reply.sse`'s streaming events,
  `reasoning-plus-text.sse`'s reasoning item, and the entire
  `codex.rate_limits` event in `rate-limits.sse` are effectively **dead
  data** for via today — via only ever looks at the final
  `response.completed`/`response.failed` frame. If via ever wants
  token-by-token streaming to callers, or wants to surface rate-limit
  telemetry to the pool, it will need to start parsing these.
- `collect-response.ts` also requires `response.failed.response.error.code`
  **and** `.message` to both be present, non-null strings to build a typed
  failure — `response-failed-server-overloaded.sse` (from `sse_failed()`)
  satisfies this, but real overloaded/5xx _HTTP-level_ errors (see
  `errors.json`) never reach this parser at all, since they fail before an
  SSE body exists.
- The real `codex.rate_limits` event (`rate-limits.sse`) carries `allowed`,
  `limit_reached`, `code_review_rate_limits`, and `promo` fields that
  codex's own `RateLimitEvent` struct
  (`codex-rs/codex-api/src/rate_limits.rs`, lines 125-133) doesn't even
  deserialize (extra/unknown fields, silently dropped by serde) — codex
  only reads `type`, `plan_type`, `rate_limits.{primary,secondary}`,
  `credits`, `metered_limit_name`, `limit_name`. via reads none of it.
- **`packages/pool/src/classify.ts`** only reads the `retry-after` HTTP
  header — it never looks at any of the nine `x-codex-*` headers codex's
  own client parses (`x-codex-primary-used-percent`,
  `x-codex-rate-limit-reached-type`, etc., all present verbatim in
  `errors.json`'s `usage_limit_reached` case). So via can currently tell
  _that_ a request was rate-limited and _when_ to retry (if `retry-after`
  is present), but not _how close to the limit_ the account is, nor
  _which_ limit was hit (`x-codex-active-limit`) — data codex's backend
  clearly sends.
- via's `QUOTA_CODES` set (`usage_limit_reached`, `insufficient_quota`,
  `usage_not_included`) is narrower than the full set of codes codex-rs's
  own `map_api_error` treats as quota exhaustion (see
  `codex-rs/codex-api/src/api_bridge.rs` lines 205-217 and
  `response-failed-quota-exceeded.sse`'s source test):
  `credit_balance_exhausted`, `organization_spend_limit_exceeded`,
  `project_spend_limit_exceeded`, and (HTTP-body-only, not in
  `quota_exceeded.rs`'s SSE test but present in `map_api_error`)
  `organization_usage_limit_exceeded`. A 429 carrying one of these four
  extra codes would currently NOT classify as quota-exhausted in via.
