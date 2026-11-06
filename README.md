# CacheNest

CacheNest is a lightweight, local-first caching reverse proxy for **npm** and **PyPI**. It downloads each package once from the internet, stores it on local disk, and serves it from the cache on every later request.

It is built for developers, students, and homelab enthusiasts working in regions or environments with metered, expensive, throttled, or unreliable internet connections, including many emerging tech hubs.

---

## Why CacheNest matters

CacheNest addresses a hidden tax on software development: **redundant bandwidth consumption**.

- **Bandwidth and cost savings:** Package managers constantly fetch the same dependencies across different projects, container builds, and team machines. A 50 MB package downloaded 20 times wastes 1 GB of data. CacheNest downloads it once from the WAN and serves it locally thereafter.
- **Fast local installs:** Pulling a package from a local network or a small machine on your desk can take milliseconds instead of traversing international links to a distant CDN.
- **Resilience during outages and slow networks:** If the internet drops or bandwidth is severely throttled, cached packages can still be used to initialize projects and rebuild containers.

CacheNest currently supports **npm** and **PyPI** package traffic. It is not a general-purpose HTTP or `apt` proxy.

---

## Who it is for

- **Developers in metered or limited-bandwidth regions:** Engineers and remote workers who rely on mobile broadband or capped fiber plans where every gigabyte counts.
- **Bootcamps, universities, and tech hubs:** Institutions where dozens of students pull heavy `node_modules` trees or Python virtual environments at the same time. One CacheNest node in a lab can prevent the whole classroom from bottlenecking the local network.
- **Homelab enthusiasts and Raspberry Pi tinkerers:** People who run self-hosted, lightweight services on low-power local hardware.
- **Hackathon teams:** Fast-paced events under tight time and network constraints, where reliable dependency installation can save hours of development time.

---

## Features

- Caches npm registry metadata and tarballs.
- Caches PyPI Simple API responses and Python package files.
- Rewrites PyPI file links so `pip` downloads pass through CacheNest instead of bypassing it.
- Handles npm tarball URLs that lose their `/npm` path because of npm's registry-host rewriting.
- Streams downloads to the client while writing them to disk concurrently.
- Stores blobs atomically, so interrupted downloads do not leave partial cache entries.
- Supports optional API-key authentication for proxy, health, and metrics routes.
- Exposes Prometheus-compatible cache and bandwidth metrics at `/metrics`.
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

---

## Quick start

```bash
npm install
npm start
```

CacheNest runs with sensible defaults and does not require a `.env` file. When it starts, it prints copy-paste npm and pip commands for the current host and port.

By default the server listens on:

```text
http://0.0.0.0:8080
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

## Running on a laptop

A laptop is the best place to develop and test CacheNest before deploying it to a Raspberry Pi, home server, or shared lab machine.

To use port `8787`, bind only to the local machine, and keep the cache inside the project directory:

```bash
PORT=8787 HOST=127.0.0.1 CACHE_DIR=./data npm start
```

This creates:

```text
./data/index.sqlite   SQLite cache index
./data/blobs/         Cached package files
```

The repository defaults are `PORT=8080`, `HOST=0.0.0.0`, and `CACHE_DIR=~/.cachenest`; the command above overrides them for a local-only laptop setup.

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

## Configuration

CacheNest reads configuration from environment variables. A `.env` file is loaded automatically.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP port to listen on. |
| `HOST` | `0.0.0.0` | Interface to bind. Use `127.0.0.1` for local-only access. |
| `API_KEY` | unset | Optional API key. When set, all routes require authentication. |
| `CACHE_DIR` | `~/.cachenest` | Directory for `index.sqlite` and cached blobs. Supports `~/`. |
| `MAX_CACHE_GB` | `5` | Maximum cache size in GB. Fractions such as `0.5` are allowed. |
| `UPSTREAM_NPM` | `https://registry.npmjs.org` | npm registry base URL. |
| `UPSTREAM_PYPI` | `https://pypi.org/simple` | PyPI Simple API base URL. |

Example `.env`:

