# CacheNest — personal quick start

Get a local npm + pip cache running on your own machine in about two minutes.
Everything below assumes Docker Desktop (or Docker Engine + Compose v2) is installed.

---

## TL;DR — the five commands

```bash
cd CacheNest
mkdir -p data
docker compose up -d --build
curl http://127.0.0.1:8787/health
npm install lodash --registry http://127.0.0.1:8787/npm
```

That's it. CacheNest is now caching npm packages into `./data` on port **8787**.

---

## 1. Start it

```bash
cd CacheNest
mkdir -p data
docker compose up -d --build
```

Wait a few seconds, then confirm it is healthy:

```bash
docker compose ps
curl http://127.0.0.1:8787/health
```

Expected:

```text
NAME        STATUS                   PORTS
cachenest   Up (healthy)             127.0.0.1:8787->8787/tcp

{"status":"ok","uptimeSeconds":5,"cacheBytes":0}
```

> `mkdir -p data` is required first so the container user can write to the cache
> directory. On Linux, if the container cannot write, run
> `sudo chown -R 1000:1000 data` once.

---

## 2. Point npm at it

Best for a single project — create or append a `.npmrc` in the project root:

```bash
echo 'registry=http://127.0.0.1:8787/npm' >> .npmrc
npm install
```

Or for one command only:

```bash
npm install lodash --registry http://127.0.0.1:8787/npm
```

Prefer per-project `.npmrc` over `npm config set registry` (global): if Docker
isn't running, the failure is obvious and limited to that project.

---

## 3. Point pip at it

```bash
python3 -m pip config set global.index-url http://127.0.0.1:8787/pypi/simple
python3 -m pip config set global.trusted-host 127.0.0.1
```

Or for one command only:

```bash
python3 -m pip install requests \
  --index-url http://127.0.0.1:8787/pypi/simple \
  --trusted-host 127.0.0.1
```

`--trusted-host` is required because the local endpoint is plain HTTP.

---

## 4. Prove that it is caching

Run the same install twice and watch the counters:

```bash
# first run = misses (upstream fetch)
npm install lodash --registry http://127.0.0.1:8787/npm

# second run = hits (served from ./data)
npm install lodash --registry http://127.0.0.1:8787/npm

curl -s http://127.0.0.1:8787/metrics | grep -E 'hits|misses|saved'
```

Or use the automated suite (cold miss + warm hit + restart persistence):

```bash
npm run test:integration
```

Follow traffic live:

```bash
docker compose logs -f cachenest
```

---

## Everyday commands

| Task | Command |
|---|---|
| Start | `docker compose up -d` |
| Stop (cache kept) | `docker compose down` |
| Restart | `docker compose restart` |
| Status | `docker compose ps` |
| Logs | `docker compose logs -f cachenest` |
| Rebuild after an update | `docker compose up -d --build` |
| Cache size on disk | `du -sh data` |
| Live metrics | `curl -s http://127.0.0.1:8787/metrics` |

The cache lives in `./data` on your machine and survives restarts and rebuilds.

---

## When the cache goes stale

CacheNest does not expire cached metadata yet, so a brand-new package version
can take a while to appear, and browsing the proxy URLs by hand can poison the
cached variant. Reset the cache — it is disposable:

```bash
docker compose down
rm -rf data
docker compose up -d
```

Then reinstall what you need.

---

## Limits and configuration

Defaults are fine for a laptop. To change them, create a `.env` next to
`docker-compose.yml`:

```ini
# Keep the proxy local-only (default).
CACHENEST_BIND=127.0.0.1
CACHENEST_PORT=8787

# Cache size limit in GB.
MAX_CACHE_GB=10
```

Apply changes with:

```bash
docker compose up -d --force-recreate
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `curl: connection refused` | Container is stopped or Docker Desktop isn't running. `docker compose up -d`, then retry. |
| `port is already allocated` | Something else uses 8787. Set `CACHENEST_PORT=8888` in `.env`, then `docker compose up -d`. |
| Container is `unhealthy` | `docker compose logs cachenest` — usually the port or `data/` permissions. |
| npm hangs or `ECONNREFUSED` | The registry is set to the proxy but the container is down. Start it or remove the `.npmrc` line. |
| pip warns "not trusted" | Pass `--trusted-host 127.0.0.1`, or keep the `pip config` entry above. |
| `EACCES` writing cache on Linux | `sudo chown -R 1000:1000 data`, then restart. |
| Downloads are slow the first time | Expected: the first request is a miss and goes to the internet. Repeat it to see the cache hit. |

---

## Safety rules for a personal machine

- Keep `CACHENEST_BIND=127.0.0.1` so only your machine can reach it.
- CacheNest has no authentication. Don't expose it to other devices or the internet.
- Use it only from npm and pip. Don't open the registry URLs in a browser — the
  cached response variant can confuse later installs.
- The cache holds no credentials, but treat `./data` as private local state.

---

## Remove it completely

```bash
docker compose down
rm -rf data
docker image rm cachenest:local
```
