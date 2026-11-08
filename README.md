# CacheNest

CacheNest is a lightweight, local-first caching reverse proxy for **npm** and **PyPI**. It downloads each package once from the internet, stores it on local disk, and serves it from the cache on every later request.

For a visual walkthrough of the request flow, storage model, and design boundaries, see [HOW-IT-WORKS.md](HOW-IT-WORKS.md).

It is built for individual developers who want fast, predictable installs on their own machine, without accounts, shared infrastructure, or a service to administer.

## Contents

- [Why CacheNest matters](#why-cachenest-matters)
- [How CacheNest works](HOW-IT-WORKS.md)
- [Who it is for](#who-it-is-for)
- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Startup output](#startup-output)
- [Running on a laptop](#running-on-a-laptop)
- [Running with Docker](#running-with-docker)
- [Configuration](#configuration)
- [Metrics](#metrics)
- [Using CacheNest with npm](#using-cachenest-with-npm)
- [Using CacheNest with pip](#using-cachenest-with-pip)
- [Routes](#routes)
- [Testing](#testing)
- [Cache behavior](#cache-behavior)
- [Storage reliability](#storage-reliability)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [Deployment notes](#deployment-notes)
- [Design principles](#design-principles)

---

## Why CacheNest matters

CacheNest addresses a hidden tax on software development: **redundant bandwidth consumption**.

- **Bandwidth and cost savings:** Package managers constantly fetch the same dependencies across your projects and container builds. A 50 MB package downloaded 20 times wastes 1 GB of data. CacheNest downloads it once from the internet and serves it locally thereafter.
- **Fast local installs:** Pulling a package from your own disk takes milliseconds instead of traversing international links to a distant CDN.
- **Resilience during outages and slow networks:** If the internet drops or bandwidth is severely throttled, cached packages can still be used to initialize projects and rebuild containers.

CacheNest currently supports **npm** and **PyPI** package traffic. It is not a general-purpose HTTP or `apt` proxy.

---

## Who it is for

- **Individual developers:** Anyone who reinstalls dependencies often across a few projects on one machine.
- **Developers on metered or slow connections:** Mobile broadband or capped fiber plans where every gigabyte counts.
- **Developers who want offline-friendly installs:** Cached packages keep working when the upstream registry is slow or unreachable.
- **People who prefer simple tools:** One local process, one cache directory, no accounts, no service to administer.

---

## Features

- Caches npm registry metadata and tarballs.
- Caches PyPI Simple API responses and Python package files.
- Rewrites PyPI file links so `pip` downloads pass through CacheNest instead of bypassing it.
- Handles npm tarball URLs that lose their `/npm` path because of npm's registry-host rewriting.
- Streams downloads to the client while writing them to disk concurrently.
- Stores blobs durably with a flushed temporary file and atomic rename, so interrupted downloads never replace a complete cache entry.
- Exposes Prometheus-compatible request, cache, and bandwidth metrics at `/metrics`.
- Prints copy-paste npm and pip commands at startup using the actual bound port and a client-friendly host.
- Includes a small multi-stage Docker image with a health check and persistent cache volume.
- Keeps monitoring and configuration local: one Node.js process, one SQLite index, and a directory of blobs.
- Tracks entries in SQLite with size, creation time, and last-used time.
- Enforces a size limit with LRU eviction.
- Serves `GET` and `HEAD`; rejects write methods.
- Provides `/health` and structured request logging.
- Handles graceful shutdown on `SIGINT` and `SIGTERM`.

---

## Requirements

- Node.js **22 or newer**
- npm
- Python 3 and pip, only if you want to exercise the PyPI side
- Docker Engine with Compose v2, only if you want to run CacheNest in a container

No Raspberry Pi, home server, or dedicated hardware is required. CacheNest runs on the same laptop or desktop you develop on, either directly with Node.js or in Docker. The default bind address is `127.0.0.1`, so the service is reachable only from that machine.

---

## Quick start

For the fastest path on a personal machine (Docker + npm/pip in about two minutes), see [QUICKSTART.md](QUICKSTART.md).

```bash
npm install
npm start
```

CacheNest runs with sensible defaults and does not require a `.env` file. When it starts, it prints copy-paste npm and pip commands for the current host and port. For a container-based setup, see [Running with Docker](#running-with-docker).

By default the server listens on:

```text
http://127.0.0.1:8080
```

Check that it is running:

```bash
curl http://127.0.0.1:8080/health
```

Example response:

```json
{"status":"ok","uptimeSeconds":3,"cacheBytes":0}
```

To customize the port, host, cache location, size limit, or upstreams, copy `.env.example` to `.env` and edit it. See [Configuration](#configuration).

---

## Startup output

At startup, CacheNest prints the resolved cache location, metrics URL, and copy-paste client commands for the actual port. When the server binds to a wildcard address (`0.0.0.0` or `::`), as the Docker image does internally, the client commands use `127.0.0.1`.

```text
[cachenest] listening on http://127.0.0.1:8080
[cachenest] cache /Users/you/.cachenest (max 5 GB), npm https://registry.npmjs.org, pypi https://pypi.org/simple
[cachenest] metrics: http://127.0.0.1:8080/metrics
[cachenest] no authentication; keep the bind address on loopback for personal use
[cachenest] npm: npm install <package> --registry http://127.0.0.1:8080/npm
[cachenest] pip: python3 -m pip install <package> --index-url http://127.0.0.1:8080/pypi/simple --trusted-host 127.0.0.1
```

CacheNest has no accounts or API keys. Access control is the bind address: the default is `127.0.0.1`, and the Docker setup publishes only on loopback.

---

## Running on a laptop

A laptop is the primary target: a small local cache for one developer, with no service to administer.

To use port `8787` and keep the cache inside the project directory:

```bash
PORT=8787 HOST=127.0.0.1 CACHE_DIR=./data npm start
```

This creates:

```text
./data/index.sqlite   SQLite cache index
./data/blobs/         Cached package files
```

The repository defaults are `PORT=8080`, `HOST=127.0.0.1`, and `CACHE_DIR=~/.cachenest`; the command above moves the cache into the project and changes the port.

Laptop-specific advantages:

- **Fast local I/O:** An SSD makes cache reads very fast, so repeat installs can feel almost instant.
- **Offline reuse:** Once a package's metadata and files are cached, it can be installed again without internet access. New packages still require the upstream registry.
- **Easy cleanup:** Keeping the cache in `./data` makes it simple to inspect, back up, or delete.

Check whether the chosen port is already in use:

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

If that command returns a process, choose another port and update the URLs below accordingly.

Point npm at the local instance:

```bash
npm install lodash --registry http://127.0.0.1:8787/npm
```

Point pip at the local instance:

```bash
python3 -m pip install six \
  --index-url http://127.0.0.1:8787/pypi/simple \
  --trusted-host 127.0.0.1
```

---

## Running with Docker

The repository includes a multi-stage `Dockerfile`, a `docker-compose.yml`, and a `.dockerignore`. The image uses Node.js 22 on Alpine, installs production dependencies in a separate build stage, runs as the unprivileged `node` user, and persists `/app/data` on the host. The image also includes a health check that calls `/health`.

### Start CacheNest

Create the host cache directory first so the container user can write to it:

```bash
mkdir -p data
docker compose up --build -d
```

Check the container and follow the logs:

```bash
docker compose ps
docker compose logs -f cachenest
curl http://127.0.0.1:8787/health
```

Compose publishes the proxy only on `127.0.0.1:8787`. Keep it that way: CacheNest has no authentication and is intended for personal, local use.

Use the container with npm:

```bash
npm install lodash --registry http://127.0.0.1:8787/npm
```

Use the container with pip:

```bash
python3 -m pip install six \
  --index-url http://127.0.0.1:8787/pypi/simple \
  --trusted-host 127.0.0.1
```

Run the same command twice to verify caching. The second request should be served from `./data`, and `/metrics` should show cache hits and saved bandwidth.

### Docker configuration

| Variable | Default | Purpose |
|---|---|---|
| `CACHENEST_BIND` | `127.0.0.1` | Host interface for the published port. Keep it on loopback. |
| `CACHENEST_PORT` | `8787` | Host port published by Compose. |
| `MAX_CACHE_GB` | `10` | Cache limit passed to the container. |
| `UPSTREAM_NPM` | `https://registry.npmjs.org` | Optional npm upstream override. |
| `UPSTREAM_PYPI` | `https://pypi.org/simple` | Optional PyPI upstream override. |

Compose reads `.env` in the project root automatically. Apply changes by recreating the container:

```bash
docker compose up -d --force-recreate
```

The cache is stored in `./data` on the host and survives container rebuilds and restarts. The image runs as UID `1000` (`node`). On Linux, if the cache directory is not writable, fix ownership while the container is stopped:

```bash
sudo chown -R 1000:1000 data
```

Stop the container without deleting cached data:

```bash
docker compose down
```

---

## Configuration

CacheNest reads configuration from environment variables. A `.env` file is loaded automatically.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP port to listen on. |
| `HOST` | `127.0.0.1` | Interface to bind. Keep the default for local-only access. |
| `CACHE_DIR` | `~/.cachenest` | Directory for `index.sqlite` and cached blobs. Supports `~/`. |
| `MAX_CACHE_GB` | `5` | Maximum cache size in GB. Fractions such as `0.5` are allowed. |
| `UPSTREAM_NPM` | `https://registry.npmjs.org` | npm registry base URL. |
| `UPSTREAM_PYPI` | `https://pypi.org/simple` | PyPI Simple API base URL. |

Configuration is read at startup; restart CacheNest after changing `.env` or environment variables. `CACHE_DIR` supports `~/`, but cannot be the filesystem root. Upstream URLs may include a path prefix for self-hosted registries, but must use `http` or `https` and must not contain embedded credentials. Invalid configuration stops startup with a `[config]` error.

Example `.env`:

```env
PORT=8080
HOST=127.0.0.1
CACHE_DIR=~/.cachenest
MAX_CACHE_GB=5
UPSTREAM_NPM=https://registry.npmjs.org
UPSTREAM_PYPI=https://pypi.org/simple
```

To keep cached data inside a project or temporary directory, set `CACHE_DIR` explicitly:

```bash
CACHE_DIR=./data PORT=8080 npm start
```

---

## Metrics

`GET /metrics` exposes Prometheus text-format metrics:

| Metric | Type | Meaning |
|---|---|---|
| `cachenest_requests_total` | counter | Requests handled, excluding `/metrics` scrapes. |
| `cachenest_cache_hits_total` | counter | Cache lookups served from local disk. |
| `cachenest_cache_misses_total` | counter | Cache lookups that required an upstream fetch. |
| `cachenest_bandwidth_served_bytes_total` | counter | Response body bytes sent to clients. |
| `cachenest_bandwidth_saved_bytes_total` | counter | Bytes served from cache instead of upstream. |
| `cachenest_uptime_seconds` | gauge | Process uptime in seconds. |

`cachenest_requests_total` counts every non-`/metrics` request, including health checks and rejected requests. Hits and misses are recorded only for proxy cache lookups. `cachenest_bandwidth_saved_bytes_total` equals bytes served from cache hits; `cachenest_bandwidth_served_bytes_total` includes bytes from both hits and misses. `HEAD` responses contribute zero bytes.

The endpoint returns Prometheus text format (`text/plain; version=0.0.4`) and supports `HEAD`.

Example:

```bash
curl http://127.0.0.1:8080/metrics
```

Prometheus scrape configuration:

```yaml
scrape_configs:
  - job_name: cachenest
    static_configs:
      - targets: ["127.0.0.1:8080"]
```

Useful PromQL queries:

```promql
# Cache hit ratio over the last five minutes.
sum(rate(cachenest_cache_hits_total[5m]))
/
sum(rate(cachenest_cache_hits_total[5m]) + rate(cachenest_cache_misses_total[5m]))

# Bytes saved per second over the last five minutes.
sum(rate(cachenest_bandwidth_saved_bytes_total[5m]))
```

Metrics are in memory and reset when CacheNest restarts. If you run multiple CacheNest instances, scrape each one separately or aggregate them in Prometheus.

---

## Using CacheNest with npm

Pass the registry explicitly for a single command:

```bash
npm install lodash --registry http://127.0.0.1:8080/npm
```

Or create a project-local `.npmrc`:

```ini
registry=http://127.0.0.1:8080/npm
```

Then run normal npm commands:

```bash
npm install
```

Prefer a project-local `.npmrc` over changing your global npm configuration, so only the projects you choose use CacheNest.

npm normally rewrites tarball hosts and can drop the `/npm` path. CacheNest accepts both forms:

```text
http://127.0.0.1:8080/npm/lodash/-/lodash-4.17.21.tgz
http://127.0.0.1:8080/lodash/-/lodash-4.17.21.tgz
```

Both map to the same upstream package and share one cache entry.

---

## Using CacheNest with pip

```bash
python3 -m pip install six \
  --index-url http://127.0.0.1:8080/pypi/simple \
  --trusted-host 127.0.0.1
```

Or download only:

```bash
python3 -m pip download six \
  --no-deps \
  --no-cache-dir \
  --dest ./downloads \
  --index-url http://127.0.0.1:8080/pypi/simple \
  --trusted-host 127.0.0.1
```

CacheNest rewrites package links in PyPI Simple JSON and HTML responses to local `/pypi/files/...` URLs, so both metadata and wheel/sdist downloads pass through the cache.

The `--no-cache-dir` flag only disables pip's local wheel cache; it does not bypass CacheNest. The `--trusted-host` flag is required because pip is talking to a plain HTTP local endpoint.

---

## Routes

| Route | Upstream | Purpose |
|---|---|---|
| `GET/HEAD /npm/*` | `UPSTREAM_NPM` | npm package metadata and tarballs. |
| `GET/HEAD /{package}/-/{tarball}.tgz` | `UPSTREAM_NPM` | Fallback for npm tarballs requested without `/npm`. |
| `GET/HEAD /pypi/simple/{project}/` | `UPSTREAM_PYPI` | PEP 691 JSON or HTML Simple API response. |
| `GET/HEAD /pypi/{project}/` | `UPSTREAM_PYPI` | Alternate Simple API path. |
| `GET/HEAD /pypi/files/{path}` | `files.pythonhosted.org` | Rewritten PyPI package files. |
| `GET/HEAD /pypi/packages/{path}` | `files.pythonhosted.org` | PyPI package files. |
| `GET/HEAD /health` | none | Health and cache size. |
| `GET/HEAD /metrics` | none | Prometheus metrics. |

Unsupported methods return `405`.

---

## Testing

### Offline integration test

The test suite uses mock npm and PyPI upstreams, so it does not need internet access:

```bash
npm test
```

It covers:

- npm metadata cache misses and hits
- root-level npm tarball fallback
- shared cache entries for prefixed and unprefixed tarball URLs
- PyPI JSON and HTML link rewriting
- wheel downloads and cache hits
- `HEAD`, `405`, `/health`, and graceful shutdown
- Prometheus metrics and scrape exclusion
- atomic blob writes and failed-download cleanup

### Live test against real registries

Start CacheNest with a temporary cache:

```bash
CACHE_DIR="$(mktemp -d)" PORT=8080 HOST=127.0.0.1 npm start
```

In another terminal:

```bash
# npm: run twice to exercise the warm cache
npm pack is-number@7.0.0 \
  --registry http://127.0.0.1:8080/npm \
  --cache "$(mktemp -d)"

# PyPI: run twice to exercise the warm cache
python3 -m pip download \
  --no-deps --no-cache-dir \
  --dest "$(mktemp -d)" \
  --index-url http://127.0.0.1:8080/pypi/simple \
  --trusted-host 127.0.0.1 \
  six
```

The first run fetches from the internet. Later runs should complete in milliseconds and should not increase upstream request counts.

You can inspect the cache directory:

```bash
find "$CACHE_DIR/blobs" -type f | wc -l
```

Or, if `sqlite3` is installed:

```bash
sqlite3 "$CACHE_DIR/index.sqlite" \
  'SELECT COUNT(*) AS entries, COALESCE(SUM(size), 0) AS bytes FROM cache_entries;'
```

---

## Cache behavior

- Only successful `GET` responses with status `200` are stored.
- `HEAD` requests are served from cache when possible but do not create entries.
- Responses to requests that carry an upstream `Authorization` header are not stored. This keeps authenticated upstream traffic out of the cache.
- Responses with `Cache-Control: no-store`, `no-cache`, or `private` are not stored.
- Responses with `Vary: *` are not stored.
- Cache keys are SHA-256 hashes derived from the request method and path, including the query string when present.
- Blobs are sharded under `CACHE_DIR/blobs` and written atomically; see [Storage reliability](#storage-reliability).
- The SQLite index at `CACHE_DIR/index.sqlite` tracks blob size and LRU metadata.
- When `MAX_CACHE_GB` is exceeded, the least recently used entries are evicted.

---

## Storage reliability

Cache fills are ordered so the SQLite index never points at a partial file:

1. CacheNest streams the upstream body to the client while writing it to a hidden temporary file in the destination shard, for example `CACHE_DIR/blobs/ab/.<key>.<uuid>.tmp`.
2. The temporary file is flushed to disk before the write is considered complete.
3. The completed file is atomically renamed to its final SHA-256 path.
4. Only after the rename succeeds is the blob recorded in the SQLite index and counted for LRU eviction.
5. If indexing fails, the new blob is removed instead of being left invisible to the index.

If a download fails, CacheNest removes the temporary file and never exposes a partial target. A hard process or machine crash can leave an orphaned `.tmp` file or an unindexed blob, but neither is served: reads and eviction use the SQLite index and final blob paths only. Orphaned temp files can be removed after stopping CacheNest:

```bash
find "$CACHE_DIR/blobs" -type f -name '*.tmp' -delete
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `EADDRINUSE` at startup | Another process is using the configured port. | Choose another `PORT`, or find the listener with `lsof -nP -iTCP:8080 -sTCP:LISTEN`. |
| Connection refused from another machine | CacheNest is bound to `127.0.0.1` by design. | Use it from the same machine. CacheNest is a personal, local-only cache. |
| pip warns that the index is not trusted | The local endpoint uses plain HTTP. | Keep `--trusted-host 127.0.0.1`. |
| Cache hits stay at zero | Only successful proxy `GET` responses that are cacheable count as lookups. The first request is a miss, and `/health` and `/metrics` are not cache lookups. | Run the same package request twice, then check `/metrics`. Also inspect upstream `Cache-Control`, `Vary`, and whether a separate upstream `Authorization` header is being sent. |

To confirm the proxy is alive and the cache is receiving traffic:

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/metrics
```

---

## Project layout

```text
Dockerfile              Multi-stage Node 22 Alpine image with health check
docker-compose.yml      Local Docker Compose setup
.dockerignore           Build context exclusions
src/
  config.js             Environment configuration and validation
  index.js              Entry point, startup banner, signal handling, graceful shutdown
  server.js             HTTP server, middleware pipeline, routing, health, shutdown
  core/
    cache.js            Hit/miss orchestration, streaming fills, reindex cleanup
    eviction.js         LRU enforcement
    index-db.js         SQLite cache index in WAL mode
    store.js            Durable atomic sharded blob storage
  middleware/
    metrics.js          Request, cache, and bandwidth counters plus Prometheus output
  routes/
    common.js           Shared route helpers
    npm.js              npm metadata and tarball routing
    pypi.js             PyPI Simple API and package-file routing
  upstream/
    forward.js          Undici upstream requests, redirects, timeouts
  utils/
    hash.js             SHA-256 cache keys
test/
  integration.test.js   Offline npm/PyPI integration tests
  metrics.test.js       Health, metrics, and cache-hit tests
  store.test.js         Atomic blob-write and failure-cleanup tests
```

---

## Deployment notes

- CacheNest is built for **personal, local use**. It has no authentication and no accounts.
- Keep the bind address on loopback: `HOST=127.0.0.1` for `npm start`, and `CACHENEST_BIND=127.0.0.1` for Docker Compose. The Docker image binds `0.0.0.0` internally so published ports work; the host side stays loopback.
- Do not expose CacheNest to other devices or the internet.
- Set `CACHE_DIR` to a disk with enough capacity for your dependency set.
- Metrics are per-process. If you run multiple CacheNest instances, scrape each one separately or aggregate them in Prometheus.
- SQLite runs in WAL mode. Include `index.sqlite`, `index.sqlite-wal`, and `index.sqlite-shm` when backing up a live cache directory; the blobs directory must be backed up with it.
- The server drains in-flight requests during graceful shutdown.

---

## Design principles

- **Local-first:** The cache is a directory you own, not a hosted service.
- **Streaming:** Downloads reach the client immediately while the cache is filled.
- **Crash-safe writes:** Blobs are written to temporary files and atomically renamed.
- **Explicit accounting:** SQLite is the source of truth for cache size and LRU order.
- **Small operational surface:** One Node.js process, one SQLite file, and a blob directory.
