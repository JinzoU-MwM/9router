# 9Router Go Rewrite — Design

Date: 2026-09-24
Status: Approved direction, pending spec review

## Goal

Replace the whole Node/Next.js stack (gateway `open-sse/` + `src/sse/`, management API `src/app/api/*`, Next dashboard, `custom-server.js`) with **one Go binary** that serves the gateway, the management API and an embedded dashboard SPA. The rewrite is **performance-first**: redesign for the hot path, not a file-by-file translation of the JS. What is preserved is **behavior**: all 125 providers, every client-facing API format, and existing user data (imported from the current SQLite DB).

Language: Go (chosen over Rust — IO-bound workload, loosely-shaped JSON translation, faster port of ~150k lines).
Database: SQLite (chosen over Postgres — embedded, zero-ops, single-node deployment; production data on hermes is 74 MB / ~2.7 req/s peak, far below SQLite limits).

## Non-goals

- Multi-instance / clustered deployment (would require Postgres; out of scope).
- New product features. Behavior parity first; improvements only where they serve performance/stability.
- Keeping Node running alongside Go. No transitional reverse proxy to Next.
- Rewriting the `cli/` npm launcher in this project (it keeps launching a server; it will be pointed at the Go binary in the cutover sub-project).

## Performance targets (verified by load test before cutover)

| Metric | Target |
|---|---|
| Gateway overhead p99 (excluding upstream time) | < 2 ms |
| Idle RSS with 1639 connections loaded | < 50 MB |
| Cold start to serving | < 300 ms |
| Latency under peak (10× hermes peak, ~27 req/s streaming) | no p99 spikes > 2× p50 overhead |
| DB writes on request path | 0 synchronous (except token refresh) |

Baseline numbers are measured against the current Node server on the same machine with the same mock upstream.

## Production data profile (hermes, 2026-09-24)

- `data.sqlite` 74 MB; `usageHistory` 75k rows / 37 days (~5k/day); peak 160 req/min.
- `providerConnections` 1639 rows (grok-cli 1013), ~1.5 KB JSON each.
- `kv` 13 MB, of which `gemini_thought_signatures` 10 MB / 10k rows, unbounded.
- `usageHistory` carries 5 indexes (~19 MB) over 24 MB of data.

Current hot-path problems this design removes: per-request DB read + JSON parse + sort of all connections (`src/sse/services/auth.js`), synchronous `lastUsedAt` write per request, per-request `sumApiKeyTokens` aggregate, unbounded signature cache, over-indexed usage table.

## Architecture

```
go/
  cmd/9router/            main: config, open store, build snapshot, start server, graceful shutdown
  internal/
    server/               net/http mux, middleware (client IP, API-key auth, limits, body cap), static SPA
    api/v1/               chat, messages(+count_tokens), responses(+compact), embeddings, images,
                          audio (speech/transcriptions/voices), videos, search, systemone, models
    api/v1beta/           Gemini-native endpoints
    api/admin/            management API (replaces src/app/api/* groups)
    engine/               request core: resolve model/combo, account loop, retry/refresh, stream pump
    translator/           (from,to) registry; request/, response/, concerns/, schema/
    executor/             Executor interface, default (OpenAI-compatible), special executors
    provider/             registry + models (generated JSON, go:embed), capabilities, pricing
    account/              lock-free snapshot, per-provider selection index, cooldown, token refresh
    rtk/                  tool_result compressors + system injectors, fail-open
    store/                SQLite: schema, migrations, reader pool, batch writer, repos
    wire/                 SSE reader/writer, AWS EventStream (kiro), protobuf (cursor), NDJSON
    usage/                usage accounting, rollups, retention
  gen/                    Node script: export JS registry/models/config → JSON (run once, then JSON is source of truth)
  parity/                 golden-fixture harness + mock upstreams
  web/                    Vite + React SPA (dashboard), built into internal/server/dist via go:embed
  tools/migrate/          one-shot importer: old data.sqlite → new schema
```

