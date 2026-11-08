import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createServer } from '../src/server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
  });
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(message);
}

async function createMockUpstream() {
  let requests = 0;

  const server = http.createServer((request, response) => {
    requests += 1;

    const body = JSON.stringify({ path: request.url, ok: true });
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'public, max-age=3600',
    });
    response.end(body);
  });

  await listen(server);

  return {
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
    requests() {
      return requests;
    },
  };
}

test('health and metrics report cache activity', async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cachenest-metrics-'));
  const mock = await createMockUpstream();

  let app;

  t.after(async () => {
    await app?.close({ graceMs: 1_000 }).catch(() => {});
    await closeServer(mock.server);
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  const cacheDir = path.join(temporaryDirectory, 'cache');
  app = createServer({
    config: {
      port: 0,
      cacheDir,
      indexDbPath: path.join(cacheDir, 'index.sqlite'),
      maxCacheGb: 0.0625,
      maxCacheBytes: 64 * 1024 * 1024,
      upstream: {
        npm: mock.origin,
        pypi: `${mock.origin}/simple`,
      },
    },
    logger: null,
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.address().port}`;

  await t.test('serves health without authentication', async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.cacheBytes, 'number');
  });

  await t.test('counts a miss, then a hit for the same npm route', async () => {
    const first = await fetch(`${base}/npm/test`);
    assert.equal(first.status, 200);
    await first.text();

    await waitFor(() => app.index.oldest(1_000).length >= 1, 'npm response was not indexed');
    assert.equal(mock.requests(), 1);

    const second = await fetch(`${base}/npm/test`);
    assert.equal(second.status, 200);
    await second.text();
    assert.equal(mock.requests(), 1, 'second request should be served from cache');

    await waitFor(
      () => app.metrics.snapshot().cacheHits >= 1 && app.metrics.snapshot().cacheMisses >= 1,
      'cache metrics were not recorded',
    );
  });

  await t.test('counts a miss, then a hit for the same PyPI route', async () => {
    const first = await fetch(`${base}/pypi/simple/test/`);
    assert.equal(first.status, 200);
    await first.text();

    await waitFor(() => app.index.oldest(1_000).length >= 2, 'PyPI response was not indexed');
    assert.equal(mock.requests(), 2);

    const second = await fetch(`${base}/pypi/simple/test/`);
    assert.equal(second.status, 200);
    await second.text();
    assert.equal(mock.requests(), 2, 'second request should be served from cache');
  });

  await t.test('exposes Prometheus counters on /metrics', async () => {
    await waitFor(
      () => app.metrics.snapshot().cacheHits >= 2 && app.metrics.snapshot().cacheMisses >= 2,
      'cache metrics were not recorded',
    );

    const response = await fetch(`${base}/metrics`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/plain/);

    const body = await response.text();
    assert.match(body, /cachenest_requests_total [1-9]/);
    assert.match(body, /cachenest_cache_hits_total [1-9]/);
    assert.match(body, /cachenest_cache_misses_total [1-9]/);
    assert.match(body, /cachenest_bandwidth_saved_bytes_total [1-9]/);
  });
});
