# Go Rewrite — Sub-project 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bootable Go binary (`go/cmd/9router`) with config, encrypted SQLite store (batched single writer), lock-free state snapshot with account selection matching current JS semantics, embedded provider registry, a one-shot importer from the old `data.sqlite`, and an HTTP server with client-IP + API-key middleware and `/api/health`.

**Architecture:** Everything lives under `go/` as module `ninerouter`. `store` owns SQLite (one writer goroutine, read pool, AES-GCM secrets). `state` builds an immutable `*Snapshot` from the store and publishes it through `atomic.Pointer`. `account` holds per-account runtime state (last used, sticky count, model locks) that survives snapshot rebuilds, plus the selection algorithm. `server` is stdlib `net/http`. Later sub-projects (gateway, executors, admin API, SPA) plug into these packages.

**Tech Stack:** Go 1.26, `modernc.org/sqlite` (pure Go, no cgo), stdlib only otherwise. Node (existing repo) only for the one-time registry export script.

**Spec:** `docs/superpowers/specs/2026-09-24-go-rewrite-design.md`

## Global Constraints

- Go module path: `ninerouter`, root directory `go/`. Run all `go` commands from `/home/jamnas/Code/Coding/9router/go`.
- Only external dependency allowed in this sub-project: `modernc.org/sqlite`.
- SQLite pragmas (writer): `auto_vacuum=INCREMENTAL`, `busy_timeout=5000`, `journal_mode=WAL`, `synchronous=NORMAL`, `temp_store=MEMORY`, `mmap_size=268435456`, `cache_size=-64000`, `foreign_keys=ON`, `wal_autocheckpoint=1000`, `journal_size_limit=67108864`.
- Batch writer: flush every 100 ms or 256 ops; queue 8192; request path never blocks on the DB.
- Files: data dir `0700`, DB / key / backup files `0600`.
- New DB path: `<DATA_DIR>/db/9router.sqlite` (`DATA_DIR` default `~/.9router`). The old `data.sqlite` is opened read-only and never modified.
- All timestamps stored as unix milliseconds (`INTEGER`), UTC.
- Secrets (`accessToken`, `refreshToken`, `idToken`, `apiKey`, `providerSpecificData`, API key strings) are stored only AES-256-GCM encrypted.
- Default port `20128`, default host `0.0.0.0` (env `PORT`, `HOSTNAME`), same as the Node server.
- Error JSON shape (from `open-sse/utils/error.js`): `{"error":{"message":…,"type":…,"code":…}}`; 401 → `type:"authentication_error"`, `code:"invalid_api_key"`.
- `go test -race ./...` must pass at the end of every task.
- Commit style: Conventional Commits, scope `go` (e.g. `feat(go): …`). End every commit message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Deliberate deviations from the spec (decided while planning)

- **Rollups:** one `usage_rollups` table at hourly granularity instead of separate hourly + daily tables. Daily views are a `GROUP BY` over ~24× fewer rows than events; halves write amplification.
- **Settings:** stored as one JSON document (same as today) with typed decoding of the hot fields; the dashboard writes ~60 loosely-typed keys and a typed table buys nothing.
- **Small catalogs** (`customModels`, `disabledModels`, `modelAliases`): kept in a generic `kv` table; only `gemini_thought_signatures` moves to its own TTL table.
- **Account selection:** O(n) scan per pick under a per-provider mutex (n ≈ 1000 on hermes → a few µs), not a heap. Marked with a `ponytail:` comment.
- **No `data_version` watcher:** Node no longer runs alongside Go, so the Go process is the only writer.

## File Structure

```
go/
  go.mod, go.sum
  cmd/9router/main.go                 wiring: config → key → store → snapshot → server; signals; maintenance loop
  cmd/9router-migrate/main.go         CLI for the old-DB importer
  internal/config/config.go           env → Config
  internal/secret/secret.go           key file + AES-GCM Box
  internal/store/
    db.go                             Open(): writer + reader pools, pragmas, perms
    migrate.go, migrations/001_init.sql
    writer.go                         batched single writer, Exclusive/Do, Close
    store.go                          Store struct
    connections.go                    connections + model locks
    catalog.go                        api keys, combos, settings, nodes, pools, kv, meta, thought signatures, request details
    usage.go                          usage events + hourly rollups
    maintenance.go                    retention, TTL prune, incremental vacuum, backup, quick_check
  internal/account/account.go         Account runtime + Selector (pick algorithm)
  internal/state/settings.go          Settings decoding + defaults
  internal/state/state.go             Snapshot, Holder, Build
  internal/provider/registry.go       embedded registry + alias resolution
  internal/provider/data/registry.json   generated
  internal/migrate/migrate.go         old data.sqlite → new store
  internal/server/errors.go, clientip.go, apikey.go, server.go
  gen/export-registry.mjs             Node: export JS registry → JSON
```

---

### Task 1: Module scaffold + config

**Files:**
- Create: `go/go.mod`
- Create: `go/internal/config/config.go`
- Test: `go/internal/config/config_test.go`

**Interfaces:**
- Produces: `config.Config{Port int; Host string; DataDir string; MemLimitMiB int64; BodyLimitBytes int64; ShutdownTimeout time.Duration; SecretKey string}`; methods `Addr() string`, `DBPath() string`, `KeyPath() string`, `BackupDir() string`; `config.Load(getenv func(string) string, home string) (Config, error)`.

- [ ] **Step 1: Create the module**

```bash
mkdir -p /home/jamnas/Code/Coding/9router/go && cd /home/jamnas/Code/Coding/9router/go && go mod init ninerouter
```

Expected: `go.mod` containing `module ninerouter` and `go 1.26…`.

- [ ] **Step 2: Write the failing test**

`go/internal/config/config_test.go`:

```go
package config

import (
	"path/filepath"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadDefaults(t *testing.T) {
	c, err := Load(env(nil), "/home/u")
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 20128 || c.Host != "0.0.0.0" {
		t.Fatalf("addr defaults: %+v", c)
	}
	if c.DataDir != filepath.Join("/home/u", ".9router") {
		t.Fatalf("data dir: %s", c.DataDir)
	}
	if c.MemLimitMiB != 256 || c.BodyLimitBytes != 64<<20 || c.ShutdownTimeout != 30*time.Second {
		t.Fatalf("limits: %+v", c)
	}
	if c.DBPath() != "/home/u/.9router/db/9router.sqlite" {
		t.Fatalf("db path: %s", c.DBPath())
	}
	if c.KeyPath() != "/home/u/.9router/secret.key" || c.BackupDir() != "/home/u/.9router/db/backups" {
		t.Fatalf("paths: %s %s", c.KeyPath(), c.BackupDir())
	}
	if c.Addr() != "0.0.0.0:20128" {
		t.Fatalf("addr: %s", c.Addr())
	}
}

func TestLoadOverrides(t *testing.T) {
	c, err := Load(env(map[string]string{
		"PORT": "9000", "HOSTNAME": "127.0.0.1", "DATA_DIR": "/data",
		"NINEROUTER_MEMLIMIT_MIB": "512", "NINEROUTER_SHUTDOWN_TIMEOUT": "5s",
		"NINEROUTER_SECRET_KEY": "abc",
	}), "/home/u")
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr() != "127.0.0.1:9000" || c.DataDir != "/data" || c.MemLimitMiB != 512 ||
		c.ShutdownTimeout != 5*time.Second || c.SecretKey != "abc" {
		t.Fatalf("overrides: %+v", c)
	}
}

func TestLoadRejectsBadValues(t *testing.T) {
	for _, m := range []map[string]string{
		{"PORT": "0"}, {"PORT": "70000"}, {"PORT": "x"},
		{"NINEROUTER_MEMLIMIT_MIB": "8"}, {"NINEROUTER_SHUTDOWN_TIMEOUT": "-1s"},
	} {
		if _, err := Load(env(m), "/home/u"); err == nil {
			t.Errorf("expected error for %v", m)
		}
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test ./internal/config/`
Expected: FAIL, `undefined: Load`.

- [ ] **Step 4: Implement**

`go/internal/config/config.go`:

```go
// Package config reads runtime configuration from the environment.
package config

import (
	"fmt"
	"net"
	"path/filepath"
	"strconv"
	"time"
)

type Config struct {
	Port            int
	Host            string
	DataDir         string
	MemLimitMiB     int64
	BodyLimitBytes  int64
	ShutdownTimeout time.Duration
	SecretKey       string // base64 32-byte key; overrides the key file when set
}

func (c Config) Addr() string      { return net.JoinHostPort(c.Host, strconv.Itoa(c.Port)) }
func (c Config) DBPath() string    { return filepath.Join(c.DataDir, "db", "9router.sqlite") }
func (c Config) KeyPath() string   { return filepath.Join(c.DataDir, "secret.key") }
func (c Config) BackupDir() string { return filepath.Join(c.DataDir, "db", "backups") }

// Load builds a Config from getenv; home is the user's home directory.
func Load(getenv func(string) string, home string) (Config, error) {
	c := Config{
		Port:            20128,
		Host:            "0.0.0.0",
		DataDir:         filepath.Join(home, ".9router"),
		MemLimitMiB:     256,
		BodyLimitBytes:  64 << 20,
		ShutdownTimeout: 30 * time.Second,
		SecretKey:       getenv("NINEROUTER_SECRET_KEY"),
	}
	if v := getenv("PORT"); v != "" {
		p, err := strconv.Atoi(v)
		if err != nil || p < 1 || p > 65535 {
			return Config{}, fmt.Errorf("invalid PORT %q", v)
		}
		c.Port = p
	}
	if v := getenv("HOSTNAME"); v != "" {
		c.Host = v
	}
	if v := getenv("DATA_DIR"); v != "" {
		c.DataDir = v
	}
	if v := getenv("NINEROUTER_MEMLIMIT_MIB"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 16 {
			return Config{}, fmt.Errorf("invalid NINEROUTER_MEMLIMIT_MIB %q (min 16)", v)
		}
		c.MemLimitMiB = n
	}
	if v := getenv("NINEROUTER_SHUTDOWN_TIMEOUT"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return Config{}, fmt.Errorf("invalid NINEROUTER_SHUTDOWN_TIMEOUT %q", v)
		}
		c.ShutdownTimeout = d
	}
	return c, nil
}
```

- [ ] **Step 5: Run tests**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test -race ./internal/config/`
Expected: `ok  ninerouter/internal/config`

- [ ] **Step 6: Commit**

```bash
cd /home/jamnas/Code/Coding/9router && git add go/go.mod go/internal/config && git commit -m "feat(go): module scaffold and env config

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Secret key + AES-GCM box

**Files:**
- Create: `go/internal/secret/secret.go`
- Test: `go/internal/secret/secret_test.go`

**Interfaces:**
- Produces: `secret.KeySize = 32`; `secret.LoadOrCreateKey(path, envKey string) ([]byte, error)`; `secret.New(key []byte) (*Box, error)`; `(*Box).Seal(plain []byte) []byte`; `(*Box).Open(data []byte) ([]byte, error)`; `secret.ErrCorrupt`.

- [ ] **Step 1: Write the failing test**

`go/internal/secret/secret_test.go`:

```go
package secret

import (
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestSealOpenRoundTrip(t *testing.T) {
	b, err := New(bytes.Repeat([]byte{7}, KeySize))
	if err != nil {
		t.Fatal(err)
	}
	ct := b.Seal([]byte("tok-123"))
	if bytes.Contains(ct, []byte("tok-123")) {
		t.Fatal("ciphertext contains plaintext")
	}
	if bytes.Equal(ct, b.Seal([]byte("tok-123"))) {
		t.Fatal("nonce reuse: identical ciphertexts")
	}
	pt, err := b.Open(ct)
	if err != nil || string(pt) != "tok-123" {
		t.Fatalf("open: %q %v", pt, err)
	}
}

func TestOpenRejectsTamper(t *testing.T) {
	b, _ := New(bytes.Repeat([]byte{7}, KeySize))
	ct := b.Seal([]byte("x"))
	ct[len(ct)-1] ^= 1
	if _, err := b.Open(ct); err != ErrCorrupt {
		t.Fatalf("want ErrCorrupt, got %v", err)
	}
	if _, err := b.Open([]byte{1, 2}); err != ErrCorrupt {
		t.Fatalf("short input: want ErrCorrupt, got %v", err)
	}
}

func TestNewRejectsBadKeySize(t *testing.T) {
	if _, err := New(make([]byte, 16)); err == nil {
		t.Fatal("expected error")
	}
}

func TestLoadOrCreateKeyFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "secret.key")
	k1, err := LoadOrCreateKey(path, "")
	if err != nil || len(k1) != KeySize {
		t.Fatalf("create: %v len=%d", err, len(k1))
	}
	st, err := os.Stat(path)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("perm: %v %v", st.Mode().Perm(), err)
	}
	dir, _ := os.Stat(filepath.Dir(path))
	if dir.Mode().Perm() != 0o700 {
		t.Fatalf("dir perm: %v", dir.Mode().Perm())
	}
	k2, err := LoadOrCreateKey(path, "")
	if err != nil || !bytes.Equal(k1, k2) {
		t.Fatal("key not reused")
	}
}

func TestLoadOrCreateKeyEnv(t *testing.T) {
	want := bytes.Repeat([]byte{9}, KeySize)
	k, err := LoadOrCreateKey(filepath.Join(t.TempDir(), "unused"), base64.StdEncoding.EncodeToString(want))
	if err != nil || !bytes.Equal(k, want) {
		t.Fatalf("env key: %v", err)
	}
	if _, err := LoadOrCreateKey("x", "not-base64!"); err == nil {
		t.Fatal("expected error for bad env key")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test ./internal/secret/`
Expected: FAIL, `undefined: New`.

- [ ] **Step 3: Implement**

`go/internal/secret/secret.go`:

```go
// Package secret encrypts credentials at rest with AES-256-GCM.
package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const KeySize = 32

var ErrCorrupt = errors.New("secret: ciphertext corrupt or wrong key")

// LoadOrCreateKey returns the base64 envKey when set, else reads the hex key file at
// path, creating it (0600, parent dir 0700) with a random key when missing.
func LoadOrCreateKey(path, envKey string) ([]byte, error) {
	if envKey != "" {
		k, err := base64.StdEncoding.DecodeString(envKey)
		if err != nil || len(k) != KeySize {
			return nil, errors.New("NINEROUTER_SECRET_KEY must be base64 of 32 bytes")
		}
		return k, nil
	}
	if b, err := os.ReadFile(path); err == nil {
		return decodeKeyFile(path, b)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	k := make([]byte, KeySize)
	rand.Read(k)
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) { // another process created it first
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		return decodeKeyFile(path, b)
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if _, err := f.WriteString(hex.EncodeToString(k) + "\n"); err != nil {
		return nil, err
	}
	return k, f.Sync()
}

func decodeKeyFile(path string, b []byte) ([]byte, error) {
	k, err := hex.DecodeString(strings.TrimSpace(string(b)))
	if err != nil || len(k) != KeySize {
		return nil, fmt.Errorf("key file %s is not a 32-byte hex key", path)
	}
	return k, nil
}

type Box struct{ aead cipher.AEAD }

func New(key []byte) (*Box, error) {
	if len(key) != KeySize {
		return nil, fmt.Errorf("secret: key must be %d bytes", KeySize)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Box{aead: aead}, nil
}

// Seal returns nonce || ciphertext.
func (b *Box) Seal(plain []byte) []byte {
	n := b.aead.NonceSize()
	nonce := make([]byte, n, n+len(plain)+b.aead.Overhead())
	rand.Read(nonce)
	return b.aead.Seal(nonce, nonce, plain, nil)
}

func (b *Box) Open(data []byte) ([]byte, error) {
	n := b.aead.NonceSize()
	if len(data) < n+b.aead.Overhead() {
		return nil, ErrCorrupt
	}
	p, err := b.aead.Open(nil, data[:n], data[n:], nil)
	if err != nil {
		return nil, ErrCorrupt
	}
	return p, nil
}
```

- [ ] **Step 4: Run tests**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test -race ./internal/secret/`
Expected: `ok  ninerouter/internal/secret`

- [ ] **Step 5: Commit**

```bash
cd /home/jamnas/Code/Coding/9router && git add go/internal/secret && git commit -m "feat(go): AES-GCM secret box with 0600 key file

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: SQLite open, pragmas, schema migration

**Files:**
- Create: `go/internal/store/db.go`
- Create: `go/internal/store/migrate.go`
- Create: `go/internal/store/migrations/001_init.sql`
- Test: `go/internal/store/db_test.go`

**Interfaces:**
- Produces: `store.DB{R, W *sql.DB; Path string}`; `store.Open(path string) (*DB, error)`; `(*DB).Close() error`. `R` is a read-only pool, `W` has exactly one connection and is used only by the `Writer` (Task 4).

- [ ] **Step 1: Add the driver**

```bash
cd /home/jamnas/Code/Coding/9router/go && go get modernc.org/sqlite@latest
```

- [ ] **Step 2: Write the schema**

`go/internal/store/migrations/001_init.sql`:

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE settings (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
) STRICT;

