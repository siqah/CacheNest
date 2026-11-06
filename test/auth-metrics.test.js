import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createServer } from '../src/server.js';

const API_KEY = 'test-api-key';

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

test('API key authentication protects routes without disabling the cache', async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cachenest-auth-'));
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
      apiKey: API_KEY,
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

  await t.test('rejects a missing key', async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer realm="cachenest"');
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const body = await response.json();
    assert.equal(body.error, 'UNAUTHORIZED');
    assert.equal(mock.requests(), 0);
  });

  await t.test('rejects an invalid key', async () => {
    const response = await fetch(`${base}/health`, {
      headers: { authorization: 'Bearer wrong-key' },
    });
    assert.equal(response.status, 401);
    assert.equal(mock.requests(), 0);
  });

  await t.test('accepts Bearer, Basic, and x-cachenest-key credentials', async () => {
    const bearer = await fetch(`${base}/npm/test`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    assert.equal(bearer.status, 200);
    assert.equal(mock.requests(), 1);
    await waitFor(() => app.index.oldest(1_000).length >= 1, 'npm response was not indexed');

    const custom = await fetch(`${base}/npm/test`, {
      headers: { 'x-cachenest-key': API_KEY },
    });
    assert.equal(custom.status, 200);
    assert.equal(
      mock.requests(),
      1,
      'the auth header must be stripped before the cache lookup',
    );

    const basic = Buffer.from(`cachenest:${API_KEY}`).toString('base64');
    const basicFirst = await fetch(`${base}/pypi/simple/test/`, {
      headers: { authorization: `Basic ${basic}` },
    });
    assert.equal(basicFirst.status, 200);
    assert.equal(mock.requests(), 2);
    await waitFor(() => app.index.oldest(1_000).length >= 2, 'PyPI response was not indexed');

    const basicSecond = await fetch(`${base}/pypi/simple/test/`, {
      headers: { authorization: `Basic ${basic}` },
    });
    assert.equal(basicSecond.status, 200);
    assert.equal(mock.requests(), 2, 'Basic auth should also leave caching enabled');
  });

  await t.test('protects /metrics and reports authenticated cache traffic', async () => {
    await waitFor(
      () => app.metrics.snapshot().cacheHits >= 2 && app.metrics.snapshot().cacheMisses >= 2,
      'cache metrics were not recorded',
    );

    const unauthorized = await fetch(`${base}/metrics`);
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${base}/metrics`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    assert.equal(response.status, 200);

    const body = await response.text();
    assert.match(body, /cachenest_cache_hits_total [1-9]/);
    assert.match(body, /cachenest_cache_misses_total [1-9]/);
    assert.match(body, /cachenest_bandwidth_saved_bytes_total [1-9]/);
  });
});