Each package has one purpose and a small exported surface. `engine` depends on interfaces (`Executor`, `Translator`, `AccountPicker`, `UsageSink`), not concrete packages, so each can be tested in isolation.

### Request flow (`POST /v1/chat/completions` and siblings)

1. `server` middleware: client IP from TCP socket (trust `X-Forwarded-For` only from loopback proxy — preserves `custom-server.js` semantics), body size cap, API-key validation against snapshot, per-key limits against in-memory counters.
2. `engine` resolves `provider/model` or combo from the snapshot.
3. Candidate accounts come from `account` index (no DB).
4. For each candidate:
   - **Fast path**: client format == provider format and no RTK/inject configured for the request → forward raw bytes; stream upstream bytes back unchanged while a selective JSON scanner extracts model/usage/finish_reason.
   - **Translate path**: RTK pre-hooks (fail-open) → request translation (direct route if registered, else via OpenAI pivot) → post-translate hooks → `executor.Execute(ctx)` → streaming response translation → client.
   - Retryable failure (401/403 with refreshable token, 429, 5xx, network): refresh (singleflight per account) or mark cooldown, continue to next account/model per current fallback rules.
5. Usage + `lastUsedAt` events pushed to `store` writer channel (non-blocking; bounded, drops to counter + log line if full — never blocks a request).
6. Client disconnect cancels `ctx`, which aborts the upstream request.

### Hot-path performance mechanisms

- **Snapshot state**: connections, combos, API keys, settings, provider nodes, proxy pools, aliases, disabled/custom models live in one immutable `*State` behind `atomic.Pointer`. Reads are a pointer load. Writes (admin API, token refresh, cooldown) build a new snapshot and swap. Per-account volatile fields (cooldown until, last used, error count) live in a per-account struct with atomics so they don't force snapshot rebuilds.
- **Selection index**: per provider, accounts pre-sorted by priority; round-robin/sticky/least-recently-used strategies reproduce current behavior in O(1) amortized.
- **JSON**: `bytedance/sonic` on amd64/arm64, `goccy/go-json` fallback. Typed structs for OpenAI / Claude / Gemini / Responses with a raw-extras map so unknown fields pass through.
- **Buffers**: `sync.Pool` for SSE line buffers and body buffers; flush per SSE event.
- **Upstream transport**: one `http.Transport` per (upstream host, proxy) pair; HTTP/2 enabled, `MaxIdleConnsPerHost` sized for concurrency, TLS session cache, explicit dial / TLS / response-header timeouts from runtime config; streaming bodies have idle-read timeout, not total timeout.
- **Backpressure**: per-provider concurrency limit (semaphore) configurable; excess returns 429 fast instead of queuing unbounded.
- **Memory**: `GOMEMLIMIT` set from config (default 256 MiB), request body cap, no full-response buffering for streams.

### Data layer (SQLite)

- Driver: `modernc.org/sqlite` (pure Go, no cgo, trivial cross-compile). Writes are batched, so the ~1.5–2× raw speed gap vs cgo drivers is irrelevant.
- Pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `temp_store=MEMORY`, `mmap_size`, `cache_size=-64000`, `busy_timeout=5000`, `wal_autocheckpoint=1000`, `journal_size_limit=64MB`, `auto_vacuum=INCREMENTAL`, `foreign_keys=ON`.
- Connections: one writer connection owned by a single writer goroutine; a read pool (N = GOMAXPROCS) for admin/dashboard queries.
- **Batch writer**: channel of write ops; commits every 100 ms or 256 ops in one transaction. Drained on shutdown, then `wal_checkpoint(TRUNCATE)`.
- **Synchronous writes**: OAuth token refresh results and admin mutations go through the same writer goroutine as priority ops with a reply channel; the writer flushes pending batch, switches to `synchronous=FULL`, commits the op in its own tx, switches back, then replies. The caller swaps the snapshot only after the reply. One writer connection means no `SQLITE_BUSY` between writers.
- **Schema (new, normalized)**:
  - `connections`: id, provider, auth_type, name, email, priority, is_active, status, cooldown_until, last_used_at, expires_at, secret_blob (AES-GCM: access/refresh token, API key), extra (JSON for provider-specific fields).
  - `combos`, `api_keys` (+ limits columns), `settings` (key/value typed), `provider_nodes`, `proxy_pools`, `model_aliases`, `custom_models`, `disabled_models`.
  - `usage_events` (append-only: ts, provider, model, connection_id, api_key_id, endpoint, prompt/completion/cached/reasoning tokens, cost, status, latency_ms) with **2 indexes**: `(ts)` and `(api_key_id, ts)`.
  - `usage_hourly` and `usage_daily` rollups (provider, model, connection, api_key dimensions), updated by the writer in the same batch transaction. Dashboard charts read rollups only.
  - `request_details` capped ring (keep latest N, default 1000, as today).
  - `thought_signatures`: TTL table (default 24 h), fronted by an in-memory LRU; expired rows pruned by the maintenance job.
