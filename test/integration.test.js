import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import createServer from '../src/server.js';

const NPM_TARBALL = Buffer.from('fake npm tarball bytes for the cache test');
const PYPI_WHEEL = Buffer.from('fake pypi wheel bytes for the cache test');
const HTML_ARCHIVE = Buffer.from('fake sdist bytes for the cache test');

const NPM_TARBALL_PATH = '/is-number/-/is-number-7.0.0.tgz';
const PYPI_WHEEL_PATH = '/packages/b7/ce/six/six-1.17.0-py2.py3-none-any.whl';
const HTML_ARCHIVE_PATH = '/packages/aa/htmlpkg/htmlpkg-1.0.0.tar.gz';

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

function send(response, statusCode, contentType, body) {
  response.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'public, max-age=3600',
  });
  response.end(body);
}

async function createMockUpstream() {
  const hits = new Map();

  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://mock.invalid').pathname;
    hits.set(pathname, (hits.get(pathname) ?? 0) + 1);

    const origin = `http://127.0.0.1:${server.address().port}`;

    if (pathname === '/is-number') {
      send(
        response,
        200,
        'application/json',
        JSON.stringify({
          name: 'is-number',
          'dist-tags': { latest: '7.0.0' },
          versions: {
            '7.0.0': {
              name: 'is-number',
              version: '7.0.0',
              dist: {
                tarball: `${origin}${NPM_TARBALL_PATH}`,
                integrity: 'sha512-test',
              },
            },
          },
        }),
      );
      return;
    }

    if (pathname === NPM_TARBALL_PATH) {
      send(response, 200, 'application/octet-stream', NPM_TARBALL);
      return;
    }

    if (pathname === '/simple/six/') {
      send(
        response,
        200,
        'application/vnd.pypi.simple.v1+json',
        JSON.stringify({
          meta: { 'api-version': '1.1' },
          name: 'six',
          files: [
            {
              filename: 'six-1.17.0-py2.py3-none-any.whl',
              url: `${origin}${PYPI_WHEEL_PATH}`,
              hashes: { sha256: 'test' },
              'requires-python': '>=2.7',
            },
          ],
        }),
      );
      return;
    }

    if (pathname === '/simple/htmlpkg/') {
      send(
        response,
        200,
        'text/html; charset=utf-8',
        [
          '<!DOCTYPE html>',
          '<html><body>',
          `<a href="${origin}${HTML_ARCHIVE_PATH}#sha256=test">htmlpkg-1.0.0.tar.gz</a>`,
          '</body></html>',
        ].join('\n'),
      );
      return;
    }

    if (pathname === PYPI_WHEEL_PATH) {
      send(response, 200, 'application/octet-stream', PYPI_WHEEL);
      return;
    }

    if (pathname === HTML_ARCHIVE_PATH) {
      send(response, 200, 'application/octet-stream', HTML_ARCHIVE);
      return;
    }

    send(response, 404, 'application/json', JSON.stringify({ error: 'not found' }));
  });

  await listen(server);
  return {
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
    hitsFor(pathname) {
      return hits.get(pathname) ?? 0;
    },
    totalHits() {
      let total = 0;
      for (const count of hits.values()) total += count;
      return total;
    },
  };
}

async function waitForEntries(app, expected) {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    if (app.index.oldest(1_000).length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`cache did not reach ${expected} entries in time`);
}