```env
API_KEY=
PORT=8080
HOST=0.0.0.0
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

## Authentication

Authentication is disabled when `API_KEY` is unset, which is the default for local use. Set `API_KEY` to protect every route, including `/health` and `/metrics`.

Clients can authenticate with any of these forms:

```text
Authorization: Bearer <API_KEY>
x-cachenest-key: <API_KEY>
```

Basic authentication is also accepted, with the API key as either the username or password. This allows pip to use its standard credentials-in-URL form.

Check authentication with curl:

```bash
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:8080/health
```

For npm, a project-local `.npmrc` can contain:

```ini
registry=http://127.0.0.1:8080/npm
//127.0.0.1:8080/npm/:_authToken=${API_KEY}
```

For pip, the API key can be passed as the password:

```bash
python3 -m pip install six \
  --index-url "http://cachenest:$API_KEY@127.0.0.1:8080/pypi/simple" \
  --trusted-host 127.0.0.1
```

Credentials in a URL may appear in shell history or process listings. For shared systems, prefer a credentials file or environment-based configuration.

When authentication is enabled, CacheNest removes its own auth headers before forwarding the request. This prevents the API key from reaching upstream registries and keeps package responses cacheable.

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

Example:

```bash
curl http://127.0.0.1:8080/metrics
```

If `API_KEY` is set, the scrape request must include it:

```bash
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:8080/metrics
```

Prometheus scrape configuration:

```yaml
scrape_configs:
  - job_name: cachenest
    static_configs:
      - targets: ["127.0.0.1:8080"]
    authorization:
      credentials: "<API_KEY>"   # omit when API_KEY is not set
```

Metrics are in memory and reset when CacheNest restarts.

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

Avoid changing your global npm configuration unless you intend every project to use CacheNest.

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

The `--trusted-host` flag is required because `pip` is talking to a plain HTTP local endpoint. For shared deployments, put CacheNest behind a TLS-terminating reverse proxy.

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
- API-key authentication and auth-header stripping
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
- Responses to requests carrying an `Authorization` header are not stored.
- Responses with `Cache-Control: no-store`, `no-cache`, or `private` are not stored.
- Responses with `Vary: *` are not stored.
- Cache keys are SHA-256 hashes derived from the request method and path.
- Blobs are sharded under `CACHE_DIR/blobs` and written atomically.
- The SQLite index at `CACHE_DIR/index.sqlite` tracks blob size and LRU metadata.
- When `MAX_CACHE_GB` is exceeded, the least recently used entries are evicted.

---

## Project layout

```text
src/
  config.js             Environment configuration and defaults
  index.js              Entry point, signal handling, graceful shutdown
  server.js             HTTP server, routing, logging, health, shutdown
  core/
    cache.js            Hit/miss orchestration and streaming cache fill
    eviction.js         LRU enforcement
    index-db.js         SQLite cache index
    store.js            Atomic sharded blob storage
  middleware/
    auth.js             Optional API-key authentication
    metrics.js          Request, cache, and bandwidth metrics
  routes/
    common.js           Shared route helpers
    npm.js              npm metadata and tarball routing
    pypi.js             PyPI Simple API and package-file routing
  upstream/
    forward.js          Undici upstream requests, redirects, timeouts
  utils/
    hash.js             SHA-256 cache keys
test/
  auth-metrics.test.js  Authentication and metrics integration tests
  integration.test.js   Offline npm/PyPI integration tests
  store.test.js         Atomic blob-write tests
```

---

## Deployment notes

- CacheNest does not terminate TLS. Use a reverse proxy such as Caddy, nginx, or Traefik for shared or internet-facing deployments.
- Set `API_KEY` before exposing CacheNest beyond a trusted local machine.
- Without `API_KEY`, CacheNest has no authentication. Bind to `127.0.0.1` or keep it on a trusted network.
- Set `CACHE_DIR` to a disk with enough capacity for your dependency set.
- Metrics are per-process. If you run multiple CacheNest instances, scrape each one separately or aggregate them in Prometheus.
- SQLite runs in WAL mode; include the `-wal` and `-shm` files when backing up a live cache directory.
- The server drains in-flight requests during graceful shutdown.

---

## Design principles

- **Local-first:** The cache is a directory you own, not a hosted service.
- **Streaming:** Downloads reach the client immediately while the cache is filled.
- **Crash-safe writes:** Blobs are written to temporary files and atomically renamed.
- **Explicit accounting:** SQLite is the source of truth for cache size and LRU order.
- **Small operational surface:** One Node.js process, one SQLite file, and a blob directory.