- **Encryption**: secrets encrypted with AES-256-GCM; key from `NINEROUTER_SECRET_KEY` env or `~/.9router/secret.key` (created 0600). DB and backup files created 0600, directories 0700.
- **Maintenance job** (every 10 min, off the hot path): retention prune of `usage_events` (default 90 days, configurable; rollups kept forever), signature TTL prune, `incremental_vacuum` in small steps, daily `VACUUM INTO` backup with rotation, `PRAGMA quick_check` on startup.
- Data dir: `DATA_DIR`, else `~/.9router/`. New DB file name `9router.sqlite` so the old `data.sqlite` is never overwritten.

### Provider registry

- `gen/export-registry.mjs` imports the current JS registry, `config/providerModels.js`, capabilities, pricing and runtime constants and writes JSON into `go/internal/provider/data/`. Run once at the start; after that the JSON is edited directly and the JS is deleted.
- Generic OpenAI-compatible providers need no code: `executor.Default` + registry JSON.
- Special executors (current list: antigravity, azure, codebuddy-cn, codebuddy-intl, codex, commandcode, cursor, devin-cli, gemini-cli, github, grok-cli, grok-web, iflow, kimchi, kiro, mimo-free, ollama-local, opencode, opencode-go, opencode-zen, perplexity-web, qoder, trae, vertex, windsurf, xiaomi-mimo, xiaomi-tokenplan, zed) are ported as Go types implementing `Executor`. Binary formats (kiro EventStream, cursor protobuf, commandcode NDJSON) are handled inside their executor using `wire/`.
- Media handlers (image, tts, stt, video, search, embeddings, fetch; ~50 sub-provider files) are ported per modality behind a `MediaProvider` interface.

### Translator

- Registry keyed by `(from, to)`; direct routes take precedence over the OpenAI pivot, same as today.
- Existing pairs to cover: request — antigravity→openai, claude→kiro, claude→openai, gemini→openai, openai-responses, openai→claude, openai→commandcode, openai→cursor, openai→gemini, openai→kiro, openai→ollama, openai→vertex; response — claude→openai, commandcode→openai, cursor→openai, gemini→openai, kiro→claude, kiro→openai, ollama→openai, openai-responses, openai→antigravity, openai→claude; plus `transformer/` (Chat SSE → Responses SSE, stream→JSON).
- Role/block/finish-reason strings come from `translator/schema` constants only.

### RTK

- Tool-result compressors, headroom proxy, and system-prompt injectors ported with identical fail-open semantics: every hook runs under `recover()`, any error returns the body untouched; `is_error` / `status:"error"` results are skipped. Prompt files still load from `DATA_DIR/prompts`.

### Management API + dashboard