CREATE TABLE connections (
  id                    TEXT PRIMARY KEY,
  provider              TEXT NOT NULL,
  auth_type             TEXT NOT NULL DEFAULT '',
  name                  TEXT NOT NULL DEFAULT '',
  email                 TEXT NOT NULL DEFAULT '',
  priority              INTEGER NOT NULL DEFAULT 0,
  is_active             INTEGER NOT NULL DEFAULT 1,
  test_status           TEXT NOT NULL DEFAULT '',
  error_code            TEXT NOT NULL DEFAULT '',
  backoff_level         INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT NOT NULL DEFAULT '',
  last_error_at         INTEGER NOT NULL DEFAULT 0,
  rate_limited_until    INTEGER NOT NULL DEFAULT 0,
  expires_at            INTEGER NOT NULL DEFAULT 0,
  last_used_at          INTEGER NOT NULL DEFAULT 0,
  consecutive_use_count INTEGER NOT NULL DEFAULT 0,
  secret                BLOB NOT NULL,
  extra                 TEXT NOT NULL DEFAULT '{}',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_connections_provider ON connections(provider);

CREATE TABLE model_locks (
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  model         TEXT NOT NULL,
  until         INTEGER NOT NULL,
  PRIMARY KEY (connection_id, model)
) STRICT, WITHOUT ROWID;

CREATE TABLE api_keys (
  id         TEXT PRIMARY KEY,
  key_hash   TEXT NOT NULL UNIQUE,
  key_enc    BLOB NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  machine_id TEXT NOT NULL DEFAULT '',
  is_active  INTEGER NOT NULL DEFAULT 1,
  limits     TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE combos (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL DEFAULT '',
  models     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE provider_nodes (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL DEFAULT '',
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE proxy_pools (
  id          TEXT PRIMARY KEY,
  is_active   INTEGER NOT NULL DEFAULT 1,
  test_status TEXT NOT NULL DEFAULT '',
  data        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE kv (
  scope TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (scope, key)
) STRICT, WITHOUT ROWID;

CREATE TABLE thought_signatures (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_thought_signatures_exp ON thought_signatures(expires_at);

CREATE TABLE usage_events (
  id                 INTEGER PRIMARY KEY,
  ts                 INTEGER NOT NULL,
  provider           TEXT NOT NULL DEFAULT '',
  model              TEXT NOT NULL DEFAULT '',
  connection_id      TEXT NOT NULL DEFAULT '',
  api_key_id         TEXT NOT NULL DEFAULT '',
  endpoint           TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT '',
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  cached_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  cost               REAL NOT NULL DEFAULT 0,
  latency_ms         INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX idx_usage_events_ts ON usage_events(ts);
CREATE INDEX idx_usage_events_key_ts ON usage_events(api_key_id, ts);

CREATE TABLE usage_rollups (
  bucket             INTEGER NOT NULL,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  connection_id      TEXT NOT NULL,
  api_key_id         TEXT NOT NULL,
  requests           INTEGER NOT NULL DEFAULT 0,
  errors             INTEGER NOT NULL DEFAULT 0,
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  cached_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens   INTEGER NOT NULL DEFAULT 0,
  cost               REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, provider, model, connection_id, api_key_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX idx_usage_rollups_key ON usage_rollups(api_key_id, bucket);

CREATE TABLE request_details (
  id            TEXT PRIMARY KEY,
  ts            INTEGER NOT NULL,
  provider      TEXT NOT NULL DEFAULT '',
  model         TEXT NOT NULL DEFAULT '',
  connection_id TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT '',
  data          TEXT NOT NULL
) STRICT;
CREATE INDEX idx_request_details_ts ON request_details(ts);
```

- [ ] **Step 3: Write the failing test**

`go/internal/store/db_test.go`:

```go
package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOpenCreatesSchemaAndPragmas(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db", "9router.sqlite")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	var v int
	if err := db.W.QueryRow("PRAGMA user_version").Scan(&v); err != nil || v != 1 {
		t.Fatalf("user_version=%d err=%v", v, err)
	}
	var mode string
	db.W.QueryRow("PRAGMA journal_mode").Scan(&mode)
	if mode != "wal" {
		t.Fatalf("journal_mode=%s", mode)
	}
	var av int
	db.W.QueryRow("PRAGMA auto_vacuum").Scan(&av)
	if av != 2 {
		t.Fatalf("auto_vacuum=%d, want 2 (incremental)", av)
	}
	for _, table := range []string{"connections", "model_locks", "api_keys", "usage_events", "usage_rollups", "thought_signatures"} {
		var n int
		db.R.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&n)
		if n != 1 {
			t.Errorf("missing table %s", table)
		}
	}
	if _, err := db.R.Exec("INSERT INTO meta(key,value) VALUES('a','b')"); err == nil {
		t.Fatal("reader pool must be read-only")
	}
	st, _ := os.Stat(path)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("db perm %v", st.Mode().Perm())
	}
	d, _ := os.Stat(filepath.Dir(path))
	if d.Mode().Perm() != 0o700 {
		t.Fatalf("dir perm %v", d.Mode().Perm())
	}
}

func TestOpenIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.sqlite")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	db, err = Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	db.Close()
}

func TestOpenRejectsNewerSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.sqlite")
	db, _ := Open(path)
	db.W.Exec("PRAGMA user_version = 99")
	db.Close()
	if _, err := Open(path); err == nil {
		t.Fatal("expected error for newer schema")
	}
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test ./internal/store/`
Expected: FAIL, `undefined: Open`.

- [ ] **Step 5: Implement**

`go/internal/store/db.go`:

```go
// Package store is the SQLite persistence layer: one writer connection owned by
// Writer, plus a read-only pool.
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"

	_ "modernc.org/sqlite"
)

type DB struct {
	R    *sql.DB // read-only pool
	W    *sql.DB // single connection; use only through Writer
	Path string
}

var writerPragmas = []string{
	"auto_vacuum(INCREMENTAL)", // must precede table creation to take effect
	"busy_timeout(5000)",
	"journal_mode(WAL)",
	"synchronous(NORMAL)",
	"temp_store(MEMORY)",
	"mmap_size(268435456)",
	"cache_size(-64000)",
	"foreign_keys(ON)",
	"wal_autocheckpoint(1000)",
	"journal_size_limit(67108864)",
}

var readerPragmas = []string{
	"busy_timeout(5000)",
	"temp_store(MEMORY)",
	"mmap_size(268435456)",
	"cache_size(-64000)",
	"query_only(1)",
}

func dsn(path string, pragmas []string, txlock bool) string {
	q := url.Values{}
	for _, p := range pragmas {
		q.Add("_pragma", p)
	}
	if txlock {
		q.Set("_txlock", "immediate")
	}
	return "file:" + path + "?" + q.Encode()
}

// Open creates (0600, dir 0700) or opens the database and applies migrations.
func Open(path string) (*DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	f.Close()

	w, err := sql.Open("sqlite", dsn(path, writerPragmas, true))
	if err != nil {
		return nil, err
	}
	w.SetMaxOpenConns(1)
	w.SetMaxIdleConns(1)
	w.SetConnMaxLifetime(0)
	if err := migrate(w); err != nil {
		w.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}

	r, err := sql.Open("sqlite", dsn(path, readerPragmas, false))
	if err != nil {
		w.Close()
		return nil, err
	}
	n := max(4, runtime.GOMAXPROCS(0))
	r.SetMaxOpenConns(n)
	r.SetMaxIdleConns(n)

	for _, suffix := range []string{"-wal", "-shm"} {
		_ = os.Chmod(path+suffix, 0o600)
	}
	return &DB{R: r, W: w, Path: path}, nil
}

func (d *DB) Close() error { return errors.Join(d.R.Close(), d.W.Close()) }
```

`go/internal/store/migrate.go`:

```go
package store

import (
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strings"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// migrate applies migrations/NNN_*.sql in order, tracking progress in PRAGMA user_version.
func migrate(db *sql.DB) error {
	var current int
	if err := db.QueryRow("PRAGMA user_version").Scan(&current); err != nil {
		return err
	}
	names, err := fs.Glob(migrationFS, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	if current > len(names) {
		return fmt.Errorf("database schema v%d is newer than this binary (v%d)", current, len(names))
	}
	for i, name := range names {
		n := i + 1
		if !strings.HasPrefix(name, fmt.Sprintf("migrations/%03d_", n)) {
			return fmt.Errorf("migration %s out of sequence", name)
		}
		if n <= current {
			continue
		}
		body, err := migrationFS.ReadFile(name)
		if err != nil {
			return err
		}
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(string(body)); err != nil {
			tx.Rollback()
			return fmt.Errorf("%s: %w", name, err)
		}
		if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", n)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}
```

- [ ] **Step 6: Run tests**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test -race ./internal/store/`
Expected: `ok  ninerouter/internal/store`. If `modernc` rejects a multi-statement `Exec`, split the file on `;\n` in `migrate` and exec each non-empty statement in the same tx.

- [ ] **Step 7: Commit**

```bash
cd /home/jamnas/Code/Coding/9router && git add go/go.mod go/go.sum go/internal/store && git commit -m "feat(go): SQLite open with WAL pragmas, 0600 perms, embedded migrations

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Batched single writer

**Files:**
- Create: `go/internal/store/writer.go`
- Test: `go/internal/store/writer_test.go`
- Create: `go/internal/store/helpers_test.go`

**Interfaces:**
- Consumes: `store.Open`, `DB.W`, `DB.R` (Task 3).
- Produces: `store.Op func(tx *sql.Tx) error`; `store.WriterOptions{FlushEvery time.Duration; MaxBatch int; QueueSize int; Logf func(string, ...any)}`; `store.NewWriter(db *sql.DB, opt WriterOptions) *Writer`; `(*Writer).Enqueue(op Op) bool`; `(*Writer).Do(ctx context.Context, op Op) error`; `(*Writer).Exclusive(ctx context.Context, fn func(context.Context, *sql.Conn) error) error`; `(*Writer).Dropped() uint64`; `(*Writer).Close() error`; `store.ErrClosed`.

- [ ] **Step 1: Write the test helper**

`go/internal/store/helpers_test.go`:

```go
package store

import (
	"path/filepath"
	"testing"
	"time"
)

func openTestDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "t.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func countMeta(t *testing.T, db *DB) int {
	t.Helper()
	var n int
	if err := db.R.QueryRow("SELECT count(*) FROM meta").Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met within 2s")
}
```

- [ ] **Step 2: Write the failing test**

`go/internal/store/writer_test.go`:

```go
package store

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"
)

func putMeta(k, v string) Op {
	return func(tx *sql.Tx) error {
		_, err := tx.Exec("INSERT INTO meta(key,value) VALUES(?,?)", k, v)
		return err
	}
}

func TestEnqueueFlushesOnClose(t *testing.T) {
	db := openTestDB(t)
	w := NewWriter(db.W, WriterOptions{FlushEvery: time.Hour})
	for _, k := range []string{"a", "b", "c"} {
		if !w.Enqueue(putMeta(k, "1")) {
			t.Fatal("enqueue refused")
		}
	}
	w.Close()
	if n := countMeta(t, db); n != 3 {
		t.Fatalf("rows=%d", n)
	}
}

func TestEnqueueFlushesOnTimer(t *testing.T) {
	db := openTestDB(t)
	w := NewWriter(db.W, WriterOptions{FlushEvery: 10 * time.Millisecond})
	defer w.Close()
	w.Enqueue(putMeta("a", "1"))
	waitFor(t, func() bool { return countMeta(t, db) == 1 })
}

func TestEnqueueFlushesOnMaxBatch(t *testing.T) {
	db := openTestDB(t)
	w := NewWriter(db.W, WriterOptions{FlushEvery: time.Hour, MaxBatch: 2})
	defer w.Close()
	w.Enqueue(putMeta("a", "1"))
	w.Enqueue(putMeta("b", "1"))
	waitFor(t, func() bool { return countMeta(t, db) == 2 })
}

func TestFailingOpDoesNotLoseSiblings(t *testing.T) {
	db := openTestDB(t)
	w := NewWriter(db.W, WriterOptions{FlushEvery: time.Hour, Logf: func(string, ...any) {}})
	w.Enqueue(putMeta("a", "1"))
	w.Enqueue(putMeta("a", "dup")) // PK violation
	w.Enqueue(putMeta("b", "1"))
	w.Close()
	if n := countMeta(t, db); n != 2 {
		t.Fatalf("rows=%d", n)
	}
}

func TestDoIsVisibleImmediately(t *testing.T) {
	db := openTestDB(t)
	w := NewWriter(db.W, WriterOptions{FlushEvery: time.Hour})
	defer w.Close()
	w.Enqueue(putMeta("queued", "1"))
	if err := w.Do(context.Background(), putMeta("sync", "1")); err != nil {
		t.Fatal(err)
	}
	// Do flushes the pending batch first, then commits its own tx.
	if n := countMeta(t, db); n != 2 {
		t.Fatalf("rows=%d", n)
	}
	var sync int
	db.W.QueryRow("PRAGMA synchronous").Scan(&sync)
	if sync != 1 {
		t.Fatalf("synchronous not restored to NORMAL: %d", sync)
	}
}

func TestDoReturnsOpError(t *testing.T) {
	db := openTestDB(t)
	w := NewWriter(db.W, WriterOptions{})
	defer w.Close()
	boom := errors.New("boom")
	err := w.Do(context.Background(), func(tx *sql.Tx) error {
		tx.Exec("INSERT INTO meta(key,value) VALUES('x','1')")
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("err=%v", err)
	}
	if n := countMeta(t, db); n != 0 {
		t.Fatal("failed Do must roll back")
	}
}

func TestQueueFullDrops(t *testing.T) {
	db := openTestDB(t)
	w := NewWriter(db.W, WriterOptions{FlushEvery: time.Hour, QueueSize: 1})
	started, release := make(chan struct{}), make(chan struct{})
	go w.Exclusive(context.Background(), func(context.Context, *sql.Conn) error {
		close(started)
		<-release
		return nil
	})
	<-started // writer goroutine is busy; nothing drains the queue
	if !w.Enqueue(putMeta("a", "1")) {
		t.Fatal("first enqueue should fit the buffer")
	}
	if w.Enqueue(putMeta("b", "1")) {
		t.Fatal("second enqueue should be dropped")
	}
	if w.Dropped() != 1 {
		t.Fatalf("dropped=%d", w.Dropped())
	}
	close(release)
	w.Close()
	if n := countMeta(t, db); n != 1 {
		t.Fatalf("rows=%d", n)
	}
}

func TestClosedWriterRefuses(t *testing.T) {
	db := openTestDB(t)
	w := NewWriter(db.W, WriterOptions{})
	w.Close()
	w.Close() // idempotent
	if w.Enqueue(putMeta("a", "1")) {
		t.Fatal("enqueue after close")
	}
	if err := w.Do(context.Background(), putMeta("a", "1")); !errors.Is(err, ErrClosed) {
		t.Fatalf("err=%v", err)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test ./internal/store/ -run 'Enqueue|Do|Queue|Closed|Failing'`
Expected: FAIL, `undefined: NewWriter`.

- [ ] **Step 4: Implement**

`go/internal/store/writer.go`:

```go
package store

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"sync"
	"sync/atomic"
	"time"
)

// Op is one write executed inside a transaction owned by the writer goroutine.
type Op func(tx *sql.Tx) error

type WriterOptions struct {
	FlushEvery time.Duration // default 100ms
	MaxBatch   int           // default 256
	QueueSize  int           // default 8192
	Logf       func(format string, args ...any)
}

var ErrClosed = errors.New("store: writer closed")

type exclusiveReq struct {
	ctx  context.Context
	fn   func(context.Context, *sql.Conn) error
	done chan error
}

// Writer serializes every write through one goroutine and one connection, so
// SQLite never sees two writers. Async ops are batched into one transaction.
type Writer struct {
	db      *sql.DB
	opt     WriterOptions
	async   chan Op
	excl    chan exclusiveReq
	quit    chan struct{}
	done    chan struct{}
	closed  atomic.Bool
	once    sync.Once
	dropped atomic.Uint64
}

func NewWriter(db *sql.DB, opt WriterOptions) *Writer {
	if opt.FlushEvery <= 0 {
		opt.FlushEvery = 100 * time.Millisecond
	}
	if opt.MaxBatch <= 0 {
		opt.MaxBatch = 256
	}
	if opt.QueueSize <= 0 {
		opt.QueueSize = 8192
	}
	if opt.Logf == nil {
		opt.Logf = log.Printf
	}
	w := &Writer{
		db:    db,
		opt:   opt,
		async: make(chan Op, opt.QueueSize),
		excl:  make(chan exclusiveReq),
		quit:  make(chan struct{}),
		done:  make(chan struct{}),
	}
	go w.loop()
	return w
}

// Enqueue never blocks. It returns false (and counts a drop) when the queue is
// full or the writer is closed.
func (w *Writer) Enqueue(op Op) bool {
	if w.closed.Load() {
		w.dropped.Add(1)
		return false
	}
	select {
	case w.async <- op:
		return true
	default:
		w.dropped.Add(1)
		return false
	}
}

func (w *Writer) Dropped() uint64 { return w.dropped.Load() }

// Exclusive runs fn on the writer connection after flushing pending ops. No
// transaction is open, so fn may run VACUUM, checkpoints or PRAGMAs. Once fn has
// been handed to the writer, Exclusive waits for its result even if ctx ends.
func (w *Writer) Exclusive(ctx context.Context, fn func(context.Context, *sql.Conn) error) error {
	if w.closed.Load() {
		return ErrClosed
	}
	req := exclusiveReq{ctx: ctx, fn: fn, done: make(chan error, 1)}
	select {
	case w.excl <- req:
	case <-w.done:
		return ErrClosed
	case <-ctx.Done():
		return ctx.Err()
	}
	return <-req.done
}

// Do commits op durably (synchronous=FULL) before returning.
func (w *Writer) Do(ctx context.Context, op Op) error {
	return w.Exclusive(ctx, func(ctx context.Context, c *sql.Conn) error {
		if _, err := c.ExecContext(ctx, "PRAGMA synchronous = FULL"); err != nil {
			return err
		}
		defer c.ExecContext(context.Background(), "PRAGMA synchronous = NORMAL")
		tx, err := c.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if err := op(tx); err != nil {
			tx.Rollback()
			return err
		}
		return tx.Commit()
	})
}

// Close drains queued ops, commits them, checkpoints the WAL and stops the
// goroutine. Ops enqueued concurrently with Close may be lost.
func (w *Writer) Close() error {
	w.once.Do(func() {
		w.closed.Store(true)
		close(w.quit)
	})
	<-w.done
	return nil
}

func (w *Writer) loop() {
	defer close(w.done)
	ticker := time.NewTicker(w.opt.FlushEvery)
	defer ticker.Stop()
	batch := make([]Op, 0, w.opt.MaxBatch)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		w.commit(batch)
		clear(batch)
		batch = batch[:0]
	}
	add := func(op Op) {
		batch = append(batch, op)
		if len(batch) >= w.opt.MaxBatch {
			flush()
		}
	}
	for {
		select {
		case op := <-w.async:
			add(op)
		case <-ticker.C:
			flush()
		case r := <-w.excl:
			flush()
			r.done <- w.runExclusive(r)
		case <-w.quit:
		drain:
			for {
				select {
				case op := <-w.async:
					add(op)
				default:
					break drain
				}
			}
			flush()
			if _, err := w.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
				w.opt.Logf("store: checkpoint: %v", err)
			}
			return
		}
	}
}

func (w *Writer) runExclusive(r exclusiveReq) error {
	c, err := w.db.Conn(r.ctx)
	if err != nil {
		return err
	}
	defer c.Close()
	return r.fn(r.ctx, c)
}

// commit runs the batch in one transaction; each op gets a savepoint so one
// failing op is rolled back alone.
func (w *Writer) commit(batch []Op) {
	tx, err := w.db.Begin()
	if err != nil {
		w.opt.Logf("store: begin batch: %v (dropping %d ops)", err, len(batch))
		w.dropped.Add(uint64(len(batch)))
		return
	}
	for _, op := range batch {
		if _, err := tx.Exec("SAVEPOINT op"); err != nil {
			w.opt.Logf("store: savepoint: %v", err)
			w.dropped.Add(1)
			continue
		}
		if err := op(tx); err != nil {
			w.opt.Logf("store: op failed: %v", err)
			w.dropped.Add(1)
			tx.Exec("ROLLBACK TO op")
		}
		tx.Exec("RELEASE op")
	}
	if err := tx.Commit(); err != nil {
		w.opt.Logf("store: commit batch: %v (dropping %d ops)", err, len(batch))
		w.dropped.Add(uint64(len(batch)))
	}
}
```

- [ ] **Step 5: Run tests**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test -race ./internal/store/`
Expected: `ok  ninerouter/internal/store`

- [ ] **Step 6: Commit**

```bash
cd /home/jamnas/Code/Coding/9router && git add go/internal/store && git commit -m "feat(go): batched single-writer with savepoints and durable Do

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Store + connections + model locks

**Files:**
- Create: `go/internal/store/store.go`
- Create: `go/internal/store/connections.go`
- Modify: `go/internal/store/helpers_test.go` (add `newTestStore`)
- Test: `go/internal/store/connections_test.go`

**Interfaces:**
- Consumes: `secret.Box` (Task 2), `Writer` (Task 4).
- Produces:
  - `store.New(db *DB, box *secret.Box, w *Writer) *Store`; `(*Store).DB() *DB`; `(*Store).Writer() *Writer`.
  - `store.Credentials{AccessToken, RefreshToken, IDToken, APIKey string; ProviderSpecificData map[string]any}` (JSON tags `accessToken`, `refreshToken`, `idToken`, `apiKey`, `providerSpecificData`, all `omitempty`).
  - `store.Connection{ID, Provider, AuthType, Name, Email string; Priority int; IsActive bool; TestStatus, ErrorCode string; BackoffLevel int; LastError string; LastErrorAt, RateLimitedUntil, ExpiresAt, LastUsedAt int64; ConsecutiveUseCount int; Secret Credentials; Extra map[string]any; CreatedAt, UpdatedAt int64}`.
  - `(*Store).LoadConnections(ctx) ([]Connection, error)` ordered by `created_at, id`.
  - `(*Store).PutConnections(ctx, cs ...Connection) error` (durable upsert).
  - `(*Store).TouchConnection(id string, lastUsedAt int64, consecutive int) bool` (async).
  - `store.AllModels = "__all"`; `(*Store).LoadModelLocks(ctx, now int64) (map[string]map[string]int64, error)` (only `until > now`); `(*Store).SetModelLock(connID, model string, until int64) bool` (async); `(*Store).ClearModelLocks(connID string) bool` (async).

- [ ] **Step 1: Write the failing test**

Append to `go/internal/store/helpers_test.go`:

```go
func newTestStore(t *testing.T) *Store {
	t.Helper()
	db := openTestDB(t)
	box, err := secret.New(bytes.Repeat([]byte{1}, secret.KeySize))
	if err != nil {
		t.Fatal(err)
	}
	w := NewWriter(db.W, WriterOptions{FlushEvery: 5 * time.Millisecond})
	t.Cleanup(func() { w.Close() })
	return New(db, box, w)
}
```

and extend its import block to:

```go
import (
	"bytes"
	"path/filepath"
	"testing"
	"time"

	"ninerouter/internal/secret"
)
```

`go/internal/store/connections_test.go`:

```go
package store

import (
	"bytes"
	"context"
	"reflect"
	"testing"
)

func sampleConn(id string) Connection {
	return Connection{
		ID: id, Provider: "zed", AuthType: "oauth", Name: "acc " + id, Email: id + "@x.io",
		Priority: 2, IsActive: true, TestStatus: "active", BackoffLevel: 1,
		ExpiresAt: 1_800_000_000_000, CreatedAt: 1_700_000_000_000, UpdatedAt: 1_700_000_000_001,
		Secret: Credentials{
			AccessToken: "tok-" + id, RefreshToken: "ref-" + id,
			ProviderSpecificData: map[string]any{"userId": "u1"},
		},
		Extra: map[string]any{"defaultModel": "m1"},
	}
}

func TestConnectionsRoundTrip(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	in := []Connection{sampleConn("a"), sampleConn("b")}
	if err := s.PutConnections(ctx, in...); err != nil {
		t.Fatal(err)
	}
	out, err := s.LoadConnections(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(in, out) {
		t.Fatalf("round trip mismatch:\n in=%+v\nout=%+v", in, out)
	}
	var raw []byte
	s.DB().R.QueryRow("SELECT secret FROM connections WHERE id='a'").Scan(&raw)
	if bytes.Contains(raw, []byte("tok-a")) {
		t.Fatal("secret stored in plaintext")
	}
}

func TestPutConnectionsUpserts(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	c := sampleConn("a")
	s.PutConnections(ctx, c)
	c.Name = "renamed"
	c.IsActive = false
	s.PutConnections(ctx, c)
	out, _ := s.LoadConnections(ctx)
	if len(out) != 1 || out[0].Name != "renamed" || out[0].IsActive {
		t.Fatalf("upsert: %+v", out)
	}
}

func TestTouchConnection(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	s.PutConnections(ctx, sampleConn("a"))
	if !s.TouchConnection("a", 42, 3) {
		t.Fatal("touch refused")
	}
	s.Writer().Close()
	out, _ := s.LoadConnections(ctx)
	if out[0].LastUsedAt != 42 || out[0].ConsecutiveUseCount != 3 {
		t.Fatalf("touch not applied: %+v", out[0])
	}
}

func TestModelLocks(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	s.PutConnections(ctx, sampleConn("a"), sampleConn("b"))
	s.SetModelLock("a", "m1", 200)
	s.SetModelLock("a", AllModels, 50) // expired at now=100
	s.SetModelLock("b", "m2", 300)
	s.SetModelLock("a", "m1", 250) // overwrite
	waitFor(t, func() bool {
		l, _ := s.LoadModelLocks(ctx, 100)
		return l["a"]["m1"] == 250 && l["b"]["m2"] == 300
	})
	locks, _ := s.LoadModelLocks(ctx, 100)
	if _, ok := locks["a"][AllModels]; ok {
		t.Fatal("expired lock returned")
	}
	s.ClearModelLocks("a")
	waitFor(t, func() bool {
		l, _ := s.LoadModelLocks(ctx, 100)
		return len(l["a"]) == 0 && l["b"]["m2"] == 300
	})
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test ./internal/store/ -run 'Connection|ModelLocks'`
Expected: FAIL, `undefined: New` / `undefined: Connection`.

- [ ] **Step 3: Implement**

`go/internal/store/store.go`:

```go
package store

import "ninerouter/internal/secret"

// Store is the typed repository over DB. Reads use the read pool; writes go
// through the Writer.
type Store struct {
	db  *DB
	box *secret.Box
	w   *Writer
}

func New(db *DB, box *secret.Box, w *Writer) *Store { return &Store{db: db, box: box, w: w} }

func (s *Store) DB() *DB         { return s.db }
func (s *Store) Writer() *Writer { return s.w }
```

`go/internal/store/connections.go`:

```go
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
)

// AllModels is the model key of an account-level lock (JS: modelLock___all).
const AllModels = "__all"

type Credentials struct {
	AccessToken          string         `json:"accessToken,omitempty"`
	RefreshToken         string         `json:"refreshToken,omitempty"`
	IDToken              string         `json:"idToken,omitempty"`
	APIKey               string         `json:"apiKey,omitempty"`
	ProviderSpecificData map[string]any `json:"providerSpecificData,omitempty"`
}

type Connection struct {
	ID, Provider, AuthType, Name, Email string
	Priority                            int
	IsActive                            bool
	TestStatus, ErrorCode               string
	BackoffLevel                        int
	LastError                           string
	LastErrorAt                         int64
	RateLimitedUntil                    int64
	ExpiresAt                           int64
	LastUsedAt                          int64
	ConsecutiveUseCount                 int
	Secret                              Credentials
	Extra                               map[string]any
	CreatedAt, UpdatedAt                int64
}

const connCols = `id, provider, auth_type, name, email, priority, is_active, test_status, error_code,
backoff_level, last_error, last_error_at, rate_limited_until, expires_at, last_used_at,
consecutive_use_count, secret, extra, created_at, updated_at`

func (s *Store) LoadConnections(ctx context.Context) ([]Connection, error) {
	rows, err := s.db.R.QueryContext(ctx, `SELECT `+connCols+` FROM connections ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Connection
	for rows.Next() {
		var c Connection
		var active int
		var sealed []byte
		var extra string
		if err := rows.Scan(&c.ID, &c.Provider, &c.AuthType, &c.Name, &c.Email, &c.Priority, &active,
			&c.TestStatus, &c.ErrorCode, &c.BackoffLevel, &c.LastError, &c.LastErrorAt,
			&c.RateLimitedUntil, &c.ExpiresAt, &c.LastUsedAt, &c.ConsecutiveUseCount,
			&sealed, &extra, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		c.IsActive = active == 1
		plain, err := s.box.Open(sealed)
		if err != nil {
			return nil, fmt.Errorf("connection %s: %w", c.ID, err)
		}
		if err := json.Unmarshal(plain, &c.Secret); err != nil {
			return nil, fmt.Errorf("connection %s secret: %w", c.ID, err)
		}
		if err := json.Unmarshal([]byte(extra), &c.Extra); err != nil {
			return nil, fmt.Errorf("connection %s extra: %w", c.ID, err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) PutConnections(ctx context.Context, cs ...Connection) error {
	return s.w.Do(ctx, func(tx *sql.Tx) error {
		for _, c := range cs {
			if err := s.upsertConnection(tx, c); err != nil {
				return fmt.Errorf("connection %s: %w", c.ID, err)
			}
		}
		return nil
	})
}

func (s *Store) upsertConnection(tx *sql.Tx, c Connection) error {
	plain, err := json.Marshal(c.Secret)
	if err != nil {
		return err
	}
	if c.Extra == nil {
		c.Extra = map[string]any{}
	}
	extra, err := json.Marshal(c.Extra)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO connections(`+connCols+`)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, auth_type=excluded.auth_type,
 name=excluded.name, email=excluded.email, priority=excluded.priority, is_active=excluded.is_active,
 test_status=excluded.test_status, error_code=excluded.error_code, backoff_level=excluded.backoff_level,
 last_error=excluded.last_error, last_error_at=excluded.last_error_at,
 rate_limited_until=excluded.rate_limited_until, expires_at=excluded.expires_at,
 last_used_at=excluded.last_used_at, consecutive_use_count=excluded.consecutive_use_count,
 secret=excluded.secret, extra=excluded.extra, updated_at=excluded.updated_at`,
		c.ID, c.Provider, c.AuthType, c.Name, c.Email, c.Priority, boolInt(c.IsActive),
		c.TestStatus, c.ErrorCode, c.BackoffLevel, c.LastError, c.LastErrorAt,
		c.RateLimitedUntil, c.ExpiresAt, c.LastUsedAt, c.ConsecutiveUseCount,
		s.box.Seal(plain), string(extra), c.CreatedAt, c.UpdatedAt)
	return err
}

func (s *Store) TouchConnection(id string, lastUsedAt int64, consecutive int) bool {
	return s.w.Enqueue(func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE connections SET last_used_at=?, consecutive_use_count=? WHERE id=?`,
			lastUsedAt, consecutive, id)
		return err
	})
}

func (s *Store) LoadModelLocks(ctx context.Context, now int64) (map[string]map[string]int64, error) {
	rows, err := s.db.R.QueryContext(ctx, `SELECT connection_id, model, until FROM model_locks WHERE until > ?`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]map[string]int64{}
	for rows.Next() {
		var id, model string
		var until int64
		if err := rows.Scan(&id, &model, &until); err != nil {
			return nil, err
		}
		if out[id] == nil {
			out[id] = map[string]int64{}
		}
		out[id][model] = until
	}
	return out, rows.Err()
}

func (s *Store) SetModelLock(connID, model string, until int64) bool {
	return s.w.Enqueue(func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO model_locks(connection_id, model, until) VALUES(?,?,?)
ON CONFLICT(connection_id, model) DO UPDATE SET until=excluded.until`, connID, model, until)
		return err
	})
}

func (s *Store) ClearModelLocks(connID string) bool {
	return s.w.Enqueue(func(tx *sql.Tx) error {
		_, err := tx.Exec(`DELETE FROM model_locks WHERE connection_id=?`, connID)
		return err
	})
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
```

- [ ] **Step 4: Run tests**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test -race ./internal/store/`
Expected: `ok  ninerouter/internal/store`

- [ ] **Step 5: Commit**

```bash
cd /home/jamnas/Code/Coding/9router && git add go/internal/store && git commit -m "feat(go): encrypted connections repo and model locks

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Catalog repos (API keys, combos, settings, nodes, pools, kv, meta, signatures, request details)

**Files:**
- Create: `go/internal/store/catalog.go`
- Test: `go/internal/store/catalog_test.go`

**Interfaces:**
- Consumes: `Store`, `Writer.Do` (Tasks 4–5).
- Produces:
  - `store.HashKey(key string) string` (sha256 hex).
  - `store.APIKey{ID, Key, Name, MachineID string; IsActive bool; Limits json.RawMessage; CreatedAt int64}`; `LoadAPIKeys(ctx) ([]APIKey, error)`; `PutAPIKeys(ctx, ks ...APIKey) error`.
  - `store.Combo{ID, Name, Kind string; Models []string; CreatedAt, UpdatedAt int64}`; `LoadCombos(ctx) ([]Combo, error)`; `PutCombos(ctx, cs ...Combo) error`.
  - `LoadSettings(ctx) (json.RawMessage, error)` (nil when unset); `PutSettings(ctx, raw json.RawMessage) error`.
  - `store.ProviderNode{ID, Type, Name string; Data json.RawMessage; CreatedAt, UpdatedAt int64}`; `LoadProviderNodes`, `PutProviderNodes`.
  - `store.ProxyPool{ID string; IsActive bool; TestStatus string; Data json.RawMessage; CreatedAt, UpdatedAt int64}`; `LoadProxyPools`, `PutProxyPools`.
  - `store.KV{Scope, Key string; Value json.RawMessage}`; `LoadKV(ctx, scope string) ([]KV, error)`; `PutKV(ctx, items ...KV) error`.
  - `GetMeta(ctx, key string) (string, bool, error)`; `SetMeta(ctx, key, value string) error`.
  - `store.ThoughtSignature{Key string; Value json.RawMessage; ExpiresAt int64}`; `PutThoughtSignatures(ctx, items ...ThoughtSignature) error`; `GetThoughtSignature(ctx, key string, now int64) (json.RawMessage, bool, error)`.
  - `store.RequestDetail{ID string; TS int64; Provider, Model, ConnectionID, Status string; Data json.RawMessage}`; `PutRequestDetails(ctx, items ...RequestDetail) error`.

- [ ] **Step 1: Write the failing test**

`go/internal/store/catalog_test.go`:

```go
package store

import (
	"bytes"
	"context"
	"encoding/json"
	"reflect"
	"testing"
)

func TestAPIKeysEncryptedAndHashed(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	k := APIKey{ID: "k1", Key: "sk-secret-1", Name: "main", MachineID: "m", IsActive: true,
		Limits: json.RawMessage(`{"rpm":10}`), CreatedAt: 5}
	if err := s.PutAPIKeys(ctx, k); err != nil {
		t.Fatal(err)
	}
	out, err := s.LoadAPIKeys(ctx)
	if err != nil || len(out) != 1 || !reflect.DeepEqual(out[0], k) {
		t.Fatalf("round trip: %+v %v", out, err)
	}
	var hash string
	var enc []byte
	s.DB().R.QueryRow("SELECT key_hash, key_enc FROM api_keys").Scan(&hash, &enc)
	if hash != HashKey("sk-secret-1") || bytes.Contains(enc, []byte("sk-secret-1")) {
		t.Fatal("key must be hashed + encrypted")
	}
	if len(HashKey("x")) != 64 {
		t.Fatal("HashKey must be sha256 hex")
	}
}

func TestAPIKeyNullLimits(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	s.PutAPIKeys(ctx, APIKey{ID: "k1", Key: "sk-1", IsActive: true, CreatedAt: 1})
	out, _ := s.LoadAPIKeys(ctx)
	if out[0].Limits != nil {
		t.Fatalf("limits should be nil, got %s", out[0].Limits)
	}
}

func TestCombosSettingsNodesPools(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	c := Combo{ID: "c1", Name: "glm", Kind: "", Models: []string{"a/x", "b/y"}, CreatedAt: 1, UpdatedAt: 2}
	s.PutCombos(ctx, c)
	combos, _ := s.LoadCombos(ctx)
	if !reflect.DeepEqual(combos, []Combo{c}) {
		t.Fatalf("combos: %+v", combos)
	}

	if raw, _ := s.LoadSettings(ctx); raw != nil {
		t.Fatal("settings should start empty")
	}
	s.PutSettings(ctx, json.RawMessage(`{"requireApiKey":false}`))
	s.PutSettings(ctx, json.RawMessage(`{"requireApiKey":true}`))
	raw, _ := s.LoadSettings(ctx)
	if string(raw) != `{"requireApiKey":true}` {
		t.Fatalf("settings: %s", raw)
	}

	n := ProviderNode{ID: "n1", Type: "openai-compatible", Name: "gutsai", Data: json.RawMessage(`{"prefix":"gutsai"}`), CreatedAt: 1, UpdatedAt: 1}
	s.PutProviderNodes(ctx, n)
	nodes, _ := s.LoadProviderNodes(ctx)
	if !reflect.DeepEqual(nodes, []ProviderNode{n}) {
		t.Fatalf("nodes: %+v", nodes)
	}

	p := ProxyPool{ID: "p1", IsActive: true, TestStatus: "ok", Data: json.RawMessage(`{"proxyUrl":"socks5://x"}`), CreatedAt: 1, UpdatedAt: 1}
	s.PutProxyPools(ctx, p)
	pools, _ := s.LoadProxyPools(ctx)
	if !reflect.DeepEqual(pools, []ProxyPool{p}) {
		t.Fatalf("pools: %+v", pools)
	}
}

func TestKVMetaSignaturesDetails(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	s.PutKV(ctx, KV{Scope: "customModels", Key: "a", Value: json.RawMessage(`{"id":"a"}`)},
		KV{Scope: "other", Key: "b", Value: json.RawMessage(`1`)})
	kv, _ := s.LoadKV(ctx, "customModels")
	if len(kv) != 1 || kv[0].Key != "a" || string(kv[0].Value) != `{"id":"a"}` {
		t.Fatalf("kv: %+v", kv)
	}

	if _, ok, _ := s.GetMeta(ctx, "x"); ok {
		t.Fatal("meta should be missing")
	}
	s.SetMeta(ctx, "x", "1")
	s.SetMeta(ctx, "x", "2")
	if v, ok, _ := s.GetMeta(ctx, "x"); !ok || v != "2" {
		t.Fatalf("meta: %q %v", v, ok)
	}

	s.PutThoughtSignatures(ctx, ThoughtSignature{Key: "call_1", Value: json.RawMessage(`{"signature":"s"}`), ExpiresAt: 100})
	if v, ok, _ := s.GetThoughtSignature(ctx, "call_1", 50); !ok || string(v) != `{"signature":"s"}` {
		t.Fatalf("signature: %s %v", v, ok)
	}
	if _, ok, _ := s.GetThoughtSignature(ctx, "call_1", 100); ok {
		t.Fatal("expired signature returned")
	}

	if err := s.PutRequestDetails(ctx, RequestDetail{ID: "r1", TS: 1, Provider: "p", Data: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test ./internal/store/ -run 'APIKey|Combos|KVMeta'`
Expected: FAIL, `undefined: APIKey`.

- [ ] **Step 3: Implement**

`go/internal/store/catalog.go`:

```go
package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
)

func HashKey(key string) string {
	h := sha256.Sum256([]byte(key))
	return hex.EncodeToString(h[:])
}

// ---- API keys ----

type APIKey struct {
	ID, Key, Name, MachineID string
	IsActive                 bool
	Limits                   json.RawMessage // nil when no limits
	CreatedAt                int64
}

func (s *Store) LoadAPIKeys(ctx context.Context) ([]APIKey, error) {
	rows, err := s.db.R.QueryContext(ctx, `SELECT id, key_enc, name, machine_id, is_active, limits, created_at FROM api_keys ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []APIKey
	for rows.Next() {
		var k APIKey
		var enc []byte
		var active int
		var limits sql.NullString
		if err := rows.Scan(&k.ID, &enc, &k.Name, &k.MachineID, &active, &limits, &k.CreatedAt); err != nil {
			return nil, err
		}
		plain, err := s.box.Open(enc)
		if err != nil {
			return nil, fmt.Errorf("api key %s: %w", k.ID, err)
		}
		k.Key = string(plain)
		k.IsActive = active == 1
		if limits.Valid {
			k.Limits = json.RawMessage(limits.String)
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

func (s *Store) PutAPIKeys(ctx context.Context, ks ...APIKey) error {
	return s.w.Do(ctx, func(tx *sql.Tx) error {
		for _, k := range ks {
			var limits any
			if k.Limits != nil {
				limits = string(k.Limits)
			}
			if _, err := tx.Exec(`INSERT INTO api_keys(id, key_hash, key_enc, name, machine_id, is_active, limits, created_at)
VALUES(?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET key_hash=excluded.key_hash, key_enc=excluded.key_enc, name=excluded.name,
 machine_id=excluded.machine_id, is_active=excluded.is_active, limits=excluded.limits`,
				k.ID, HashKey(k.Key), s.box.Seal([]byte(k.Key)), k.Name, k.MachineID, boolInt(k.IsActive), limits, k.CreatedAt); err != nil {
				return fmt.Errorf("api key %s: %w", k.ID, err)
			}
		}
		return nil
	})
}

// ---- combos ----

type Combo struct {
	ID, Name, Kind       string
	Models               []string
	CreatedAt, UpdatedAt int64
}

func (s *Store) LoadCombos(ctx context.Context) ([]Combo, error) {
	rows, err := s.db.R.QueryContext(ctx, `SELECT id, name, kind, models, created_at, updated_at FROM combos ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Combo
	for rows.Next() {
		var c Combo
		var models string
		if err := rows.Scan(&c.ID, &c.Name, &c.Kind, &models, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(models), &c.Models); err != nil {
			return nil, fmt.Errorf("combo %s: %w", c.ID, err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) PutCombos(ctx context.Context, cs ...Combo) error {
	return s.w.Do(ctx, func(tx *sql.Tx) error {
		for _, c := range cs {
			models, err := json.Marshal(c.Models)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(`INSERT INTO combos(id, name, kind, models, created_at, updated_at) VALUES(?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, models=excluded.models, updated_at=excluded.updated_at`,
				c.ID, c.Name, c.Kind, string(models), c.CreatedAt, c.UpdatedAt); err != nil {
				return fmt.Errorf("combo %s: %w", c.ID, err)
			}
		}
		return nil
	})
}

// ---- settings ----

func (s *Store) LoadSettings(ctx context.Context) (json.RawMessage, error) {
	var data string
	err := s.db.R.QueryRowContext(ctx, `SELECT data FROM settings WHERE id=1`).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return json.RawMessage(data), nil
}

func (s *Store) PutSettings(ctx context.Context, raw json.RawMessage) error {
	return s.w.Do(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`, string(raw))
		return err
	})
}

// ---- provider nodes ----

type ProviderNode struct {
	ID, Type, Name       string
	Data                 json.RawMessage
	CreatedAt, UpdatedAt int64
}

func (s *Store) LoadProviderNodes(ctx context.Context) ([]ProviderNode, error) {
	rows, err := s.db.R.QueryContext(ctx, `SELECT id, type, name, data, created_at, updated_at FROM provider_nodes ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ProviderNode
	for rows.Next() {
		var n ProviderNode
		var data string
		if err := rows.Scan(&n.ID, &n.Type, &n.Name, &data, &n.CreatedAt, &n.UpdatedAt); err != nil {
			return nil, err
		}
		n.Data = json.RawMessage(data)
		out = append(out, n)
	}
	return out, rows.Err()
}

func (s *Store) PutProviderNodes(ctx context.Context, ns ...ProviderNode) error {
	return s.w.Do(ctx, func(tx *sql.Tx) error {
		for _, n := range ns {
			if _, err := tx.Exec(`INSERT INTO provider_nodes(id, type, name, data, created_at, updated_at) VALUES(?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET type=excluded.type, name=excluded.name, data=excluded.data, updated_at=excluded.updated_at`,
				n.ID, n.Type, n.Name, string(n.Data), n.CreatedAt, n.UpdatedAt); err != nil {
				return fmt.Errorf("provider node %s: %w", n.ID, err)
			}
		}
		return nil
	})
}

// ---- proxy pools ----

type ProxyPool struct {
	ID                   string
	IsActive             bool
	TestStatus           string
	Data                 json.RawMessage
	CreatedAt, UpdatedAt int64
}

func (s *Store) LoadProxyPools(ctx context.Context) ([]ProxyPool, error) {
	rows, err := s.db.R.QueryContext(ctx, `SELECT id, is_active, test_status, data, created_at, updated_at FROM proxy_pools ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ProxyPool
	for rows.Next() {
		var p ProxyPool
		var active int
		var data string
		if err := rows.Scan(&p.ID, &active, &p.TestStatus, &data, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		p.IsActive = active == 1
		p.Data = json.RawMessage(data)
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) PutProxyPools(ctx context.Context, ps ...ProxyPool) error {
	return s.w.Do(ctx, func(tx *sql.Tx) error {
		for _, p := range ps {
			if _, err := tx.Exec(`INSERT INTO proxy_pools(id, is_active, test_status, data, created_at, updated_at) VALUES(?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET is_active=excluded.is_active, test_status=excluded.test_status, data=excluded.data, updated_at=excluded.updated_at`,
				p.ID, boolInt(p.IsActive), p.TestStatus, string(p.Data), p.CreatedAt, p.UpdatedAt); err != nil {
				return fmt.Errorf("proxy pool %s: %w", p.ID, err)
			}
		}
		return nil
	})
}

// ---- kv ----

type KV struct {
	Scope, Key string
	Value      json.RawMessage
}

func (s *Store) LoadKV(ctx context.Context, scope string) ([]KV, error) {
	rows, err := s.db.R.QueryContext(ctx, `SELECT key, value FROM kv WHERE scope=? ORDER BY key`, scope)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []KV
	for rows.Next() {
		item := KV{Scope: scope}
		var v string
		if err := rows.Scan(&item.Key, &v); err != nil {
			return nil, err
		}
		item.Value = json.RawMessage(v)
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) PutKV(ctx context.Context, items ...KV) error {
	return s.w.Do(ctx, func(tx *sql.Tx) error {
		for _, it := range items {
			if _, err := tx.Exec(`INSERT INTO kv(scope, key, value) VALUES(?,?,?)
ON CONFLICT(scope, key) DO UPDATE SET value=excluded.value`, it.Scope, it.Key, string(it.Value)); err != nil {
				return err
			}
		}
		return nil
	})
}

// ---- meta ----

func (s *Store) GetMeta(ctx context.Context, key string) (string, bool, error) {
	var v string
	err := s.db.R.QueryRowContext(ctx, `SELECT value FROM meta WHERE key=?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return v, err == nil, err
}

func (s *Store) SetMeta(ctx context.Context, key, value string) error {
	return s.w.Do(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO meta(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
		return err
	})
}

// ---- thought signatures ----

type ThoughtSignature struct {
	Key       string
	Value     json.RawMessage
	ExpiresAt int64
}

func (s *Store) PutThoughtSignatures(ctx context.Context, items ...ThoughtSignature) error {
	return s.w.Do(ctx, func(tx *sql.Tx) error {
		for _, it := range items {
			if _, err := tx.Exec(`INSERT INTO thought_signatures(key, value, expires_at) VALUES(?,?,?)
ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at`, it.Key, string(it.Value), it.ExpiresAt); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Store) GetThoughtSignature(ctx context.Context, key string, now int64) (json.RawMessage, bool, error) {
	var v string
	err := s.db.R.QueryRowContext(ctx, `SELECT value FROM thought_signatures WHERE key=? AND expires_at > ?`, key, now).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return json.RawMessage(v), true, nil
}

// ---- request details ----

type RequestDetail struct {
	ID                                      string
	TS                                      int64
	Provider, Model, ConnectionID, Status string
	Data                                    json.RawMessage
}

func (s *Store) PutRequestDetails(ctx context.Context, items ...RequestDetail) error {
	return s.w.Do(ctx, func(tx *sql.Tx) error {
		for _, d := range items {
			if _, err := tx.Exec(`INSERT INTO request_details(id, ts, provider, model, connection_id, status, data) VALUES(?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET ts=excluded.ts, status=excluded.status, data=excluded.data`,
				d.ID, d.TS, d.Provider, d.Model, d.ConnectionID, d.Status, string(d.Data)); err != nil {
				return err
			}
		}
		return nil
	})
}
```

- [ ] **Step 4: Run tests**

Run: `cd /home/jamnas/Code/Coding/9router/go && gofmt -l . ; go test -race ./internal/store/`
Expected: no gofmt output, `ok  ninerouter/internal/store`

- [ ] **Step 5: Commit**

```bash
cd /home/jamnas/Code/Coding/9router && git add go/internal/store && git commit -m "feat(go): catalog repos — api keys, combos, settings, nodes, pools, kv, meta, signatures

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Usage events + hourly rollups

**Files:**
- Create: `go/internal/store/usage.go`
- Test: `go/internal/store/usage_test.go`

**Interfaces:**
- Produces:
  - `store.UsageEvent{TS int64; Provider, Model, ConnectionID, APIKeyID, Endpoint, Status string; PromptTokens, CompletionTokens, CachedTokens, CacheWriteTokens, ReasoningTokens int64; Cost float64; LatencyMS int64}`.
  - `store.HourMS int64 = 3_600_000`.
  - `(*Store).RecordUsage(e UsageEvent) bool` — async: insert event + upsert its hourly rollup in the same batch tx.
  - `(*Store).ImportUsage(ctx, events []UsageEvent) error` — durable bulk insert of events only (no rollups).
  - `(*Store).RebuildRollups(ctx) error` — recompute `usage_rollups` from `usage_events`.
  - `(*Store).SumKeyTokens(ctx, apiKeyID string, since int64) (int64, error)` — `prompt+completion` from rollups with `bucket >= floor(since/hour)*hour` (JS `sumApiKeyTokens` equivalent; exact for hour-aligned `since`, which daily/monthly/lifetime periods are).
  - Status `"ok"` counts as success; anything else increments `errors`.

- [ ] **Step 1: Write the failing test**

`go/internal/store/usage_test.go`:

```go
package store

import (
	"context"
	"testing"
)

func ev(ts int64, key, status string, p, c int64) UsageEvent {
	return UsageEvent{TS: ts, Provider: "zed", Model: "m", ConnectionID: "c1", APIKeyID: key,
		Endpoint: "/v1/chat/completions", Status: status, PromptTokens: p, CompletionTokens: c, Cost: 0.5}
}

type rollup struct {
	requests, errors, prompt, completion int64
	cost                                 float64
}

func readRollup(t *testing.T, s *Store, bucket int64, key string) rollup {
	t.Helper()
	var r rollup
	err := s.DB().R.QueryRow(`SELECT requests, errors, prompt_tokens, completion_tokens, cost FROM usage_rollups
WHERE bucket=? AND api_key_id=?`, bucket, key).Scan(&r.requests, &r.errors, &r.prompt, &r.completion, &r.cost)
	if err != nil {
		t.Fatalf("rollup %d/%s: %v", bucket, key, err)
	}
	return r
}

func TestRecordUsageUpdatesRollup(t *testing.T) {
	s := newTestStore(t)
	h := 10 * HourMS
	s.RecordUsage(ev(h+1, "k1", "ok", 100, 10))
	s.RecordUsage(ev(h+500, "k1", "error", 5, 0))
	s.RecordUsage(ev(h+HourMS, "k1", "ok", 1, 1)) // next hour
	s.Writer().Close()

	got := readRollup(t, s, h, "k1")
	if got != (rollup{2, 1, 105, 10, 1.0}) {
		t.Fatalf("hour 10: %+v", got)
	}
	if got := readRollup(t, s, h+HourMS, "k1"); got.requests != 1 {
		t.Fatalf("hour 11: %+v", got)
	}
	var n int
	s.DB().R.QueryRow("SELECT count(*) FROM usage_events").Scan(&n)
	if n != 3 {
		t.Fatalf("events=%d", n)
	}
}

func TestImportAndRebuildRollups(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	h := 20 * HourMS
	if err := s.ImportUsage(ctx, []UsageEvent{ev(h, "k1", "ok", 10, 1), ev(h+5, "k1", "ok", 20, 2), ev(h, "k2", "ok", 1, 1)}); err != nil {
		t.Fatal(err)
	}
	var n int
	s.DB().R.QueryRow("SELECT count(*) FROM usage_rollups").Scan(&n)
	if n != 0 {
		t.Fatal("import must not write rollups")
	}
	if err := s.RebuildRollups(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readRollup(t, s, h, "k1"); got != (rollup{2, 0, 30, 3, 1.0}) {
		t.Fatalf("rebuilt: %+v", got)
	}
}

func TestSumKeyTokens(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	s.RecordUsage(ev(1*HourMS, "k1", "ok", 100, 10))
	s.RecordUsage(ev(5*HourMS, "k1", "ok", 7, 3))
	s.RecordUsage(ev(5*HourMS, "k2", "ok", 1000, 0))
	s.Writer().Close()
	for _, tc := range []struct {
		since int64
		want  int64
	}{{0, 120}, {2 * HourMS, 10}, {5*HourMS + 10, 10}, {6 * HourMS, 0}} {
		got, err := s.SumKeyTokens(ctx, "k1", tc.since)
		if err != nil || got != tc.want {
			t.Errorf("since=%d got=%d want=%d err=%v", tc.since, got, tc.want, err)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test ./internal/store/ -run 'Usage|Rollup|SumKey'`
Expected: FAIL, `undefined: UsageEvent`.

- [ ] **Step 3: Implement**

`go/internal/store/usage.go`:

```go
package store

import (
	"context"
	"database/sql"
)

const HourMS int64 = 3_600_000

type UsageEvent struct {
	TS                                                                        int64
	Provider, Model, ConnectionID, APIKeyID, Endpoint, Status                 string
	PromptTokens, CompletionTokens, CachedTokens, CacheWriteTokens, ReasoningTokens int64
	Cost                                                                      float64
	LatencyMS                                                                 int64
}

const insertEventSQL = `INSERT INTO usage_events(ts, provider, model, connection_id, api_key_id, endpoint, status,
 prompt_tokens, completion_tokens, cached_tokens, cache_write_tokens, reasoning_tokens, cost, latency_ms)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`

func insertEvent(tx *sql.Tx, e UsageEvent) error {
	_, err := tx.Exec(insertEventSQL, e.TS, e.Provider, e.Model, e.ConnectionID, e.APIKeyID, e.Endpoint, e.Status,
		e.PromptTokens, e.CompletionTokens, e.CachedTokens, e.CacheWriteTokens, e.ReasoningTokens, e.Cost, e.LatencyMS)
	return err
}

func upsertRollup(tx *sql.Tx, e UsageEvent) error {
	errs := 0
	if e.Status != "ok" {
		errs = 1
	}
	_, err := tx.Exec(`INSERT INTO usage_rollups(bucket, provider, model, connection_id, api_key_id, requests, errors,
 prompt_tokens, completion_tokens, cached_tokens, cache_write_tokens, reasoning_tokens, cost)
VALUES(?,?,?,?,?,1,?,?,?,?,?,?,?)
ON CONFLICT(bucket, provider, model, connection_id, api_key_id) DO UPDATE SET
 requests=requests+1, errors=errors+excluded.errors,
 prompt_tokens=prompt_tokens+excluded.prompt_tokens, completion_tokens=completion_tokens+excluded.completion_tokens,
 cached_tokens=cached_tokens+excluded.cached_tokens, cache_write_tokens=cache_write_tokens+excluded.cache_write_tokens,
 reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens, cost=cost+excluded.cost`,
		e.TS/HourMS*HourMS, e.Provider, e.Model, e.ConnectionID, e.APIKeyID, errs,
		e.PromptTokens, e.CompletionTokens, e.CachedTokens, e.CacheWriteTokens, e.ReasoningTokens, e.Cost)
	return err
}

// RecordUsage queues the event and its rollup update; it never blocks.
func (s *Store) RecordUsage(e UsageEvent) bool {
	return s.w.Enqueue(func(tx *sql.Tx) error {
		if err := insertEvent(tx, e); err != nil {
			return err
		}
		return upsertRollup(tx, e)
	})
}

func (s *Store) ImportUsage(ctx context.Context, events []UsageEvent) error {
	return s.w.Do(ctx, func(tx *sql.Tx) error {
		for _, e := range events {
			if err := insertEvent(tx, e); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Store) RebuildRollups(ctx context.Context) error {
	return s.w.Do(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`DELETE FROM usage_rollups`); err != nil {
			return err
		}
		_, err := tx.Exec(`INSERT INTO usage_rollups(bucket, provider, model, connection_id, api_key_id, requests, errors,
 prompt_tokens, completion_tokens, cached_tokens, cache_write_tokens, reasoning_tokens, cost)
SELECT (ts / ?) * ?, provider, model, connection_id, api_key_id, count(*), sum(status != 'ok'),
 sum(prompt_tokens), sum(completion_tokens), sum(cached_tokens), sum(cache_write_tokens), sum(reasoning_tokens), sum(cost)
FROM usage_events GROUP BY 1, 2, 3, 4, 5`, HourMS, HourMS)
		return err
	})
}

// SumKeyTokens returns prompt+completion tokens for apiKeyID since the start of
// the hour containing since. Reads rollups, so it survives event retention.
func (s *Store) SumKeyTokens(ctx context.Context, apiKeyID string, since int64) (int64, error) {
	var total int64
	err := s.db.R.QueryRowContext(ctx, `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) FROM usage_rollups
WHERE api_key_id=? AND bucket >= ?`, apiKeyID, since/HourMS*HourMS).Scan(&total)
	return total, err
}
```

- [ ] **Step 4: Run tests**

Run: `cd /home/jamnas/Code/Coding/9router/go && gofmt -w internal/store && go test -race ./internal/store/`
Expected: `ok  ninerouter/internal/store`

- [ ] **Step 5: Commit**

```bash
cd /home/jamnas/Code/Coding/9router && git add go/internal/store && git commit -m "feat(go): usage events with hourly rollups and key token sums

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Maintenance — retention, TTL prune, vacuum, backup, quick_check

**Files:**
- Create: `go/internal/store/maintenance.go`
- Test: `go/internal/store/maintenance_test.go`

**Interfaces:**
- Consumes: `Writer.Exclusive`, `Writer.Do`.
- Produces:
  - `store.MaintenanceOptions{UsageRetention time.Duration; RequestDetailsKeep int}` (defaults 90 days, 1000).
  - `(*Store).RunMaintenance(ctx, now time.Time, opt MaintenanceOptions) error` — deletes `usage_events` older than retention (rollups kept), expired `thought_signatures`, expired `model_locks`, `request_details` beyond newest N; then `PRAGMA incremental_vacuum(2000)`.
  - `(*Store).Backup(ctx, dir string, now time.Time, keep int) (string, error)` — `VACUUM INTO dir/9router-YYYYMMDD-HHMMSS.sqlite` (UTC), file `0600`, dir `0700`, keeps newest `keep` files matching `9router-*.sqlite`.
  - `(*Store).QuickCheck(ctx) error` — `PRAGMA quick_check` must return `ok`.

- [ ] **Step 1: Write the failing test**

`go/internal/store/maintenance_test.go`:

```go
package store

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRunMaintenancePrunes(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.UnixMilli(100 * 24 * HourMS)
	old := now.Add(-91 * 24 * time.Hour).UnixMilli()
	recent := now.Add(-time.Hour).UnixMilli()

	s.ImportUsage(ctx, []UsageEvent{ev(old, "k", "ok", 1, 1), ev(recent, "k", "ok", 1, 1)})
	s.RebuildRollups(ctx)
	s.PutThoughtSignatures(ctx,
		ThoughtSignature{Key: "dead", Value: json.RawMessage(`1`), ExpiresAt: now.UnixMilli() - 1},
		ThoughtSignature{Key: "live", Value: json.RawMessage(`1`), ExpiresAt: now.UnixMilli() + 1})
	s.PutConnections(ctx, sampleConn("a"))
	s.SetModelLock("a", "m", now.UnixMilli()-1)
	for i := range 5 {
		s.PutRequestDetails(ctx, RequestDetail{ID: string(rune('a' + i)), TS: int64(i), Data: json.RawMessage(`{}`)})
	}
	s.Writer().Do(ctx, func(*sql.Tx) error { return nil }) // flush the async lock write

	if err := s.RunMaintenance(ctx, now, MaintenanceOptions{UsageRetention: 90 * 24 * time.Hour, RequestDetailsKeep: 2}); err != nil {
		t.Fatal(err)
	}
	count := func(q string) (n int) { s.DB().R.QueryRow(q).Scan(&n); return }
	if n := count("SELECT count(*) FROM usage_events"); n != 1 {
		t.Errorf("events=%d want 1", n)
	}
	if n := count("SELECT count(*) FROM usage_rollups"); n != 2 {
		t.Errorf("rollups=%d want 2 (kept forever)", n)
	}
	if n := count("SELECT count(*) FROM thought_signatures"); n != 1 {
		t.Errorf("signatures=%d want 1", n)
	}
	if n := count("SELECT count(*) FROM model_locks"); n != 0 {
		t.Errorf("locks=%d want 0", n)
	}
	if n := count("SELECT count(*) FROM request_details"); n != 2 {
		t.Errorf("details=%d want 2", n)
	}
	if n := count("SELECT count(*) FROM request_details WHERE id IN ('d','e')"); n != 2 {
		t.Errorf("kept wrong details")
	}
}

func TestBackupAndRotate(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	s.SetMeta(ctx, "x", "1")
	dir := filepath.Join(t.TempDir(), "backups")
	base := time.Date(2026, 9, 24, 1, 2, 3, 0, time.UTC)
	var last string
	for i := range 3 {
		p, err := s.Backup(ctx, dir, base.Add(time.Duration(i)*time.Hour), 2)
		if err != nil {
			t.Fatal(err)
		}
		last = p
	}
	if filepath.Base(last) != "9router-20260924-030203.sqlite" {
		t.Fatalf("name: %s", last)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "9router-*.sqlite"))
	if len(files) != 2 {
		t.Fatalf("rotation kept %d files", len(files))
	}
	st, _ := os.Stat(last)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("perm %v", st.Mode().Perm())
	}
	b, err := Open(last)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	var v string
	if b.R.QueryRow("SELECT value FROM meta WHERE key='x'").Scan(&v); v != "1" {
		t.Fatal("backup missing data")
	}
}

func TestQuickCheck(t *testing.T) {
	if err := newTestStore(t).QuickCheck(context.Background()); err != nil {
		t.Fatal(err)
	}
}
```

Add `"database/sql"` to that file's imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test ./internal/store/ -run 'Maintenance|Backup|QuickCheck'`
Expected: FAIL, `undefined: MaintenanceOptions`.

- [ ] **Step 3: Implement**

`go/internal/store/maintenance.go`:

```go
package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

type MaintenanceOptions struct {
	UsageRetention     time.Duration // default 90 days
	RequestDetailsKeep int           // default 1000
}

// RunMaintenance prunes expired/old rows then reclaims free pages in small steps.
func (s *Store) RunMaintenance(ctx context.Context, now time.Time, opt MaintenanceOptions) error {
	if opt.UsageRetention <= 0 {
		opt.UsageRetention = 90 * 24 * time.Hour
	}
	if opt.RequestDetailsKeep <= 0 {
		opt.RequestDetailsKeep = 1000
	}
	nowMS := now.UnixMilli()
	err := s.w.Do(ctx, func(tx *sql.Tx) error {
		stmts := []struct {
			q    string
			args []any
		}{
			{`DELETE FROM usage_events WHERE ts < ?`, []any{now.Add(-opt.UsageRetention).UnixMilli()}},
			{`DELETE FROM thought_signatures WHERE expires_at <= ?`, []any{nowMS}},
			{`DELETE FROM model_locks WHERE until <= ?`, []any{nowMS}},
			{`DELETE FROM request_details WHERE id NOT IN (SELECT id FROM request_details ORDER BY ts DESC LIMIT ?)`, []any{opt.RequestDetailsKeep}},
		}
		for _, st := range stmts {
			if _, err := tx.Exec(st.q, st.args...); err != nil {
				return fmt.Errorf("%s: %w", st.q, err)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	return s.w.Exclusive(ctx, func(ctx context.Context, c *sql.Conn) error {
		_, err := c.ExecContext(ctx, `PRAGMA incremental_vacuum(2000)`)
		return err
	})
}

// Backup writes a consistent snapshot with VACUUM INTO and keeps the newest keep files.
func (s *Store) Backup(ctx context.Context, dir string, now time.Time, keep int) (string, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "9router-"+now.UTC().Format("20060102-150405")+".sqlite")
	err := s.w.Exclusive(ctx, func(ctx context.Context, c *sql.Conn) error {
		_, err := c.ExecContext(ctx, `VACUUM INTO ?`, path)
		return err
	})
	if err != nil {
		return "", err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return "", err
	}
	files, err := filepath.Glob(filepath.Join(dir, "9router-*.sqlite"))
	if err != nil {
		return "", err
	}
	sort.Strings(files) // timestamped names sort chronologically
	for len(files) > keep {
		os.Remove(files[0])
		files = files[1:]
	}
	return path, nil
}

func (s *Store) QuickCheck(ctx context.Context) error {
	var res string
	if err := s.db.R.QueryRowContext(ctx, `PRAGMA quick_check`).Scan(&res); err != nil {
		return err
	}
	if res != "ok" {
		return fmt.Errorf("quick_check: %s", res)
	}
	return nil
}
```

- [ ] **Step 4: Run tests**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test -race ./internal/store/`
Expected: `ok  ninerouter/internal/store`. If `VACUUM INTO ?` rejects a bound parameter, build the statement with the path quoted: `"VACUUM INTO '" + strings.ReplaceAll(path, "'", "''") + "'"`.

- [ ] **Step 5: Commit**

```bash
cd /home/jamnas/Code/Coding/9router && git add go/internal/store && git commit -m "feat(go): store maintenance — retention, TTL prune, vacuum, backup, quick_check

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Account runtime + selection

**Files:**
- Create: `go/internal/account/account.go`
- Test: `go/internal/account/account_test.go`

Semantics copied from `src/sse/services/auth.js` `getProviderCredentials` and `open-sse/services/accountFallback.js`:
- Lock check (`isModelLockActive`): `v := locks[model or "__all"]; if v == 0 { v = locks["__all"] }; active = v > now`. Note: an *expired* per-model lock hides an active `__all` lock — this matches JS (`connection[key] || connection[ALL]` with a truthy expired string) and is kept for parity.
- Available = not excluded and not locked.
- None available: if any account is locked for the model, return `AllLocked` with `RetryAt` = the earliest *active lock of any model* across those locked accounts (JS `getEarliestModelLockUntil`), and `Sample` = the first locked account; else nothing.
- `Preferred` id wins if available.
- Strategy `round-robin`: current = most recently used (never-used sort last; two never-used compare by priority key). If `current.lastUsed > 0 && current.consecutive < stickyLimit` → reuse, `consecutive++`. Otherwise pick least recently used (never-used first, ordered by priority key) and set `consecutive = 1`. Both set `lastUsed = now` and persist via `Persister.TouchConnection`.
- Any other strategy (`fill-first`, default): first available in priority order, no state change.
- Priority key = `priority`, with `0` treated as `999` (JS `a.priority || 999`).

**Interfaces:**
- Consumes: `store.Connection`, `store.AllModels` (Task 5).
- Produces:
  - `account.Account{Conn store.Connection}` + unexported runtime; `account.New(c store.Connection, prev *Account) *Account` (reuses `prev`'s runtime when non-nil so state survives snapshot rebuilds; otherwise seeds runtime from `c.LastUsedAt`/`c.ConsecutiveUseCount`).
  - `(*Account).PriorityKey() int`.
  - `account.Persister interface{ TouchConnection(id string, lastUsedAt int64, consecutive int) bool; SetModelLock(connID, model string, until int64) bool; ClearModelLocks(connID string) bool }` (satisfied by `*store.Store`).
  - `account.NewSelector(p Persister) *Selector`.
  - `account.PickOptions{Model string; Exclude map[string]bool; Preferred string; Strategy string; StickyLimit int; Now int64}`.
  - `account.PickResult{Account *Account; AllLocked bool; RetryAt int64; Sample *Account}`.
  - `(*Selector).Pick(provider string, accounts []*Account, opt PickOptions) PickResult` — `accounts` must already be in priority order.
  - `(*Selector).LockModel(provider string, a *Account, model string, until int64)`; `(*Selector).ClearLocks(provider string, a *Account)`; `(*Selector).SeedLocks(a *Account, locks map[string]int64)` (startup only, before serving).
  - `account.SortByPriority(accs []*Account)` — stable sort by `PriorityKey()`.

- [ ] **Step 1: Write the failing test**

`go/internal/account/account_test.go`:

```go
package account

import (
	"sync"
	"testing"

	"ninerouter/internal/store"
)

type fakePersister struct {
	mu      sync.Mutex
	touches map[string][2]int64
	locks   map[string]map[string]int64
}

func newFake() *fakePersister {
	return &fakePersister{touches: map[string][2]int64{}, locks: map[string]map[string]int64{}}
}
func (f *fakePersister) TouchConnection(id string, at int64, n int) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.touches[id] = [2]int64{at, int64(n)}
	return true
}
func (f *fakePersister) SetModelLock(id, model string, until int64) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.locks[id] == nil {
		f.locks[id] = map[string]int64{}
	}
	f.locks[id][model] = until
	return true
}
func (f *fakePersister) ClearModelLocks(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.locks, id)
	return true
}

func accs(specs ...store.Connection) []*Account {
	out := make([]*Account, len(specs))
	for i, c := range specs {
		out[i] = New(c, nil)
	}
	SortByPriority(out)
	return out
}

func conn(id string, prio int) store.Connection {
	return store.Connection{ID: id, Provider: "p", Priority: prio, IsActive: true}
}

func ids(r PickResult) string {
	if r.Account == nil {
		return ""
	}
	return r.Account.Conn.ID
}

func TestSortByPriorityTreatsZeroAs999(t *testing.T) {
	a := accs(conn("zero", 0), conn("two", 2), conn("one", 1))
	if a[0].Conn.ID != "one" || a[1].Conn.ID != "two" || a[2].Conn.ID != "zero" {
		t.Fatalf("order: %s %s %s", a[0].Conn.ID, a[1].Conn.ID, a[2].Conn.ID)
	}
}

func TestFillFirst(t *testing.T) {
	s := NewSelector(newFake())
	a := accs(conn("a", 1), conn("b", 2))
	r := s.Pick("p", a, PickOptions{Strategy: "fill-first", Now: 100})
	if ids(r) != "a" {
		t.Fatalf("got %s", ids(r))
	}
	r = s.Pick("p", a, PickOptions{Strategy: "fill-first", Exclude: map[string]bool{"a": true}, Now: 100})
	if ids(r) != "b" {
		t.Fatalf("exclude: got %s", ids(r))
	}
}

func TestPreferredWins(t *testing.T) {
	s := NewSelector(newFake())
	a := accs(conn("a", 1), conn("b", 2))
	if r := s.Pick("p", a, PickOptions{Preferred: "b", Now: 1}); ids(r) != "b" {
		t.Fatalf("got %s", ids(r))
	}
	if r := s.Pick("p", a, PickOptions{Preferred: "missing", Now: 1}); ids(r) != "a" {
		t.Fatalf("fallback: got %s", ids(r))
	}
}

func TestRoundRobinSticky(t *testing.T) {
	f := newFake()
	s := NewSelector(f)
	a := accs(conn("a", 1), conn("b", 2), conn("c", 3))
	opt := PickOptions{Strategy: "round-robin", StickyLimit: 2}
	var got []string
	for now := int64(1); now <= 7; now++ {
		opt.Now = now
		got = append(got, ids(s.Pick("p", a, opt)))
	}
	// never-used first in priority order; each account sticks for 2 picks
	want := []string{"a", "a", "b", "b", "c", "c", "a"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("sequence %v want %v", got, want)
		}
	}
	if f.touches["a"] != [2]int64{7, 1} {
		t.Fatalf("persisted touch: %v", f.touches["a"])
	}
}

func TestRoundRobinSeedsFromStoredState(t *testing.T) {
	s := NewSelector(newFake())
	b := conn("b", 2)
	b.LastUsedAt, b.ConsecutiveUseCount = 50, 1
	a := accs(conn("a", 1), b)
	r := s.Pick("p", a, PickOptions{Strategy: "round-robin", StickyLimit: 3, Now: 60})
	if ids(r) != "b" {
		t.Fatalf("should stick to most recent stored account, got %s", ids(r))
	}
}

func TestModelLocks(t *testing.T) {
	f := newFake()
	s := NewSelector(f)
	a := accs(conn("a", 1), conn("b", 2))
	s.LockModel("p", a[0], "m1", 500)
	if r := s.Pick("p", a, PickOptions{Model: "m1", Now: 100}); ids(r) != "b" {
		t.Fatalf("locked account picked: %s", ids(r))
	}
	if r := s.Pick("p", a, PickOptions{Model: "m2", Now: 100}); ids(r) != "a" {
		t.Fatalf("lock must be per model: %s", ids(r))
	}
	if f.locks["a"]["m1"] != 500 {
		t.Fatal("lock not persisted")
	}
	s.ClearLocks("p", a[0])
	if r := s.Pick("p", a, PickOptions{Model: "m1", Now: 100}); ids(r) != "a" {
		t.Fatalf("cleared lock still active: %s", ids(r))
	}
}

func TestAllModelsLockAndParityQuirk(t *testing.T) {
	s := NewSelector(newFake())
	a := accs(conn("a", 1))
	s.LockModel("p", a[0], store.AllModels, 500)
	if r := s.Pick("p", a, PickOptions{Model: "m1", Now: 100}); !r.AllLocked {
		t.Fatal("__all lock must block every model")
	}
	// JS quirk kept for parity: an expired per-model lock masks an active __all lock.
	s.LockModel("p", a[0], "m1", 50)
	if r := s.Pick("p", a, PickOptions{Model: "m1", Now: 100}); ids(r) != "a" {
		t.Fatalf("parity quirk broken: %+v", r)
	}
}

func TestAllLockedReportsEarliestActiveLock(t *testing.T) {
	s := NewSelector(newFake())
	a := accs(conn("a", 1), conn("b", 2))
	s.LockModel("p", a[0], "m1", 900)
	s.LockModel("p", a[0], "other", 300) // earliest active lock on a locked account
	s.LockModel("p", a[1], "m1", 400)
	r := s.Pick("p", a, PickOptions{Model: "m1", Now: 100})
	if !r.AllLocked || r.RetryAt != 300 || r.Sample != a[0] || r.Account != nil {
		t.Fatalf("result: %+v", r)
	}
	r = s.Pick("p", a, PickOptions{Model: "m1", Exclude: map[string]bool{"a": true, "b": true}, Now: 100})
	if !r.AllLocked {
		t.Fatal("excluded+locked still reports AllLocked (JS checks locks over all connections)")
	}
	if r := s.Pick("p", accs(conn("x", 1)), PickOptions{Exclude: map[string]bool{"x": true}, Now: 1}); r.Account != nil || r.AllLocked {
		t.Fatalf("excluded only: %+v", r)
	}
}

func TestRuntimeSurvivesRebuild(t *testing.T) {
	s := NewSelector(newFake())
	a := accs(conn("a", 1))
	s.LockModel("p", a[0], "m1", 500)
	rebuilt := New(conn("a", 1), a[0])
	if r := s.Pick("p", []*Account{rebuilt}, PickOptions{Model: "m1", Now: 100}); !r.AllLocked {
		t.Fatal("lock lost across rebuild")
	}
}

func TestConcurrentPicks(t *testing.T) {
	s := NewSelector(newFake())
	a := accs(conn("a", 1), conn("b", 2), conn("c", 3))
	var wg sync.WaitGroup
	for i := range 64 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.Pick("p", a, PickOptions{Strategy: "round-robin", StickyLimit: 1, Now: int64(i)})
			s.LockModel("p", a[i%3], "m", int64(i))
		}()
	}
	wg.Wait()
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test ./internal/account/`
Expected: FAIL, `undefined: New`.

- [ ] **Step 3: Implement**

`go/internal/account/account.go`:

```go
// Package account holds per-account runtime state and the account selection
// algorithm (parity with src/sse/services/auth.js getProviderCredentials).
package account

import (
	"slices"
	"sync"

	"ninerouter/internal/store"
)

type runtime struct {
	lastUsed    int64
	consecutive int
	locks       map[string]int64 // model (or store.AllModels) → until, unix ms
}

// Account pairs an immutable connection row with runtime state that survives
// snapshot rebuilds. Runtime fields are guarded by the Selector's per-provider mutex.
type Account struct {
	Conn store.Connection
	rt   *runtime
}

func New(c store.Connection, prev *Account) *Account {
	if prev != nil {
		return &Account{Conn: c, rt: prev.rt}
	}
	return &Account{Conn: c, rt: &runtime{
		lastUsed:    c.LastUsedAt,
		consecutive: c.ConsecutiveUseCount,
		locks:       map[string]int64{},
	}}
}

// PriorityKey mirrors JS `a.priority || 999`.
func (a *Account) PriorityKey() int {
	if a.Conn.Priority == 0 {
		return 999
	}
	return a.Conn.Priority
}

func SortByPriority(accs []*Account) {
	slices.SortStableFunc(accs, func(x, y *Account) int { return x.PriorityKey() - y.PriorityKey() })
}

type Persister interface {
	TouchConnection(id string, lastUsedAt int64, consecutive int) bool
	SetModelLock(connID, model string, until int64) bool
	ClearModelLocks(connID string) bool
}

type Selector struct {
	p   Persister
	mus sync.Map // provider → *sync.Mutex
}

func NewSelector(p Persister) *Selector { return &Selector{p: p} }

func (s *Selector) mu(provider string) *sync.Mutex {
	m, _ := s.mus.LoadOrStore(provider, &sync.Mutex{})
	return m.(*sync.Mutex)
}

type PickOptions struct {
	Model       string
	Exclude     map[string]bool
	Preferred   string
	Strategy    string // "round-robin" or anything else (= fill-first)
	StickyLimit int
	Now         int64
}

type PickResult struct {
	Account   *Account
	AllLocked bool
	RetryAt   int64    // earliest active lock, when AllLocked
	Sample    *Account // first locked account (for lastError/errorCode), when AllLocked
}

func lockActive(a *Account, model string, now int64) bool {
	key := model
	if key == "" {
		key = store.AllModels
	}
	v := a.rt.locks[key]
	if v == 0 {
		v = a.rt.locks[store.AllModels]
	}
	return v > now
}

func earliestLock(a *Account, now int64) int64 {
	var best int64
	for _, until := range a.rt.locks {
		if until > now && (best == 0 || until < best) {
			best = until
		}
	}
	return best
}

// Pick selects an account. accounts must be in priority order (SortByPriority).
// ponytail: O(n) scan under a per-provider mutex; n≈1000 costs a few µs. Switch to
// a heap keyed on lastUsed if providers grow to 10k+ accounts.
func (s *Selector) Pick(provider string, accounts []*Account, opt PickOptions) PickResult {
	m := s.mu(provider)
	m.Lock()
	defer m.Unlock()

	var avail []*Account
	for _, a := range accounts {
		if !opt.Exclude[a.Conn.ID] && !lockActive(a, opt.Model, opt.Now) {
			avail = append(avail, a)
		}
	}
	if len(avail) == 0 {
		var res PickResult
		for _, a := range accounts {
			if !lockActive(a, opt.Model, opt.Now) {
				continue
			}
			if res.Sample == nil {
				res.Sample = a
			}
			if t := earliestLock(a, opt.Now); t != 0 && (res.RetryAt == 0 || t < res.RetryAt) {
				res.RetryAt = t
			}
		}
		res.AllLocked = res.RetryAt != 0
		if !res.AllLocked {
			res.Sample = nil
		}
		return res
	}

	if opt.Preferred != "" {
		for _, a := range avail {
			if a.Conn.ID == opt.Preferred {
				return PickResult{Account: a}
			}
		}
	}
	if opt.Strategy != "round-robin" {
		return PickResult{Account: avail[0]}
	}

	var current *Account
	for _, a := range avail {
		if current == nil || moreRecent(a, current) {
			current = a
		}
	}
	chosen := current
	if current.rt.lastUsed > 0 && current.rt.consecutive < opt.StickyLimit {
		current.rt.consecutive++
	} else {
		chosen = nil
		for _, a := range avail {
			if chosen == nil || lessRecent(a, chosen) {
				chosen = a
			}
		}
		chosen.rt.consecutive = 1
	}
	chosen.rt.lastUsed = opt.Now
	s.p.TouchConnection(chosen.Conn.ID, chosen.rt.lastUsed, chosen.rt.consecutive)
	return PickResult{Account: chosen}
}

// moreRecent: a sorts before b in JS "most recent first" order (unused last).
func moreRecent(a, b *Account) bool {
	la, lb := a.rt.lastUsed, b.rt.lastUsed
	switch {
	case la == 0 && lb == 0:
		return a.PriorityKey() < b.PriorityKey()
	case la == 0:
		return false
	case lb == 0:
		return true
	}
	return la > lb
}

// lessRecent: a sorts before b in JS "oldest first" order (unused first).
func lessRecent(a, b *Account) bool {
	la, lb := a.rt.lastUsed, b.rt.lastUsed
	switch {
	case la == 0 && lb == 0:
		return a.PriorityKey() < b.PriorityKey()
	case la == 0:
		return true
	case lb == 0:
		return false
	}
	return la < lb
}

func (s *Selector) LockModel(provider string, a *Account, model string, until int64) {
	m := s.mu(provider)
	m.Lock()
	a.rt.locks[model] = until
	m.Unlock()
	s.p.SetModelLock(a.Conn.ID, model, until)
}

func (s *Selector) ClearLocks(provider string, a *Account) {
	m := s.mu(provider)
	m.Lock()
	clear(a.rt.locks)
	m.Unlock()
	s.p.ClearModelLocks(a.Conn.ID)
}

// SeedLocks loads persisted locks at startup, before the account is shared.
func (s *Selector) SeedLocks(a *Account, locks map[string]int64) {
	for k, v := range locks {
		a.rt.locks[k] = v
	}
}
```

Note: `moreRecent`/`lessRecent` use strict comparisons and the loops keep the first minimum, so ties resolve to the earlier (higher-priority) account — the same result JS's stable `sort` gives.

- [ ] **Step 4: Run tests**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test -race ./internal/account/`
Expected: `ok  ninerouter/internal/account`

- [ ] **Step 5: Commit**

```bash
cd /home/jamnas/Code/Coding/9router && git add go/internal/account && git commit -m "feat(go): account runtime and selection with JS parity (fill-first, sticky round-robin, model locks)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Settings + state snapshot

**Files:**
- Create: `go/internal/state/settings.go`
- Create: `go/internal/state/state.go`
- Test: `go/internal/state/state_test.go`

**Interfaces:**
- Consumes: `store.Store` loaders (Tasks 5–6), `account.New`, `account.SortByPriority`, `account.Selector.SeedLocks` (Task 9).
- Produces:
  - `state.ProviderStrategy{FallbackStrategy string; StickyRoundRobinLimit int}` (JSON `fallbackStrategy`, `stickyRoundRobinLimit`).
  - `state.Settings{RequireAPIKey bool; FallbackStrategy string; StickyRoundRobinLimit int; ProviderStrategies map[string]ProviderStrategy; Raw json.RawMessage}`; `state.ParseSettings(raw json.RawMessage) (Settings, error)`; `(Settings).StrategyFor(provider string) (strategy string, sticky int)`.
  - Defaults (from `src/lib/db/repos/settingsRepo.js` / `auth.js`): `requireApiKey=true`, `fallbackStrategy="fill-first"`, `stickyRoundRobinLimit=3`.
  - `state.Snapshot{Settings Settings; APIKeys map[string]*store.APIKey /* by plaintext key */; Combos map[string]*store.Combo /* by name */; Accounts map[string]*account.Account; ByProvider map[string][]*account.Account /* active only, priority order */; Nodes []store.ProviderNode; ProxyPools []store.ProxyPool}`.
  - `state.Holder`; `(*Holder).Load() *Snapshot`; `(*Holder).Store(s *Snapshot)`.
  - `state.Build(ctx, st *store.Store, sel *account.Selector, prev *Snapshot, now int64) (*Snapshot, error)` — when `prev == nil` it seeds model locks from the DB.

- [ ] **Step 1: Write the failing test**

`go/internal/state/state_test.go`:

```go
package state

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"ninerouter/internal/account"
	"ninerouter/internal/secret"
	"ninerouter/internal/store"
)

func newStore(t *testing.T) *store.Store {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "s.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	box, _ := secret.New(bytes.Repeat([]byte{3}, secret.KeySize))
	w := store.NewWriter(db.W, store.WriterOptions{FlushEvery: 5 * time.Millisecond})
	t.Cleanup(func() { w.Close(); db.Close() })
	return store.New(db, box, w)
}

func TestParseSettingsDefaults(t *testing.T) {
	s, err := ParseSettings(nil)
	if err != nil || !s.RequireAPIKey || s.FallbackStrategy != "fill-first" || s.StickyRoundRobinLimit != 3 {
		t.Fatalf("defaults: %+v %v", s, err)
	}
	s, _ = ParseSettings(json.RawMessage(`{"requireApiKey":false,"fallbackStrategy":"round-robin",
		"providerStrategies":{"zed":{"fallbackStrategy":"fill-first","stickyRoundRobinLimit":7},"x":{}}}`))
	if s.RequireAPIKey || s.FallbackStrategy != "round-robin" {
		t.Fatalf("parsed: %+v", s)
	}
	if st, n := s.StrategyFor("zed"); st != "fill-first" || n != 7 {
		t.Fatalf("zed override: %s %d", st, n)
	}
	if st, n := s.StrategyFor("x"); st != "round-robin" || n != 3 {
		t.Fatalf("empty override falls back: %s %d", st, n)
	}
	if _, err := ParseSettings(json.RawMessage(`{`)); err == nil {
		t.Fatal("expected error for bad json")
	}
}

func TestBuildSnapshot(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	mk := func(id, provider string, prio int, active bool) store.Connection {
		return store.Connection{ID: id, Provider: provider, Priority: prio, IsActive: active, CreatedAt: 1, UpdatedAt: 1}
	}
	st.PutConnections(ctx, mk("z2", "zed", 2, true), mk("z1", "zed", 1, true), mk("zoff", "zed", 0, false), mk("g1", "grok-cli", 0, true))
	st.PutAPIKeys(ctx, store.APIKey{ID: "k1", Key: "sk-1", IsActive: true, CreatedAt: 1})
	st.PutCombos(ctx, store.Combo{ID: "c1", Name: "glm", Models: []string{"a/b"}, CreatedAt: 1, UpdatedAt: 1})
	st.PutSettings(ctx, json.RawMessage(`{"requireApiKey":false}`))
	st.SetModelLock("z1", "m", 5000)
	st.Writer().Do(ctx, func(*sql.Tx) error { return nil })

	sel := account.NewSelector(st)
	snap, err := Build(ctx, st, sel, nil, 100)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Settings.RequireAPIKey {
		t.Fatal("settings not loaded")
	}
	if snap.APIKeys["sk-1"] == nil || snap.Combos["glm"] == nil {
		t.Fatal("keys/combos not indexed")
	}
	zed := snap.ByProvider["zed"]
	if len(zed) != 2 || zed[0].Conn.ID != "z1" || zed[1].Conn.ID != "z2" {
		t.Fatalf("zed order/active filter wrong: %v", zed)
	}
	if snap.Accounts["zoff"] == nil {
		t.Fatal("inactive accounts must stay addressable by id")
	}
	if r := sel.Pick("zed", zed, account.PickOptions{Model: "m", Now: 100}); r.Account.Conn.ID != "z2" {
		t.Fatal("persisted lock not seeded")
	}

	var h Holder
	h.Store(snap)
	next, err := Build(ctx, st, sel, h.Load(), 100)
	if err != nil {
		t.Fatal(err)
	}
	if r := sel.Pick("zed", next.ByProvider["zed"], account.PickOptions{Model: "m", Now: 100}); r.Account.Conn.ID != "z2" {
		t.Fatal("runtime lost on rebuild")
	}
	h.Store(next)
	if h.Load() != next {
		t.Fatal("holder swap")
	}
}
```

Add `"database/sql"` to the test imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test ./internal/state/`
Expected: FAIL, `undefined: ParseSettings`.

- [ ] **Step 3: Implement**

`go/internal/state/settings.go`:

```go
package state

import "encoding/json"

type ProviderStrategy struct {
	FallbackStrategy      string `json:"fallbackStrategy"`
	StickyRoundRobinLimit int    `json:"stickyRoundRobinLimit"`
}

// Settings decodes the hot fields of the settings document; Raw keeps the whole
// document for the admin API.
type Settings struct {
	RequireAPIKey         bool
	FallbackStrategy      string
	StickyRoundRobinLimit int
	ProviderStrategies    map[string]ProviderStrategy
	Raw                   json.RawMessage
}

func ParseSettings(raw json.RawMessage) (Settings, error) {
	var doc struct {
		RequireAPIKey         *bool                       `json:"requireApiKey"`
		FallbackStrategy      string                      `json:"fallbackStrategy"`
		StickyRoundRobinLimit int                         `json:"stickyRoundRobinLimit"`
		ProviderStrategies    map[string]ProviderStrategy `json:"providerStrategies"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &doc); err != nil {
			return Settings{}, err
		}
	}
	s := Settings{
		RequireAPIKey:         true,
		FallbackStrategy:      "fill-first",
		StickyRoundRobinLimit: 3,
		ProviderStrategies:    doc.ProviderStrategies,
		Raw:                   raw,
	}
	if doc.RequireAPIKey != nil {
		s.RequireAPIKey = *doc.RequireAPIKey
	}
	if doc.FallbackStrategy != "" {
		s.FallbackStrategy = doc.FallbackStrategy
	}
	if doc.StickyRoundRobinLimit > 0 {
		s.StickyRoundRobinLimit = doc.StickyRoundRobinLimit
	}
	return s, nil
}

// StrategyFor applies the per-provider override (JS: override.x || settings.x).
func (s Settings) StrategyFor(provider string) (string, int) {
	strategy, sticky := s.FallbackStrategy, s.StickyRoundRobinLimit
	if o, ok := s.ProviderStrategies[provider]; ok {
		if o.FallbackStrategy != "" {
			strategy = o.FallbackStrategy
		}
		if o.StickyRoundRobinLimit > 0 {
			sticky = o.StickyRoundRobinLimit
		}
	}
	return strategy, sticky
}
```

`go/internal/state/state.go`:

```go
// Package state publishes an immutable snapshot of routing state. Readers call
// Holder.Load (one atomic pointer load); writers Build a new snapshot and Store it.
package state

import (
	"context"
	"sync/atomic"

	"ninerouter/internal/account"
	"ninerouter/internal/store"
)

type Snapshot struct {
	Settings   Settings
	APIKeys    map[string]*store.APIKey // by plaintext key
	Combos     map[string]*store.Combo  // by name
	Accounts   map[string]*account.Account
	ByProvider map[string][]*account.Account // active only, priority order
	Nodes      []store.ProviderNode
	ProxyPools []store.ProxyPool
}

type Holder struct{ p atomic.Pointer[Snapshot] }

func (h *Holder) Load() *Snapshot   { return h.p.Load() }
func (h *Holder) Store(s *Snapshot) { h.p.Store(s) }

// Build reads everything from the store. Account runtime state is carried over
// from prev; when prev is nil, persisted model locks are seeded.
func Build(ctx context.Context, st *store.Store, sel *account.Selector, prev *Snapshot, now int64) (*Snapshot, error) {
	rawSettings, err := st.LoadSettings(ctx)
	if err != nil {
		return nil, err
	}
	settings, err := ParseSettings(rawSettings)
	if err != nil {
		return nil, err
	}
	conns, err := st.LoadConnections(ctx)
	if err != nil {
		return nil, err
	}
	keys, err := st.LoadAPIKeys(ctx)
	if err != nil {
		return nil, err
	}
	combos, err := st.LoadCombos(ctx)
	if err != nil {
		return nil, err
	}
	nodes, err := st.LoadProviderNodes(ctx)
	if err != nil {
		return nil, err
	}
	pools, err := st.LoadProxyPools(ctx)
	if err != nil {
		return nil, err
	}
	var locks map[string]map[string]int64
	if prev == nil {
		if locks, err = st.LoadModelLocks(ctx, now); err != nil {
			return nil, err
		}
	}

	s := &Snapshot{
		Settings:   settings,
		APIKeys:    make(map[string]*store.APIKey, len(keys)),
		Combos:     make(map[string]*store.Combo, len(combos)),
		Accounts:   make(map[string]*account.Account, len(conns)),
		ByProvider: map[string][]*account.Account{},
		Nodes:      nodes,
		ProxyPools: pools,
	}
	for i := range keys {
		s.APIKeys[keys[i].Key] = &keys[i]
	}
	for i := range combos {
		s.Combos[combos[i].Name] = &combos[i]
	}
	for _, c := range conns {
		var old *account.Account
		if prev != nil {
			old = prev.Accounts[c.ID]
		}
		a := account.New(c, old)
		if old == nil && locks[c.ID] != nil {
			sel.SeedLocks(a, locks[c.ID])
		}
		s.Accounts[c.ID] = a
		if c.IsActive {
			s.ByProvider[c.Provider] = append(s.ByProvider[c.Provider], a)
		}
	}
	for _, list := range s.ByProvider {
		account.SortByPriority(list)
	}
	return s, nil
}
```

- [ ] **Step 4: Run tests**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test -race ./internal/state/ ./internal/account/`
Expected: both `ok`.

- [ ] **Step 5: Commit**

```bash
cd /home/jamnas/Code/Coding/9router && git add go/internal/state && git commit -m "feat(go): settings decoding and atomic state snapshot

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Provider registry export + embed

**Files:**
- Create: `go/gen/export-registry.mjs`
- Create (generated): `go/internal/provider/data/registry.json`
- Create: `go/internal/provider/registry.go`
- Test: `go/internal/provider/registry_test.go`

**Interfaces:**
- Produces:
  - `provider.Entry{ID string; Alias string; Aliases []string; Category string; AuthType string; Priority int; Transport json.RawMessage; OAuth json.RawMessage; Media json.RawMessage; Models json.RawMessage; Raw json.RawMessage}` — `Raw` is the full entry JSON.
  - `provider.Load() (*Registry, error)` (from `go:embed`).
  - `(*Registry).Get(id string) (*Entry, bool)`; `(*Registry).ResolveID(token string) string` — JS `resolveProviderId`: returns the id of the entry whose `id` or `alias` equals `token`, else `token` unchanged; `(*Registry).All() []*Entry` (registry order).

- [ ] **Step 1: Write the export script**

`go/gen/export-registry.mjs`:

```js
// Exports the JS provider registry to JSON for the Go binary (go:embed).
// Run from repo root: node --no-warnings go/gen/export-registry.mjs
// Registry entries are pure data (verified: no functions), so JSON is lossless.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { default: REGISTRY } = await import(pathToFileURL(`${root}/open-sse/providers/registry/index.js`).href);

const assertData = (v, path) => {
  if (typeof v === "function") throw new Error(`function at ${path}; registry must be pure data`);
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) assertData(x, `${path}.${k}`);
};
REGISTRY.forEach((e) => assertData(e, e.id));

const out = resolve(root, "go/internal/provider/data/registry.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(REGISTRY, null, 1) + "\n");
console.log(`wrote ${REGISTRY.length} entries → ${out}`);
```

- [ ] **Step 2: Run it**

Run: `cd /home/jamnas/Code/Coding/9router && node --no-warnings go/gen/export-registry.mjs`
Expected: `wrote 121 entries → …/go/internal/provider/data/registry.json`

- [ ] **Step 3: Write the failing test**

`go/internal/provider/registry_test.go`:

```go
package provider

import "testing"

func TestLoadRegistry(t *testing.T) {
	r, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if n := len(r.All()); n < 100 {
		t.Fatalf("only %d entries", n)
	}
	zed, ok := r.Get("zed")
	if !ok || zed.Alias != "zd" || zed.Category != "oauth" || len(zed.Transport) == 0 || len(zed.Raw) == 0 {
		t.Fatalf("zed: %+v", zed)
	}
	for _, e := range r.All() {
		if e.ID == "" || e.Category == "" {
			t.Errorf("entry missing id/category: %s", e.Raw)
		}
	}
}

func TestResolveID(t *testing.T) {
	r, _ := Load()
	for in, want := range map[string]string{"zd": "zed", "zed": "zed", "unknown-x": "unknown-x"} {
		if got := r.ResolveID(in); got != want {
			t.Errorf("ResolveID(%q)=%q want %q", in, got, want)
		}
	}
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test ./internal/provider/`
Expected: FAIL, `undefined: Load`.

- [ ] **Step 5: Implement**

`go/internal/provider/registry.go`:

```go
// Package provider exposes the provider registry exported from the JS source
// (go/gen/export-registry.mjs) and embedded at build time.
package provider

import (
	_ "embed"
	"encoding/json"
	"fmt"
)

//go:embed data/registry.json
var registryJSON []byte

type Entry struct {
	ID        string          `json:"id"`
	Alias     string          `json:"alias"`
	Aliases   []string        `json:"aliases"`
	Category  string          `json:"category"`
	AuthType  string          `json:"authType"`
	Priority  int             `json:"priority"`
	Transport json.RawMessage `json:"transport"`
	OAuth     json.RawMessage `json:"oauth"`
	Media     json.RawMessage `json:"media"`
	Models    json.RawMessage `json:"models"`
	Raw       json.RawMessage `json:"-"`
}

type Registry struct {
	list    []*Entry
	byID    map[string]*Entry
	byToken map[string]*Entry // id + alias (JS getProviderByAlias)
}

func Load() (*Registry, error) {
	var raws []json.RawMessage
	if err := json.Unmarshal(registryJSON, &raws); err != nil {
		return nil, fmt.Errorf("registry: %w", err)
	}
	r := &Registry{byID: map[string]*Entry{}, byToken: map[string]*Entry{}}
	for _, raw := range raws {
		e := &Entry{Raw: raw}
		if err := json.Unmarshal(raw, e); err != nil {
			return nil, fmt.Errorf("registry entry: %w", err)
		}
		if _, dup := r.byID[e.ID]; dup {
			return nil, fmt.Errorf("registry: duplicate id %q", e.ID)
		}
		r.list = append(r.list, e)
		r.byID[e.ID] = e
	}
	// ids win over aliases, and the first entry wins among equal aliases (JS loop order)
	for _, e := range r.list {
		r.byToken[e.ID] = e
	}
	for _, e := range r.list {
		if _, taken := r.byToken[e.Alias]; e.Alias != "" && !taken {
			r.byToken[e.Alias] = e
		}
	}
	return r, nil
}

func (r *Registry) All() []*Entry { return r.list }

func (r *Registry) Get(id string) (*Entry, bool) {
	e, ok := r.byID[id]
	return e, ok
}

// ResolveID mirrors JS resolveProviderId: alias or id → id, unknown → unchanged.
func (r *Registry) ResolveID(token string) string {
	if e, ok := r.byToken[token]; ok {
		return e.ID
	}
	return token
}
```

Note on `ResolveID` precedence: JS `getProviderByAlias` returns the first entry in registry order where `alias === token || id === token`. If an alias of an earlier entry equals the id of a later entry, JS returns the earlier entry, while this code prefers the id. Step 6 checks the real registry for such a collision.

- [ ] **Step 6: Run tests + collision check**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test -race ./internal/provider/`
Expected: `ok  ninerouter/internal/provider`

Run: `cd /home/jamnas/Code/Coding/9router && node -e 'const r=require("./go/internal/provider/data/registry.json");const ids=new Set(r.map(e=>e.id));const c=r.filter(e=>e.alias&&e.alias!==e.id&&ids.has(e.alias));console.log(c.length?c.map(e=>e.id+"->"+e.alias):"no alias/id collisions")'`
Expected: `no alias/id collisions`. If collisions are printed, change `Load` to build `byToken` in a single registry-order pass that sets both `e.ID` and `e.Alias` only when not already taken, then rerun the tests.

- [ ] **Step 7: Commit**

```bash
cd /home/jamnas/Code/Coding/9router && git add go/gen go/internal/provider && git commit -m "feat(go): export provider registry to JSON and embed it

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Importer from the old `data.sqlite`

**Files:**
- Create: `go/internal/migrate/migrate.go`
- Create: `go/internal/migrate/oldschema_test.sql` (old DDL fixture, copied from `sqlite3 data.sqlite .schema`)
- Test: `go/internal/migrate/migrate_test.go`
- Create: `go/cmd/9router-migrate/main.go`

Mapping (old → new):
- `providerConnections`: columns map 1:1; `data` JSON → `Secret` (`accessToken`, `refreshToken`, `idToken`, `apiKey`, `providerSpecificData`), status columns (`testStatus`, `errorCode`, `backoffLevel`, `lastError`, `lastErrorAt`, `rateLimitedUntil`, `expiresAt`, `lastUsedAt`, `consecutiveUseCount`), `modelLock_<model>` → `model_locks` (`modelLock___all` → `store.AllModels`; expired locks skipped); every other key → `Extra`. ISO timestamps → unix ms.
- `apiKeys` → `api_keys` (`limits` JSON kept as-is).
- `combos`, `providerNodes`, `proxyPools`, `settings` → same shape.
- `kv` scope `gemini_thought_signatures` → `thought_signatures` with `expires_at = now + 24h`; other scopes → `kv`.
- `usageHistory` → `usage_events` in chunks of 5000. `apiKey` (raw key string) → matching `api_keys.id`, else `"deleted:" + HashKey(key)[:12]`; empty stays empty. `tokens` JSON supplies `cached_tokens`, `cache_creation_input_tokens` (→ cache write), `reasoning_tokens`. Then `RebuildRollups`.
- `requestDetails` → `request_details`.
- `_meta.totalRequestsLifetime` → `meta`.
- `usageDaily` is not imported: rollups are rebuilt from `usageHistory`, which covers the same range.
- The old DB is opened with `mode=ro`. The importer refuses to run if the target already has connections.

**Interfaces:**
- Consumes: all `store.Put*`, `store.ImportUsage`, `store.RebuildRollups`, `store.HashKey`, `store.AllModels`.
- Produces: `migrate.Report{Connections, ModelLocks, APIKeys, Combos, Nodes, Pools, KV, Signatures, UsageEvents, RequestDetails int}`; `migrate.Run(ctx, oldPath string, st *store.Store, now time.Time) (Report, error)`; `migrate.ErrTargetNotEmpty`.

- [ ] **Step 1: Write the old-schema fixture**

`go/internal/migrate/oldschema_test.sql`:

```sql
CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
CREATE TABLE providerConnections (id TEXT PRIMARY KEY, provider TEXT NOT NULL, authType TEXT NOT NULL, name TEXT, email TEXT, priority INTEGER, isActive INTEGER DEFAULT 1, data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE TABLE providerNodes (id TEXT PRIMARY KEY, type TEXT, name TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE TABLE proxyPools (id TEXT PRIMARY KEY, isActive INTEGER DEFAULT 1, testStatus TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL, limits TEXT);
CREATE TABLE combos (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, kind TEXT, models TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE TABLE kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope, key));
CREATE TABLE usageHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, provider TEXT, model TEXT, connectionId TEXT, apiKey TEXT, endpoint TEXT, promptTokens INTEGER DEFAULT 0, completionTokens INTEGER DEFAULT 0, cost REAL DEFAULT 0, status TEXT, tokens TEXT, meta TEXT);
CREATE TABLE usageDaily (dateKey TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE requestDetails (id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, provider TEXT, model TEXT, connectionId TEXT, status TEXT, data TEXT NOT NULL);

INSERT INTO _meta VALUES ('schemaVersion','1'), ('totalRequestsLifetime','3');
INSERT INTO settings VALUES (1, '{"requireApiKey":true,"fallbackStrategy":"round-robin"}');
INSERT INTO providerConnections VALUES
 ('c1','zed','oauth','Zed A','a@x.io',1,1,
  '{"accessToken":"at-1","refreshToken":"rt-1","expiresAt":"2026-10-01T00:00:00.000Z","testStatus":"active","errorCode":null,"backoffLevel":2,"lastUsedAt":"2026-09-24T01:00:00.000Z","consecutiveUseCount":2,"providerSpecificData":{"userId":"u1"},"defaultModel":"m1","modelLock_m1":"2026-12-01T00:00:00.000Z","modelLock_old":"2020-01-01T00:00:00.000Z","modelLock___all":"2026-12-02T00:00:00.000Z"}',
  '2026-08-18T12:00:00.000Z','2026-09-24T01:00:00.000Z'),
 ('c2','grok-cli','apikey',NULL,NULL,NULL,0,'{"apiKey":"xai-1","testStatus":"error","lastError":"boom","lastErrorAt":"2026-09-20T00:00:00.000Z"}',
  '2026-08-19T00:00:00.000Z','2026-08-19T00:00:00.000Z');
INSERT INTO providerNodes VALUES ('n1','openai-compatible','gutsai','{"prefix":"gutsai","baseUrl":"https://api.gutsai.id/v1"}','2026-08-18T00:00:00.000Z','2026-08-18T00:00:00.000Z');
INSERT INTO apiKeys VALUES ('k1','sk-live-1','main','m1',1,'2026-08-18T00:00:00.000Z','{"rpm":10}');
INSERT INTO combos VALUES ('cb1','glm',NULL,'["gutsai/glm-5.3","cbai/glm-5.3"]','2026-08-18T00:00:00.000Z','2026-08-18T00:00:00.000Z');
INSERT INTO kv VALUES ('customModels','x|m|llm','{"id":"m"}'), ('gemini_thought_signatures','call_1','{"signature":"s"}');
INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES
 ('2026-09-24T01:10:00.000Z','zed','m1','c1','sk-live-1','/v1/chat/completions',100,10,0.5,'ok','{"cached_tokens":80,"cache_creation_input_tokens":5}','{}'),
 ('2026-09-24T01:20:00.000Z','zed','m1','c1','sk-gone','/v1/chat/completions',1,1,0,'ok','{}','{}'),
 ('2026-09-24T01:30:00.000Z','zed','m1','c1',NULL,'/v1/messages',2,2,0,'error',NULL,NULL);
INSERT INTO requestDetails VALUES ('r1','2026-09-24T01:10:00.000Z','zed','m1','c1','ok','{"a":1}');
```

- [ ] **Step 2: Write the failing test**

`go/internal/migrate/migrate_test.go`:

```go
package migrate

import (
	"bytes"
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"ninerouter/internal/secret"
	"ninerouter/internal/store"
)

//go:embed oldschema_test.sql
var oldSchema string

func oldDB(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "data.sqlite")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(oldSchema); err != nil {
		t.Fatal(err)
	}
	return path
}

func newStore(t *testing.T) *store.Store {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "9router.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	box, _ := secret.New(bytes.Repeat([]byte{4}, secret.KeySize))
	w := store.NewWriter(db.W, store.WriterOptions{FlushEvery: 5 * time.Millisecond})
	t.Cleanup(func() { w.Close(); db.Close() })
	return store.New(db, box, w)
}

func ms(s string) int64 {
	t, _ := time.Parse(time.RFC3339Nano, s)
	return t.UnixMilli()
}

func TestRunImportsEverything(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 24, 2, 0, 0, 0, time.UTC)
	rep, err := Run(ctx, oldDB(t), st, now)
	if err != nil {
		t.Fatal(err)
	}
	want := Report{Connections: 2, ModelLocks: 2, APIKeys: 1, Combos: 1, Nodes: 1, Pools: 0, KV: 1, Signatures: 1, UsageEvents: 3, RequestDetails: 1}
	if rep != want {
		t.Fatalf("report %+v want %+v", rep, want)
	}

	conns, _ := st.LoadConnections(ctx)
	c1 := conns[0]
	if c1.ID != "c1" || c1.Secret.AccessToken != "at-1" || c1.Secret.RefreshToken != "rt-1" ||
		c1.Secret.ProviderSpecificData["userId"] != "u1" {
		t.Fatalf("c1 secrets: %+v", c1)
	}
	if c1.TestStatus != "active" || c1.BackoffLevel != 2 || c1.ConsecutiveUseCount != 2 ||
		c1.LastUsedAt != ms("2026-09-24T01:00:00.000Z") || c1.ExpiresAt != ms("2026-10-01T00:00:00.000Z") ||
		c1.CreatedAt != ms("2026-08-18T12:00:00.000Z") {
		t.Fatalf("c1 status: %+v", c1)
	}
	if c1.Extra["defaultModel"] != "m1" || len(c1.Extra) != 1 {
		t.Fatalf("c1 extra: %v", c1.Extra)
	}
	c2 := conns[1]
	if c2.IsActive || c2.Secret.APIKey != "xai-1" || c2.LastError != "boom" || c2.Name != "" {
		t.Fatalf("c2: %+v", c2)
	}

	locks, _ := st.LoadModelLocks(ctx, now.UnixMilli())
	if locks["c1"]["m1"] != ms("2026-12-01T00:00:00.000Z") || locks["c1"][store.AllModels] != ms("2026-12-02T00:00:00.000Z") {
		t.Fatalf("locks: %v", locks)
	}

	keys, _ := st.LoadAPIKeys(ctx)
	if keys[0].Key != "sk-live-1" || string(keys[0].Limits) != `{"rpm":10}` {
		t.Fatalf("keys: %+v", keys)
	}

	sig, ok, _ := st.GetThoughtSignature(ctx, "call_1", now.UnixMilli())
	if !ok || string(sig) != `{"signature":"s"}` {
		t.Fatal("signature not imported")
	}
	if _, ok, _ := st.GetThoughtSignature(ctx, "call_1", now.Add(25*time.Hour).UnixMilli()); ok {
		t.Fatal("signature must expire after 24h")
	}

	var keyIDs []string
	rows, _ := st.DB().R.Query("SELECT api_key_id FROM usage_events ORDER BY ts")
	for rows.Next() {
		var s string
		rows.Scan(&s)
		keyIDs = append(keyIDs, s)
	}
	rows.Close()
	if keyIDs[0] != "k1" || keyIDs[1] != "deleted:"+store.HashKey("sk-gone")[:12] || keyIDs[2] != "" {
		t.Fatalf("api key mapping: %v", keyIDs)
	}
	var cached, write int64
	st.DB().R.QueryRow("SELECT cached_tokens, cache_write_tokens FROM usage_events WHERE api_key_id='k1'").Scan(&cached, &write)
	if cached != 80 || write != 5 {
		t.Fatalf("token details: %d %d", cached, write)
	}
	if sum, _ := st.SumKeyTokens(ctx, "k1", 0); sum != 110 {
		t.Fatalf("rollups not rebuilt: %d", sum)
	}
	if v, _, _ := st.GetMeta(ctx, "totalRequestsLifetime"); v != "3" {
		t.Fatalf("meta: %q", v)
	}
}

func TestRunRefusesNonEmptyTarget(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	old := oldDB(t)
	if _, err := Run(ctx, old, st, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := Run(ctx, old, st, time.Now()); !errors.Is(err, ErrTargetNotEmpty) {
		t.Fatalf("err=%v", err)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test ./internal/migrate/`
Expected: FAIL, `undefined: Run`.

- [ ] **Step 4: Implement**

`go/internal/migrate/migrate.go`:

```go
// Package migrate imports the Node-era data.sqlite into the new store. The old
// database is opened read-only and never modified.
package migrate

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"ninerouter/internal/store"
)

var ErrTargetNotEmpty = errors.New("migrate: target database already has connections")

const (
	lockPrefix   = "modelLock_"
	sigScope     = "gemini_thought_signatures"
	sigTTL       = 24 * time.Hour
	usageChunk   = 5000
)

type Report struct {
	Connections, ModelLocks, APIKeys, Combos, Nodes, Pools, KV, Signatures, UsageEvents, RequestDetails int
}

func Run(ctx context.Context, oldPath string, st *store.Store, now time.Time) (Report, error) {
	var rep Report
	var n int
	if err := st.DB().R.QueryRowContext(ctx, `SELECT count(*) FROM connections`).Scan(&n); err != nil {
		return rep, err
	}
	if n > 0 {
		return rep, ErrTargetNotEmpty
	}
	old, err := sql.Open("sqlite", "file:"+oldPath+"?mode=ro")
	if err != nil {
		return rep, err
	}
	defer old.Close()

	steps := []func(context.Context, *sql.DB, *store.Store, time.Time, *Report) error{
		importSettings, importConnections, importKeysCombosNodesPools, importKV,
		importUsage, importRequestDetails, importMeta,
	}
	for _, step := range steps {
		if err := step(ctx, old, st, now, &rep); err != nil {
			return rep, err
		}
	}
	return rep, nil
}

// ---- helpers ----

func toMS(v any) int64 {
	switch x := v.(type) {
	case string:
		if x == "" {
			return 0
		}
		if t, err := time.Parse(time.RFC3339Nano, x); err == nil {
			return t.UnixMilli()
		}
	case float64:
		return int64(x)
	}
	return 0
}

func str(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return fmt.Sprint(x)
	}
	return ""
}

func num(v any) int {
	if f, ok := v.(float64); ok {
		return int(f)
	}
	return 0
}

func nullStr(s sql.NullString) string { return s.String }

// ---- steps ----

func importSettings(ctx context.Context, old *sql.DB, st *store.Store, _ time.Time, _ *Report) error {
	var data string
	err := old.QueryRowContext(ctx, `SELECT data FROM settings WHERE id=1`).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("settings: %w", err)
	}
	return st.PutSettings(ctx, json.RawMessage(data))
}

var secretKeys = map[string]bool{"accessToken": true, "refreshToken": true, "idToken": true, "apiKey": true, "providerSpecificData": true}
var statusKeys = map[string]bool{"testStatus": true, "errorCode": true, "backoffLevel": true, "lastError": true,
	"lastErrorAt": true, "rateLimitedUntil": true, "expiresAt": true, "lastUsedAt": true, "consecutiveUseCount": true}

func importConnections(ctx context.Context, old *sql.DB, st *store.Store, now time.Time, rep *Report) error {
	rows, err := old.QueryContext(ctx, `SELECT id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt FROM providerConnections`)
	if err != nil {
		return fmt.Errorf("connections: %w", err)
	}
	defer rows.Close()
	var conns []store.Connection
	locks := map[string]map[string]int64{}
	for rows.Next() {
		var c store.Connection
		var name, email sql.NullString
		var prio sql.NullInt64
		var active sql.NullInt64
		var data, created, updated string
		if err := rows.Scan(&c.ID, &c.Provider, &c.AuthType, &name, &email, &prio, &active, &data, &created, &updated); err != nil {
			return err
		}
		c.Name, c.Email, c.Priority = nullStr(name), nullStr(email), int(prio.Int64)
		c.IsActive = !active.Valid || active.Int64 == 1
		c.CreatedAt, c.UpdatedAt = toMS(created), toMS(updated)

		var d map[string]any
		if err := json.Unmarshal([]byte(data), &d); err != nil {
			return fmt.Errorf("connection %s data: %w", c.ID, err)
		}
		c.Secret = store.Credentials{AccessToken: str(d["accessToken"]), RefreshToken: str(d["refreshToken"]),
			IDToken: str(d["idToken"]), APIKey: str(d["apiKey"])}
		if psd, ok := d["providerSpecificData"].(map[string]any); ok {
			c.Secret.ProviderSpecificData = psd
		}
		c.TestStatus, c.ErrorCode, c.LastError = str(d["testStatus"]), str(d["errorCode"]), str(d["lastError"])
		c.BackoffLevel, c.ConsecutiveUseCount = num(d["backoffLevel"]), num(d["consecutiveUseCount"])
		c.LastErrorAt, c.RateLimitedUntil = toMS(d["lastErrorAt"]), toMS(d["rateLimitedUntil"])
		c.ExpiresAt, c.LastUsedAt = toMS(d["expiresAt"]), toMS(d["lastUsedAt"])

		c.Extra = map[string]any{}
		for k, v := range d {
			switch {
			case secretKeys[k] || statusKeys[k]:
			case strings.HasPrefix(k, lockPrefix):
				model := strings.TrimPrefix(k, lockPrefix)
				if model == "__all" {
					model = store.AllModels
				}
				if until := toMS(v); until > now.UnixMilli() {
					if locks[c.ID] == nil {
						locks[c.ID] = map[string]int64{}
					}
					locks[c.ID][model] = until
				}
			case v != nil:
				c.Extra[k] = v
			}
		}
		conns = append(conns, c)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if err := st.PutConnections(ctx, conns...); err != nil {
		return err
	}
	rep.Connections = len(conns)
	for id, m := range locks {
		for model, until := range m {
			st.SetModelLock(id, model, until)
			rep.ModelLocks++
		}
	}
	return st.Writer().Do(ctx, func(*sql.Tx) error { return nil }) // flush queued locks
}

func importKeysCombosNodesPools(ctx context.Context, old *sql.DB, st *store.Store, _ time.Time, rep *Report) error {
	// api keys
	rows, err := old.QueryContext(ctx, `SELECT id, key, name, machineId, isActive, createdAt, limits FROM apiKeys`)
	if err != nil {
		return fmt.Errorf("apiKeys: %w", err)
	}
	var keys []store.APIKey
	for rows.Next() {
		var k store.APIKey
		var name, machine, limits sql.NullString
		var active sql.NullInt64
		var created string
		if err := rows.Scan(&k.ID, &k.Key, &name, &machine, &active, &created, &limits); err != nil {
			rows.Close()
			return err
		}
		k.Name, k.MachineID = nullStr(name), nullStr(machine)
		k.IsActive = !active.Valid || active.Int64 == 1
		k.CreatedAt = toMS(created)
		if limits.Valid && limits.String != "" && limits.String != "null" {
			k.Limits = json.RawMessage(limits.String)
		}
		keys = append(keys, k)
	}
	rows.Close()
	if err := st.PutAPIKeys(ctx, keys...); err != nil {
		return err
	}
	rep.APIKeys = len(keys)

	// combos
	rows, err = old.QueryContext(ctx, `SELECT id, name, kind, models, createdAt, updatedAt FROM combos`)
	if err != nil {
		return fmt.Errorf("combos: %w", err)
	}
	var combos []store.Combo
	for rows.Next() {
		var c store.Combo
		var kind sql.NullString
		var models, created, updated string
		if err := rows.Scan(&c.ID, &c.Name, &kind, &models, &created, &updated); err != nil {
			rows.Close()
			return err
		}
		c.Kind = nullStr(kind)
		if err := json.Unmarshal([]byte(models), &c.Models); err != nil {
			rows.Close()
			return fmt.Errorf("combo %s: %w", c.ID, err)
		}
		c.CreatedAt, c.UpdatedAt = toMS(created), toMS(updated)
		combos = append(combos, c)
	}
	rows.Close()
	if err := st.PutCombos(ctx, combos...); err != nil {
		return err
	}
	rep.Combos = len(combos)

	// provider nodes
	rows, err = old.QueryContext(ctx, `SELECT id, type, name, data, createdAt, updatedAt FROM providerNodes`)
	if err != nil {
		return fmt.Errorf("providerNodes: %w", err)
	}
	var nodes []store.ProviderNode
	for rows.Next() {
		var n store.ProviderNode
		var typ, name sql.NullString
		var data, created, updated string
		if err := rows.Scan(&n.ID, &typ, &name, &data, &created, &updated); err != nil {
			rows.Close()
			return err
		}
		n.Type, n.Name, n.Data = nullStr(typ), nullStr(name), json.RawMessage(data)
		n.CreatedAt, n.UpdatedAt = toMS(created), toMS(updated)
		nodes = append(nodes, n)
	}
	rows.Close()
	if err := st.PutProviderNodes(ctx, nodes...); err != nil {
		return err
	}
	rep.Nodes = len(nodes)

	// proxy pools
	rows, err = old.QueryContext(ctx, `SELECT id, isActive, testStatus, data, createdAt, updatedAt FROM proxyPools`)
	if err != nil {
		return fmt.Errorf("proxyPools: %w", err)
	}
	var pools []store.ProxyPool
	for rows.Next() {
		var p store.ProxyPool
		var active sql.NullInt64
		var status sql.NullString
		var data, created, updated string
		if err := rows.Scan(&p.ID, &active, &status, &data, &created, &updated); err != nil {
			rows.Close()
			return err
		}
		p.IsActive = !active.Valid || active.Int64 == 1
		p.TestStatus, p.Data = nullStr(status), json.RawMessage(data)
		p.CreatedAt, p.UpdatedAt = toMS(created), toMS(updated)
		pools = append(pools, p)
	}
	rows.Close()
	if err := st.PutProxyPools(ctx, pools...); err != nil {
		return err
	}
	rep.Pools = len(pools)
	return nil
}

func importKV(ctx context.Context, old *sql.DB, st *store.Store, now time.Time, rep *Report) error {
	rows, err := old.QueryContext(ctx, `SELECT scope, key, value FROM kv`)
	if err != nil {
		return fmt.Errorf("kv: %w", err)
	}
	defer rows.Close()
	var kv []store.KV
	var sigs []store.ThoughtSignature
	exp := now.Add(sigTTL).UnixMilli()
	for rows.Next() {
		var scope, key, value string
		if err := rows.Scan(&scope, &key, &value); err != nil {
			return err
		}
		if scope == sigScope {
			sigs = append(sigs, store.ThoughtSignature{Key: key, Value: json.RawMessage(value), ExpiresAt: exp})
		} else {
			kv = append(kv, store.KV{Scope: scope, Key: key, Value: json.RawMessage(value)})
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if err := st.PutKV(ctx, kv...); err != nil {
		return err
	}
	if err := st.PutThoughtSignatures(ctx, sigs...); err != nil {
		return err
	}
	rep.KV, rep.Signatures = len(kv), len(sigs)
	return nil
}

func importUsage(ctx context.Context, old *sql.DB, st *store.Store, _ time.Time, rep *Report) error {
	keyIDs := map[string]string{}
	keys, err := st.LoadAPIKeys(ctx)
	if err != nil {
		return err
	}
	for _, k := range keys {
		keyIDs[k.Key] = k.ID
	}
	mapKey := func(raw string) string {
		if raw == "" {
			return ""
		}
		if id, ok := keyIDs[raw]; ok {
			return id
		}
		return "deleted:" + store.HashKey(raw)[:12]
	}

	rows, err := old.QueryContext(ctx, `SELECT timestamp, provider, model, connectionId, apiKey, endpoint,
 promptTokens, completionTokens, cost, status, tokens FROM usageHistory ORDER BY id`)
	if err != nil {
		return fmt.Errorf("usageHistory: %w", err)
	}
	defer rows.Close()
	batch := make([]store.UsageEvent, 0, usageChunk)
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		if err := st.ImportUsage(ctx, batch); err != nil {
			return err
		}
		rep.UsageEvents += len(batch)
		batch = batch[:0]
		return nil
	}
	for rows.Next() {
		var ts string
		var provider, model, conn, key, endpoint, status, tokens sql.NullString
		var prompt, completion sql.NullInt64
		var cost sql.NullFloat64
		if err := rows.Scan(&ts, &provider, &model, &conn, &key, &endpoint, &prompt, &completion, &cost, &status, &tokens); err != nil {
			return err
		}
		e := store.UsageEvent{TS: toMS(ts), Provider: nullStr(provider), Model: nullStr(model),
			ConnectionID: nullStr(conn), APIKeyID: mapKey(nullStr(key)), Endpoint: nullStr(endpoint),
			Status: nullStr(status), PromptTokens: prompt.Int64, CompletionTokens: completion.Int64, Cost: cost.Float64}
		if tokens.Valid && tokens.String != "" {
			var tk map[string]any
			if json.Unmarshal([]byte(tokens.String), &tk) == nil {
				e.CachedTokens = int64(num(tk["cached_tokens"]))
				e.CacheWriteTokens = int64(num(tk["cache_creation_input_tokens"]))
				e.ReasoningTokens = int64(num(tk["reasoning_tokens"]))
			}
		}
		batch = append(batch, e)
		if len(batch) == usageChunk {
			if err := flush(); err != nil {
				return err
			}
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if err := flush(); err != nil {
		return err
	}
	return st.RebuildRollups(ctx)
}

func importRequestDetails(ctx context.Context, old *sql.DB, st *store.Store, _ time.Time, rep *Report) error {
	rows, err := old.QueryContext(ctx, `SELECT id, timestamp, provider, model, connectionId, status, data FROM requestDetails`)
	if err != nil {
		return fmt.Errorf("requestDetails: %w", err)
	}
	defer rows.Close()
	var items []store.RequestDetail
	for rows.Next() {
		var d store.RequestDetail
		var ts, data string
		var provider, model, conn, status sql.NullString
		if err := rows.Scan(&d.ID, &ts, &provider, &model, &conn, &status, &data); err != nil {
			return err
		}
		d.TS, d.Data = toMS(ts), json.RawMessage(data)
		d.Provider, d.Model, d.ConnectionID, d.Status = nullStr(provider), nullStr(model), nullStr(conn), nullStr(status)
		items = append(items, d)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rep.RequestDetails = len(items)
	return st.PutRequestDetails(ctx, items...)
}

func importMeta(ctx context.Context, old *sql.DB, st *store.Store, _ time.Time, _ *Report) error {
	var v string
	err := old.QueryRowContext(ctx, `SELECT value FROM _meta WHERE key='totalRequestsLifetime'`).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("_meta: %w", err)
	}
	return st.SetMeta(ctx, "totalRequestsLifetime", v)
}
```

`go/cmd/9router-migrate/main.go`:

```go
// Command 9router-migrate imports the Node-era data.sqlite into the Go store.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"ninerouter/internal/config"
	"ninerouter/internal/migrate"
	"ninerouter/internal/secret"
	"ninerouter/internal/store"
)

func main() {
	home, _ := os.UserHomeDir()
	cfg, err := config.Load(os.Getenv, home)
	if err != nil {
		log.Fatal(err)
	}
	from := flag.String("from", filepath.Join(cfg.DataDir, "db", "data.sqlite"), "old Node data.sqlite (opened read-only)")
	flag.Parse()

	key, err := secret.LoadOrCreateKey(cfg.KeyPath(), cfg.SecretKey)
	if err != nil {
		log.Fatal(err)
	}
	box, err := secret.New(key)
	if err != nil {
		log.Fatal(err)
	}
	db, err := store.Open(cfg.DBPath())
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	w := store.NewWriter(db.W, store.WriterOptions{})
	defer w.Close()

	start := time.Now()
	rep, err := migrate.Run(context.Background(), *from, store.New(db, box, w), start)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("imported %+v in %s → %s\n", rep, time.Since(start).Round(time.Millisecond), cfg.DBPath())
}
```

- [ ] **Step 5: Run tests**

Run: `cd /home/jamnas/Code/Coding/9router/go && gofmt -w internal/migrate && go vet ./... && go test -race ./internal/migrate/`
Expected: `ok  ninerouter/internal/migrate`

- [ ] **Step 6: Dry-run against a copy of the local DB**

```bash
sqlite3 ~/.9router/db/data.sqlite ".backup '/tmp/claude-1000/-home-jamnas-Code-Coding-9router/a206a541-8e19-497f-8166-80f115fd22c3/scratchpad/old.sqlite'"   # consistent copy incl. WAL; never cp a live DB
cd /home/jamnas/Code/Coding/9router/go && DATA_DIR=/tmp/claude-1000/-home-jamnas-Code-Coding-9router/a206a541-8e19-497f-8166-80f115fd22c3/scratchpad/gohome \
  go run ./cmd/9router-migrate -from /tmp/claude-1000/-home-jamnas-Code-Coding-9router/a206a541-8e19-497f-8166-80f115fd22c3/scratchpad/old.sqlite
```

Expected: `imported {Connections:51 … UsageEvents:32 …}` matching the local row counts (51 connections, 1 API key, 4 combos, 32 usage rows).

- [ ] **Step 7: Commit**

```bash
cd /home/jamnas/Code/Coding/9router && git add go/internal/migrate go/cmd/9router-migrate && git commit -m "feat(go): importer from Node data.sqlite (read-only source)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: HTTP server — client IP, API-key auth, health, main wiring

**Files:**
- Create: `go/internal/server/errors.go`
- Create: `go/internal/server/clientip.go`
- Create: `go/internal/server/apikey.go`
- Create: `go/internal/server/server.go`
- Test: `go/internal/server/server_test.go`
- Create: `go/cmd/9router/main.go`

Semantics:
- Client IP (from `custom-server.js`): peer = TCP remote host. If peer is loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) and `X-Real-IP` or first `X-Forwarded-For` entry is present, use it; otherwise use peer. Always delete incoming `X-Forwarded-For`, `X-9r-Real-Ip`, `X-9r-Via-Proxy`, `X-9r-Peer-Token`.
- API key extraction (from `auth.js extractApiKey`): `Authorization: Bearer <k>`, then `x-api-key`, then `x-goog-api-key`, then `?key=`.
- Auth (from `authorizeApiKey`): missing or unknown key → 401 only when `settings.requireApiKey`; otherwise continue with no key. Known key → continue with key in context (limits/paused checks belong to sub-project 2).
- Error body: `{"error":{"message":m,"type":t,"code":c}}` using the `ERROR_TYPES` table below, with header `Access-Control-Allow-Origin: *`.
- `Upgrade: h2c` requests are served as plain HTTP/1.1 (Node downgraded them for JBR clients; Go's server ignores the upgrade, which is the same observable behavior).

**Interfaces:**
- Consumes: `config.Config`, `state.Holder`, `store.APIKey`.
- Produces:
  - `server.WriteError(w http.ResponseWriter, status int, message string)`.
  - `server.ClientIP(next http.Handler) http.Handler`; `server.IPFrom(ctx) string`.
  - `server.ExtractAPIKey(r *http.Request) string`; `server.RequireAPIKey(h *state.Holder) func(http.Handler) http.Handler`; `server.KeyFrom(ctx) *store.APIKey`.
  - `server.New(cfg config.Config, h *state.Holder, mux *http.ServeMux) *http.Server` — wraps `mux` with ClientIP + body limit; registers `GET /api/health`.
  - `server.V1(h *state.Holder, next http.Handler) http.Handler` — auth wrapper later used for `/v1/*` routes.

- [ ] **Step 1: Write the failing test**

`go/internal/server/server_test.go`:

```go
package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ninerouter/internal/config"
	"ninerouter/internal/state"
	"ninerouter/internal/store"
)

func holder(requireKey bool) *state.Holder {
	var h state.Holder
	h.Store(&state.Snapshot{
		Settings: state.Settings{RequireAPIKey: requireKey},
		APIKeys:  map[string]*store.APIKey{"sk-good": {ID: "k1", Key: "sk-good", IsActive: true}},
	})
	return &h
}

func TestClientIP(t *testing.T) {
	var got string
	var sawXFF string
	h := ClientIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = IPFrom(r.Context())
		sawXFF = r.Header.Get("X-Forwarded-For") + r.Header.Get("X-9r-Real-Ip")
	}))
	cases := []struct{ remote, xff, xreal, want string }{
		{"203.0.113.5:1234", "1.2.3.4", "", "203.0.113.5"},       // public peer: headers ignored
		{"127.0.0.1:1234", "1.2.3.4, 10.0.0.1", "", "1.2.3.4"},   // loopback proxy: first XFF
		{"[::1]:1234", "", "5.6.7.8", "5.6.7.8"},                 // X-Real-IP wins
		{"[::ffff:127.0.0.1]:1", "9.9.9.9", "", "9.9.9.9"},
		{"127.0.0.1:1234", "", "", "127.0.0.1"},
	}
	for _, c := range cases {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = c.remote
		r.Header.Set("X-9r-Real-Ip", "spoof")
		if c.xff != "" {
			r.Header.Set("X-Forwarded-For", c.xff)
		}
		if c.xreal != "" {
			r.Header.Set("X-Real-IP", c.xreal)
		}
		h.ServeHTTP(httptest.NewRecorder(), r)
		if got != c.want {
			t.Errorf("%+v: got %s", c, got)
		}
		if sawXFF != "" {
			t.Errorf("%+v: forwarding headers not stripped", c)
		}
	}
}

func TestExtractAPIKey(t *testing.T) {
	mk := func(f func(*http.Request)) string {
		r := httptest.NewRequest("GET", "/v1/models", nil)
		f(r)
		return ExtractAPIKey(r)
	}
	if k := mk(func(r *http.Request) { r.Header.Set("Authorization", "Bearer a"); r.Header.Set("x-api-key", "b") }); k != "a" {
		t.Errorf("bearer first: %s", k)
	}
	if k := mk(func(r *http.Request) { r.Header.Set("x-api-key", "b"); r.Header.Set("x-goog-api-key", "c") }); k != "b" {
		t.Errorf("x-api-key: %s", k)
	}
	if k := mk(func(r *http.Request) { r.Header.Set("x-goog-api-key", "c") }); k != "c" {
		t.Errorf("goog: %s", k)
	}
	if k := mk(func(r *http.Request) { r.URL.RawQuery = "key=d" }); k != "d" {
		t.Errorf("query: %s", k)
	}
	if k := mk(func(r *http.Request) { r.Header.Set("Authorization", "Basic x") }); k != "" {
		t.Errorf("non-bearer: %s", k)
	}
}

func callV1(h *state.Holder, key string) (*httptest.ResponseRecorder, *store.APIKey) {
	var seen *store.APIKey
	handler := V1(h, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { seen = KeyFrom(r.Context()) }))
	r := httptest.NewRequest("POST", "/v1/chat/completions", nil)
	if key != "" {
		r.Header.Set("Authorization", "Bearer "+key)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, r)
	return rec, seen
}

func TestV1Auth(t *testing.T) {
	rec, _ := callV1(holder(true), "")
	assertError(t, rec, 401, "Missing API key")
	rec, _ = callV1(holder(true), "sk-bad")
	assertError(t, rec, 401, "Invalid API key")
	rec, key := callV1(holder(true), "sk-good")
	if rec.Code != 200 || key == nil || key.ID != "k1" {
		t.Fatalf("good key: %d %+v", rec.Code, key)
	}
	rec, key = callV1(holder(false), "sk-bad")
	if rec.Code != 200 || key != nil {
		t.Fatalf("requireApiKey=false must pass unknown keys: %d", rec.Code)
	}
}

func assertError(t *testing.T, rec *httptest.ResponseRecorder, status int, msg string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status %d want %d", rec.Code, status)
	}
	var body struct {
		Error struct{ Message, Type, Code string }
	}
	json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Error.Message != msg || body.Error.Type != "authentication_error" || body.Error.Code != "invalid_api_key" {
		t.Fatalf("body: %s", rec.Body)
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "*" || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("headers: %v", rec.Header())
	}
}

func TestWriteErrorTypes(t *testing.T) {
	for status, want := range map[int][2]string{
		429: {"rate_limit_error", "rate_limit_exceeded"},
		500: {"server_error", "internal_server_error"},
		599: {"server_error", "internal_server_error"},
		418: {"invalid_request_error", ""},
	} {
		rec := httptest.NewRecorder()
		WriteError(rec, status, "")
		var body struct{ Error struct{ Message, Type, Code string } }
		json.Unmarshal(rec.Body.Bytes(), &body)
		if body.Error.Type != want[0] || body.Error.Code != want[1] || body.Error.Message == "" {
			t.Errorf("%d: %s", status, rec.Body)
		}
	}
}

func TestServerHealthAndBodyLimit(t *testing.T) {
	cfg := config.Config{BodyLimitBytes: 8}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /echo", func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.ReadAll(r.Body); err != nil {
			WriteError(w, http.StatusRequestEntityTooLarge, "body too large")
		}
	})
	srv := New(cfg, holder(true), mux)
	ts := httptest.NewServer(srv.Handler)
	defer ts.Close()

	req, _ := http.NewRequest("GET", ts.URL+"/api/health", nil)
	req.Header.Set("Upgrade", "h2c")
	req.Header.Set("Connection", "Upgrade, HTTP2-Settings")
	res, err := http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("health (with h2c upgrade header): %v %v", res, err)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !strings.Contains(string(b), `"ok":true`) {
		t.Fatalf("health body: %s", b)
	}

	res, _ = http.Post(ts.URL+"/echo", "text/plain", strings.NewReader("0123456789"))
	if res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("body limit: %d", res.StatusCode)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/jamnas/Code/Coding/9router/go && go test ./internal/server/`
Expected: FAIL, `undefined: ClientIP`.

- [ ] **Step 3: Implement**

`go/internal/server/errors.go`:

```go
package server

import (
	"encoding/json"
	"net/http"
)

// errorTypes mirrors open-sse/config/errorConfig.js ERROR_TYPES.
var errorTypes = map[int][2]string{
	400: {"invalid_request_error", "bad_request"},
	401: {"authentication_error", "invalid_api_key"},
	402: {"billing_error", "payment_required"},
	403: {"permission_error", "insufficient_quota"},
	404: {"invalid_request_error", "model_not_found"},
	406: {"invalid_request_error", "model_not_supported"},
	429: {"rate_limit_error", "rate_limit_exceeded"},
	500: {"server_error", "internal_server_error"},
	502: {"server_error", "bad_gateway"},
	503: {"server_error", "service_unavailable"},
	504: {"server_error", "gateway_timeout"},
}

// WriteError writes the OpenAI-style error body used by open-sse/utils/error.js.
func WriteError(w http.ResponseWriter, status int, message string) {
	t, ok := errorTypes[status]
	if !ok {
		t = [2]string{"invalid_request_error", ""}
		if status >= 500 {
			t = [2]string{"server_error", "internal_server_error"}
		}
	}
	if message == "" {
		message = http.StatusText(status)
		if message == "" {
			message = "An error occurred"
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"message": message, "type": t[0], "code": t[1]},
	})
}
```

`go/internal/server/clientip.go`:

```go
package server

import (
	"context"
	"net"
	"net/http"
	"strings"
)

type ctxKey int

const (
	ipKey ctxKey = iota
	apiKeyKey
)

var loopback = map[string]bool{"127.0.0.1": true, "::1": true, "::ffff:127.0.0.1": true}

// ClientIP derives the client address from the TCP peer, trusting X-Real-IP /
// X-Forwarded-For only from a loopback reverse proxy (custom-server.js parity),
// and strips forwarding headers so handlers cannot be fooled by them.
func ClientIP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			peer = r.RemoteAddr
		}
		ip := peer
		if loopback[peer] {
			proxied := r.Header.Get("X-Real-IP")
			if proxied == "" {
				proxied, _, _ = strings.Cut(r.Header.Get("X-Forwarded-For"), ",")
				proxied = strings.TrimSpace(proxied)
			}
			if proxied != "" {
				ip = proxied
			}
		}
		for _, h := range []string{"X-Forwarded-For", "X-9r-Real-Ip", "X-9r-Via-Proxy", "X-9r-Peer-Token"} {
			r.Header.Del(h)
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ipKey, ip)))
	})
}

func IPFrom(ctx context.Context) string {
	ip, _ := ctx.Value(ipKey).(string)
	return ip
}
```

`go/internal/server/apikey.go`:

```go
package server

import (
	"context"
	"net/http"
	"strings"

	"ninerouter/internal/state"
	"ninerouter/internal/store"
)

// ExtractAPIKey mirrors src/sse/services/auth.js extractApiKey.
func ExtractAPIKey(r *http.Request) string {
	if k, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok {
		return k
	}
	if k := r.Header.Get("x-api-key"); k != "" {
		return k
	}
	if k := r.Header.Get("x-goog-api-key"); k != "" {
		return k
	}
	return r.URL.Query().Get("key")
}

// V1 authenticates a /v1 request against the current snapshot. Missing/unknown
// keys are refused only when settings.requireApiKey is on (authorizeApiKey parity).
func V1(h *state.Holder, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		snap := h.Load()
		raw := ExtractAPIKey(r)
		key := snap.APIKeys[raw]
		if raw == "" || key == nil {
			if snap.Settings.RequireAPIKey {
				msg := "Missing API key"
				if raw != "" {
					msg = "Invalid API key"
				}
				WriteError(w, http.StatusUnauthorized, msg)
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), apiKeyKey, key)))
	})
}

func KeyFrom(ctx context.Context) *store.APIKey {
	k, _ := ctx.Value(apiKeyKey).(*store.APIKey)
	return k
}
```

`go/internal/server/server.go`:

```go
// Package server hosts the HTTP listener and cross-cutting middleware.
package server

import (
	"net/http"
	"time"

	"ninerouter/internal/config"
	"ninerouter/internal/state"
)

// New registers /api/health on mux and wraps it with client-IP and body-limit
// middleware. No WriteTimeout: responses are long-lived SSE streams.
func New(cfg config.Config, h *state.Holder, mux *http.ServeMux) *http.Server {
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})
	limit := cfg.BodyLimitBytes
	var handler http.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if limit > 0 {
			r.Body = http.MaxBytesReader(w, r.Body, limit)
		}
		mux.ServeHTTP(w, r)
	})
	return &http.Server{
		Addr:              cfg.Addr(),
		Handler:           ClientIP(handler),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
}
```

`go/cmd/9router/main.go`:

```go
// Command 9router is the single-binary gateway, admin API and dashboard server.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime/debug"
	"syscall"
	"time"

	"ninerouter/internal/account"
	"ninerouter/internal/config"
	"ninerouter/internal/provider"
	"ninerouter/internal/secret"
	"ninerouter/internal/server"
	"ninerouter/internal/state"
	"ninerouter/internal/store"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	start := time.Now()
	home, _ := os.UserHomeDir()
	cfg, err := config.Load(os.Getenv, home)
	if err != nil {
		return err
	}
	debug.SetMemoryLimit(cfg.MemLimitMiB << 20)

	key, err := secret.LoadOrCreateKey(cfg.KeyPath(), cfg.SecretKey)
	if err != nil {
		return err
	}
	box, err := secret.New(key)
	if err != nil {
		return err
	}
	db, err := store.Open(cfg.DBPath())
	if err != nil {
		return err
	}
	defer db.Close()
	w := store.NewWriter(db.W, store.WriterOptions{})
	st := store.New(db, box, w)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := st.QuickCheck(ctx); err != nil {
		return err
	}
	if _, err := provider.Load(); err != nil {
		return err
	}
	sel := account.NewSelector(st)
	snap, err := state.Build(ctx, st, sel, nil, time.Now().UnixMilli())
	if err != nil {
		return err
	}
	var holder state.Holder
	holder.Store(snap)

	go maintenance(ctx, st, cfg)

	srv := server.New(cfg, &holder, http.NewServeMux())
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	log.Printf("9router listening on %s (%d connections, started in %s)", cfg.Addr(), len(snap.Accounts), time.Since(start).Round(time.Millisecond))

	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			w.Close()
			return err
		}
	case <-ctx.Done():
	}
	log.Printf("shutting down (timeout %s)", cfg.ShutdownTimeout)
	sctx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(sctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
	w.Close() // drain queued writes + checkpoint
	return nil
}

// maintenance prunes every 10 minutes and backs up once a day.
func maintenance(ctx context.Context, st *store.Store, cfg config.Config) {
	tick := time.NewTicker(10 * time.Minute)
	defer tick.Stop()
	var lastBackup time.Time
	for {
		now := time.Now()
		if err := st.RunMaintenance(ctx, now, store.MaintenanceOptions{}); err != nil && ctx.Err() == nil {
			log.Printf("maintenance: %v", err)
		}
		if now.Sub(lastBackup) >= 24*time.Hour {
			if _, err := st.Backup(ctx, cfg.BackupDir(), now, 7); err != nil && ctx.Err() == nil {
				log.Printf("backup: %v", err)
			} else {
				lastBackup = now
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}
```

- [ ] **Step 4: Run tests**

Run: `cd /home/jamnas/Code/Coding/9router/go && gofmt -l . ; go vet ./... && go test -race ./...`
Expected: no gofmt output; every package `ok`.

- [ ] **Step 5: Smoke-run the binary on the imported copy (from Task 12 Step 6)**

```bash
cd /home/jamnas/Code/Coding/9router/go && go build -o /tmp/claude-1000/-home-jamnas-Code-Coding-9router/a206a541-8e19-497f-8166-80f115fd22c3/scratchpad/9router ./cmd/9router
DATA_DIR=/tmp/claude-1000/-home-jamnas-Code-Coding-9router/a206a541-8e19-497f-8166-80f115fd22c3/scratchpad/gohome PORT=20199 HOSTNAME=127.0.0.1 \
  /tmp/claude-1000/-home-jamnas-Code-Coding-9router/a206a541-8e19-497f-8166-80f115fd22c3/scratchpad/9router &
sleep 1; curl -s http://127.0.0.1:20199/api/health; echo
ps -o rss= -p $! | awk '{print $1/1024 " MiB RSS"}'
kill -TERM $!; wait $!
```

Expected: startup log with `51 connections` and a start time well under 300 ms, `{"ok":true}`, RSS well under 50 MiB, clean exit after SIGTERM.

- [ ] **Step 6: Commit**

```bash
cd /home/jamnas/Code/Coding/9router && git add go/internal/server go/cmd/9router && git commit -m "feat(go): HTTP server with client-IP and API-key middleware, main wiring

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Exit criteria for sub-project 1

- `go test -race ./...` green in `go/`.
- Importer runs on a consistent copy of the hermes DB, taken with the SQLite backup API (hermes has no `sqlite3` CLI):
  `ssh hermes 'python3 -c "import sqlite3,os; s=sqlite3.connect(os.path.expanduser(\"~/.9router/db/data.sqlite\")); d=sqlite3.connect(\"/tmp/9r-copy.sqlite\"); s.backup(d); d.close()"' && scp hermes:/tmp/9r-copy.sqlite <scratchpad>/hermes.sqlite && ssh hermes rm /tmp/9r-copy.sqlite`
  — never on the live file. It reports counts equal to the source (1639 connections, 3 API keys, 12 combos, 22 nodes, 75k+ usage events). Snapshot build + startup on that data under 300 ms, idle RSS under 50 MiB.
- Nothing under `src/`, `open-sse/`, `cli/` changed.