test('CacheNest proxies npm and PyPI, reuses the cache, and shuts down', async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cachenest-test-'));
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

  await t.test('caches npm metadata and serves the second request from disk', async () => {
    const first = await fetch(`${base}/npm/is-number`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'application/json');

    const document = await first.json();
    assert.equal(document['dist-tags'].latest, '7.0.0');
    assert.equal(mock.hitsFor('/is-number'), 1);

    await waitForEntries(app, 1);

    const second = await fetch(`${base}/npm/is-number`);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).name, 'is-number');
    assert.equal(mock.hitsFor('/is-number'), 1, 'second metadata request should be a cache hit');
  });

  await t.test('serves npm tarballs requested without the /npm prefix', async () => {
    const root = await fetch(`${base}${NPM_TARBALL_PATH}`);
    assert.equal(root.status, 200);
    assert.deepEqual(Buffer.from(await root.arrayBuffer()), NPM_TARBALL);
    assert.equal(mock.hitsFor(NPM_TARBALL_PATH), 1);

    await waitForEntries(app, 2);

    const prefixed = await fetch(`${base}/npm${NPM_TARBALL_PATH}`);
    assert.equal(prefixed.status, 200);
    assert.deepEqual(Buffer.from(await prefixed.arrayBuffer()), NPM_TARBALL);
    assert.equal(
      mock.hitsFor(NPM_TARBALL_PATH),
      1,
      'prefixed and root tarball URLs share one cache entry',
    );
  });

  await t.test('rewrites PyPI JSON file links and caches the wheel', async () => {
    const simple = await fetch(`${base}/pypi/simple/six/`, {
      headers: { accept: 'application/vnd.pypi.simple.v1+json' },
    });
    assert.equal(simple.status, 200);

    const document = await simple.json();
    assert.equal(document.files[0].url, `/pypi/files${PYPI_WHEEL_PATH}`);

    await waitForEntries(app, 3);

    const repeated = await fetch(`${base}/pypi/simple/six/`, {
      headers: { accept: 'application/vnd.pypi.simple.v1+json' },
    });
    assert.equal((await repeated.json()).files[0].url, `/pypi/files${PYPI_WHEEL_PATH}`);
    assert.equal(mock.hitsFor('/simple/six/'), 1, 'second Simple API request should hit the cache');

    const wheel = await fetch(`${base}/pypi/files${PYPI_WHEEL_PATH}`);
    assert.equal(wheel.status, 200);
    assert.deepEqual(Buffer.from(await wheel.arrayBuffer()), PYPI_WHEEL);
    assert.equal(mock.hitsFor(PYPI_WHEEL_PATH), 1);

    await waitForEntries(app, 4);

    const cachedWheel = await fetch(`${base}/pypi/files${PYPI_WHEEL_PATH}`);
    assert.equal(cachedWheel.status, 200);
    assert.deepEqual(Buffer.from(await cachedWheel.arrayBuffer()), PYPI_WHEEL);
    assert.equal(mock.hitsFor(PYPI_WHEEL_PATH), 1, 'second wheel request should hit the cache');
  });

  await t.test('rewrites PyPI HTML file links', async () => {
    const simple = await fetch(`${base}/pypi/simple/htmlpkg/`, {
      headers: { accept: 'text/html' },
    });
    assert.equal(simple.status, 200);

    const html = await simple.text();
    assert.match(html, new RegExp(`href="/pypi/files${HTML_ARCHIVE_PATH.replaceAll('/', '\\/')}`));
    assert.equal(mock.hitsFor('/simple/htmlpkg/'), 1);

    await waitForEntries(app, 5);

    const repeated = await fetch(`${base}/pypi/simple/htmlpkg/`, {
      headers: { accept: 'text/html' },
    });
    assert.equal(await repeated.text(), html);
    assert.equal(mock.hitsFor('/simple/htmlpkg/'), 1);
  });

  await t.test('supports HEAD, rejects writes, and reports health', async () => {
    const head = await fetch(`${base}/npm/is-number`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.ok(Number(head.headers.get('content-length')) > 0);

    const write = await fetch(`${base}/npm/is-number`, { method: 'POST' });
    assert.equal(write.status, 405);
    assert.equal(write.headers.get('allow'), 'GET, HEAD');

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const status = await health.json();
    assert.equal(status.status, 'ok');
    assert.ok(status.cacheBytes > 0);
  });

  await t.test('closes cleanly and is idempotent', async () => {
    await app.close({ graceMs: 1_000 });
    await app.close({ graceMs: 1_000 });

    assert.equal(app.server.listening, false);
    await assert.rejects(fetch(`${base}/health`));
  });
});