- Every group under `src/app/api/` (auth, cli-tools, combos, headroom, health, init, keys, locale, mcp, media-providers, models, oauth, pricing, provider-nodes, providers, proxy-pools, pxpipe, settings, shutdown, tags, translator, tunnel, usage, version) is reimplemented in `api/admin` with the same paths and JSON shapes, so the ported UI works unchanged against it.
- Auth: JWT session cookie (`JWT_SECRET`), bcrypt password (`INITIAL_PASSWORD`), same semantics as today.
- Dashboard: Vite + React SPA. Existing React components, zustand stores, recharts, xyflow, dnd-kit are moved over; Next-specific APIs (`next/link`, `next/navigation`, server components, route handlers) replaced with react-router + fetch. Monaco and xyflow are lazy-loaded. Build output is pre-compressed (br + gzip) and served with immutable cache headers from `go:embed`.
- Live dashboard updates (usage, account status) via an SSE endpoint fed from in-memory events — no polling.

## Error handling

- Upstream errors normalized into the client's format using the current `errorConfig` mapping (status → retry/cooldown/refresh decision), ported as data.
- Every account-loop decision (refresh, cooldown, skip, fail) is logged with request id, provider, connection id — no secrets.
- Panics in any request goroutine are recovered at the handler boundary and returned as a 500 in client format; panics in RTK/translator hooks fall back to fail-open.
- Writer channel full → event dropped, `dropped_usage_events` counter incremented, rate-limited warning. Request never blocks.
- Graceful shutdown: stop accepting, wait for in-flight streams (configurable timeout, default 30 s), drain writer, checkpoint, exit.

## Testing and verification

1. **Golden fixtures** (`parity/`): a Node script runs every current translator (request + response, streaming chunk-by-chunk) over inputs from `tests/` plus anonymized real request shapes, and stores input/output pairs as JSON. Go tests must produce semantically equal JSON (same keys, values and array order; object key order ignored). Generated once before the JS is deleted and committed.
2. **Mock upstreams**: an in-process fake server per special executor (including EventStream / protobuf / NDJSON framing, error codes, token-expiry responses) to test executor + engine end to end, including fallback and refresh.
3. **Unit tests** per package for account selection, cooldown, snapshot swap, batch writer (crash/drain), rollups, retention, encryption.
4. **Migration test**: import a copy of the hermes DB, assert row counts and a sample of decrypted secrets match the source.
5. **Shadow replay on hermes**: Go runs on a side port with a migrated copy of the DB; recorded request shapes replayed to both Node and Go against mock upstreams; response diffs must be empty.
6. **Load test** (`vegeta` or `k6` against mock upstream): measure the targets above for both Node and Go; cutover only when Go meets every target.
7. `go test -race` on all packages in CI.

## Sub-projects (each gets its own implementation plan)

1. **Foundation**: repo layout, config, store (schema, writer, reader pool, encryption, maintenance), snapshot/account index, server + middleware, migration tool, registry export + embed.
2. **Gateway core**: engine, default executor, fast path, OpenAI/Claude/Gemini/Responses translators + transformer, `/v1` chat/messages/responses/models, `/v1beta`, usage pipeline, golden-fixture harness. Exit: parity on core translators + load-test targets on default executor.
3. **Special executors**: port in order of hermes traffic — grok-cli, openai-compatible nodes, zed, kimchi, then the rest; each with mock upstream tests.
4. **Media + RTK**: embeddings, images, audio, videos, search, fetch, systemone; RTK compressors/injectors/headroom.
5. **Management API**: all `src/app/api/*` groups, OAuth flows, token refresh, cloud sync, tunnel, MCP.
6. **Dashboard SPA**: Vite migration of the Next UI, embed, live SSE updates.
7. **Cutover**: shadow replay + load test on hermes, `cli/` launcher points at the Go binary, packaging (release binaries per OS/arch), removal of Node code.

## Risks

- **Undocumented JS behavior** in translators/executors (edge cases only visible in production). Mitigation: golden fixtures + shadow replay before cutover; old Node build kept runnable until cutover sign-off.
- **sonic portability**: JIT only on amd64/arm64; build tag fallback to go-json elsewhere.
- **Next-specific UI code** may need more than mechanical porting (server components, route handlers inside pages). Mitigation: sub-project 6 starts with an inventory of Next-only APIs.
- **Scope**: ~150k lines of JS. Sub-projects are independently shippable to a test port, so progress is measurable.
