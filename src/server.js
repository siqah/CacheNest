import { randomUUID } from 'node:crypto';
import http from 'node:http';

import { config } from './config.js';
import { Cache } from './core/cache.js';
import { Eviction } from './core/eviction.js';
import { IndexDB } from './core/index-db.js';
import { BlobStore } from './core/store.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { Metrics, createMetricsMiddleware, sendMetrics } from './middleware/metrics.js';
import { createNpmRouter } from './routes/npm.js';
import { createPypiRouter } from './routes/pypi.js';
import { HttpError, parseRequestTarget, requireReadMethod } from './routes/common.js';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_GRACE_MS = 10_000;

function requestPath(rawUrl) {
  const value = String(rawUrl ?? '/');
  const queryIndex = value.indexOf('?');
  const pathname = queryIndex === -1 ? value : value.slice(0, queryIndex);

  return pathname.slice(0, 2048).replace(/[\u0000-\u001f\u007f]/g, '?');
}

function logLine(logger, level, message) {
  if (!logger) return;

  const target = typeof logger[level] === 'function'
    ? logger[level].bind(logger)
    : typeof logger.log === 'function'
      ? logger.log.bind(logger)
      : typeof logger === 'function'
        ? logger
        : null;

  if (target) target(message);
}

/**
 * Access logger middleware. It never logs query strings, since package
 * registries occasionally place credentials or signed tokens there.
 *
 * @param {{ logger?: { info?: Function, error?: Function, warn?: Function } | Function | null }} [options]
 */
function createRequestLogger({ logger = console } = {}) {
  return function requestLogger(request, response, next) {
    const started = process.hrtime.bigint();
    const requestId = randomUUID();

    if (!response.headersSent) {
      response.setHeader('x-request-id', requestId);
    }

    let logged = false;
    const finish = (outcome) => {
      if (logged) return;
      logged = true;

      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const method = String(request.method ?? 'GET').toUpperCase();
      logLine(
        logger,
        outcome === 'aborted' ? 'warn' : 'info',
        `${method} ${requestPath(request.url)} ${response.statusCode} ${durationMs.toFixed(1)}ms ${requestId} ${outcome}`,
      );
    };

    response.once('finish', () => finish('complete'));
    response.once('close', () => {
      if (!response.writableFinished) finish('aborted');
    });

    return next();
  };
}

function sendJson(response, statusCode, payload, { headers = {}, head = false } = {}) {
  if (response.writableEnded || response.destroyed) return;

  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  });
  response.end(head ? undefined : body);
}

function errorStatus(error) {
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599) {
    return error.statusCode;
  }

  return 500;
}

/**
 * CacheNest HTTP application.
 */
export class CacheNestServer {
  #requestHandler;
  #closing;
  #started;

  /**
   * @param {{
   *   config?: typeof config,
   *   logger?: { info?: Function, error?: Function, warn?: Function } | Function | null,
   *   upstreams?: {
   *     npm?: string | URL,
   *     pypi?: string | URL,
   *     pypiFiles?: string | URL,
   *   },
   *   metrics?: import('./middleware/metrics.js').Metrics,
   * }} [options]
   */
  constructor({
    config: appConfig = config,
    logger = console,
    upstreams = {},
    metrics = new Metrics(),
  } = {}) {
    if (
      appConfig === null
      || typeof appConfig !== 'object'
      || typeof appConfig.cacheDir !== 'string'
      || typeof appConfig.indexDbPath !== 'string'
      || !Number.isSafeInteger(appConfig.maxCacheBytes)
      || appConfig.maxCacheBytes <= 0
      || appConfig.upstream === null
      || typeof appConfig.upstream !== 'object'
    ) {
      throw new TypeError('CacheNestServer: a valid CacheNest config object is required');
    }

    if (upstreams === null || typeof upstreams !== 'object') {
      throw new TypeError('CacheNestServer: upstreams must be an object');
    }

    this.config = appConfig;
    this.logger = logger;
    this.metrics = metrics;
    this.routes = [];
    this.#started = false;

    let index;
    let store;
    let eviction;
    let cache;
    let npmRouter;
    let pypiRouter;

    try {
      index = new IndexDB({ dbPath: appConfig.indexDbPath });
      store = new BlobStore({ cacheDir: appConfig.cacheDir });
      eviction = new Eviction({
        index,
        store,
        maxBytes: appConfig.maxCacheBytes,
        logger,
      });
      cache = new Cache({ index, store, eviction, logger });

      npmRouter = createNpmRouter({
        cache,
        upstream: upstreams.npm ?? appConfig.upstream.npm,
        logger,
      });

      pypiRouter = createPypiRouter({
        cache,
        upstream: upstreams.pypi ?? appConfig.upstream.pypi,
        filesUpstream: upstreams.pypiFiles,
        logger,
      });
    } catch (error) {
      void Promise.allSettled([
        npmRouter?.close?.(),
        pypiRouter?.close?.(),
      ]).finally(() => {
        try {
          index?.close?.();
        } catch {
          // Preserve the startup error.
        }
      });

      throw error;
    }

    this.index = index;
    this.store = store;
    this.cache = cache;
    this.npmRouter = npmRouter;
    this.pypiRouter = pypiRouter;
    this.routes.push(npmRouter, pypiRouter);

    const requestLogger = createRequestLogger({ logger });
    const metricsMiddleware = createMetricsMiddleware({ metrics: this.metrics });
    const authMiddleware = createAuthMiddleware({ apiKey: appConfig.apiKey ?? null });

    const handler = (request, response) => requestLogger(
      request,
      response,
      () => metricsMiddleware(
        request,
        response,
        () => authMiddleware(
          request,
          response,
          () => this.#dispatch(request, response),
        ),
      ),
    );

    this.#requestHandler = (request, response) => {
      Promise.resolve()
        .then(() => handler(request, response))
        .catch((error) => this.#handleError(error, request, response));
    };

    this.server = http.createServer(this.#requestHandler);
    this.server.keepAliveTimeout = 65_000;
    this.server.headersTimeout = 66_000;
    this.server.requestTimeout = 60_000;
    this.server.maxHeadersCount = 200;

    this.server.on('clientError', (error, socket) => {
      if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      } else {
        socket.destroy(error);
      }
    });

    this.server.on('error', (error) => {
      logLine(logger, 'error', `[server] ${error.message}`);
    });
  }

  /**
   * Start listening. Calling listen() more than once is an error.
   *
   * @param {{ port?: number, host?: string }} [options]
   * @returns {Promise<import('node:net').AddressInfo | string>}
   */
  async listen({ port = this.config.port, host = DEFAULT_HOST } = {}) {
    if (this.#started) {
      throw new Error('CacheNestServer: server is already started');
    }

    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new TypeError('CacheNestServer: port must be an integer between 0 and 65535');
    }

    if (typeof host !== 'string' || host.trim() === '') {
      throw new TypeError('CacheNestServer: host must be a non-empty string');
    }

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off('listening', onListening);
        this.server.off('error', onError);
        reject(error);
      };

      const onListening = () => {
        this.server.off('error', onError);
        resolve();
      };

      this.server.once('error', onError);
      this.server.once('listening', onListening);

      try {
        this.server.listen(port, host);
      } catch (error) {
        this.server.off('error', onError);
        this.server.off('listening', onListening);
        reject(error);
      }
    });

    this.#started = true;
    return this.address();
  }

  /**
   * @returns {import('node:net').AddressInfo | string | null}
   */
  address() {
    return this.server.address();
  }

  /**
   * Stop accepting requests, drain in-flight responses, then release SQLite
   * and upstream connection pools. Safe to call more than once.
   *
   * @param {{ graceMs?: number }} [options]
   */
  close({ graceMs = DEFAULT_GRACE_MS } = {}) {
    if (this.#closing) return this.#closing;

    if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
      throw new TypeError('CacheNestServer: graceMs must be a non-negative integer');
    }

    this.#closing = (async () => {
      if (this.server.listening) {
        await new Promise((resolve) => {
          let settled = false;
          let timer;

          const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };

          timer = setTimeout(() => {
            this.#warn(`graceful shutdown timed out after ${graceMs}ms; closing connections`);
            this.server.closeAllConnections?.();
          }, graceMs);
          timer.unref?.();

          this.server.close(done);
          this.server.closeIdleConnections?.();
        });
      }

      await Promise.allSettled([
        this.npmRouter?.close?.(),
        this.pypiRouter?.close?.(),
      ]);

      this.cache?.close?.();
      this.index?.close?.();
    })();

    return this.#closing;
  }

  async #dispatch(request, response) {
    const { pathname } = parseRequestTarget(request.url);

    if (pathname === '/health') {
      requireReadMethod(request.method);
      sendJson(response, 200, {
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        cacheBytes: this.index.totalSize(),
      }, { head: request.method === 'HEAD' });
      return;
    }

    if (pathname === '/metrics') {
      requireReadMethod(request.method);
      sendMetrics(response, this.metrics, { head: request.method === 'HEAD' });
      return;
    }

    const route = this.routes.find((candidate) => candidate.matches(pathname))
      ?? (this.npmRouter.matchesTarball(pathname) ? this.npmRouter : undefined);
    if (route === undefined) {
      throw new HttpError(404, 'Not found', { code: 'NOT_FOUND' });
    }

    return route.handle(request, response);
  }

  #handleError(error, request, response) {
    const statusCode = errorStatus(error);

    if (statusCode >= 500) {
      logLine(this.logger, 'error', `[server] ${error?.stack ?? error?.message ?? error}`);
    }

    if (response.writableEnded || response.destroyed) return;

    if (response.headersSent) {
      response.destroy();
      return;
    }

    const code = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR';
    const message = statusCode >= 500
      ? error?.publicMessage ?? 'Internal server error'
      : error?.message ?? 'Request failed';

    sendJson(
      response,
      statusCode,
      { error: code, message },
      {
        headers: error?.headers ?? {},
        head: String(request.method ?? '').toUpperCase() === 'HEAD',
      },
    );
  }

  #warn(message) {
    logLine(this.logger, 'warn', `[server] ${message}`);
  }
}

/**
 * @param {ConstructorParameters<typeof CacheNestServer>[0]} [options]
 * @returns {CacheNestServer}
 */
export function createServer(options) {
  return new CacheNestServer(options);
}
