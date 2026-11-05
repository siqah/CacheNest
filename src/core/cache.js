import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import config from '../config.js';
import createCacheKey from '../utils/hash.js';
import IndexDB from './index-db.js';
import BlobStore from './store.js';
import Eviction from './eviction.js';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const UNCACHEABLE_CACHE_CONTROL = /(?:^|,)\s*(?:no-store|no-cache|private)\b/i;
const CLIENT_DISCONNECT = 'CACHENEST_CLIENT_DISCONNECT';

function clientDisconnectError(message) {
  const error = new Error(message);
  error.code = CLIENT_DISCONNECT;
  return error;
}

function isClientDisconnect(error, signal) {
  return Boolean(
    signal?.reason?.code === CLIENT_DISCONNECT
      || error?.code === CLIENT_DISCONNECT,
  );
}

function createRequestSignal(request, response, externalSignal) {
  const controller = new AbortController();

  const abort = (message) => {
    if (!controller.signal.aborted) {
      controller.abort(clientDisconnectError(message));
    }
  };

  const onAborted = () => abort('Client aborted the request');
  const onClose = () => {
    if (!response.writableFinished && !response.writableEnded) {
      abort('Client closed the connection');
    }
  };

  request.once?.('aborted', onAborted);
  response.once?.('close', onClose);

  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;

  return {
    signal,
    cleanup() {
      request.off?.('aborted', onAborted);
      response.off?.('close', onClose);
    },
  };
}

function appendHeader(result, name, value) {
  if (value === undefined || value === null) return;

  const key = name.toLowerCase();
  if (result[key] === undefined) {
    result[key] = value;
  } else if (Array.isArray(result[key])) {
    result[key].push(value);
  } else {
    result[key] = [result[key], value];
  }
}

function normalizeHeaders(headers) {
  if (headers === undefined || headers === null) return {};

  const result = {};

  if (typeof headers.entries === 'function') {
    for (const [name, value] of headers.entries()) {
      appendHeader(result, name, value);
    }

    if (typeof headers.getSetCookie === 'function') {
      const cookies = headers.getSetCookie();
      if (cookies.length > 0) result['set-cookie'] = cookies;
    }

    return result;
  }

  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new TypeError('Cache: upstream headers array must contain [name, value] pairs');
      }
      appendHeader(result, pair[0], pair[1]);
    }
    return result;
  }

  if (typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers)) {
      appendHeader(result, name, value);
    }
    return result;
  }

  throw new TypeError(
    'Cache: upstream headers must be an object, a Headers instance, or an array of pairs',
  );
}

function headerValue(headers, name) {
  const value = headers[name.toLowerCase()];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function requestHeader(headers, name) {
  if (headers === undefined || headers === null) return undefined;

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }

  return undefined;
}

function sanitizeHeaders(headers, { forStorage = false } = {}) {
  const result = {};

  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();

    if (HOP_BY_HOP_HEADERS.has(key)) continue;
    if (forStorage && (key === 'set-cookie' || key === 'date')) continue;

    result[key] = value;
  }

  return result;
}

function writeResponseHead(response, statusCode, headers, contentLength) {
  const outgoing = sanitizeHeaders(headers);

  if (contentLength !== undefined) {
    outgoing['content-length'] = String(contentLength);
  }

  response.writeHead(statusCode, outgoing);
}

function isWebReadableStream(value) {
  return typeof ReadableStream !== 'undefined' && value instanceof ReadableStream;
}

function toNodeReadable(body) {
  if (body instanceof Readable) return body;
  if (isWebReadableStream(body)) return Readable.fromWeb(body);

  if (body !== null && body !== undefined && typeof body[Symbol.asyncIterator] === 'function') {
    return Readable.from(body);
  }

  throw new TypeError(
    'Cache: upstream body must be a Readable, ReadableStream, or async iterable',
  );
}

function toWebStream(body) {
  if (isWebReadableStream(body)) return body;
  if (body instanceof Readable) return Readable.toWeb(body);
  if (body !== null && body !== undefined && typeof body[Symbol.asyncIterator] === 'function') {
    return Readable.toWeb(Readable.from(body));
  }

  throw new TypeError(
    'Cache: upstream body must be a Readable, ReadableStream, or async iterable',
  );
}

function discardBody(body) {
  if (body === null || body === undefined) return;

  try {
    if (typeof body.destroy === 'function') {
      // Destroying an undici body aborts the request and emits an error.
      body.once?.('error', () => {});
      body.destroy();
    } else if (typeof body.cancel === 'function') {
      Promise.resolve(body.cancel()).catch(() => {});
    }
  } catch {
    // Best-effort cleanup only.
  }
}

function normalizeStatusCode(value) {
  const statusCode = Number(value);

  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    throw new TypeError(`Cache: invalid upstream status code "${value}"`);
  }

  return statusCode;
}

function assertForwarder(forwarder) {
  if (typeof forwarder === 'function') return;
  if (forwarder !== null && typeof forwarder === 'object' && typeof forwarder.forward === 'function') {
    return;
  }

  throw new TypeError(
    'Cache: forwarder must be a function or an object with a forward() method',
  );
}

function resolveForwarder(forwarder) {
  assertForwarder(forwarder);
  return typeof forwarder === 'function' ? forwarder : forwarder.forward.bind(forwarder);
}

/**
 * Coordinates cache hits, upstream fetches, blob writes, indexing, and eviction.
 *
 * A forwarder receives `{ method, url, headers, signal }` and must resolve to
 * `{ statusCode | status, headers, body }`, where body is a Node readable, web
 * ReadableStream, or async iterable.
 */
export class Cache {
  #ownsIndex;

  /**
   * @param {{
   *   index?: import('./index-db.js').IndexDB,
   *   store?: import('./store.js').BlobStore,
   *   eviction?: import('./eviction.js').Eviction,
   *   forwarder?: Function | { forward: Function },
   *   maxCacheBytes?: number,
   *   logger?: { warn?: Function } | Function | null,
   * }} [options]
   */
  constructor({
    index,
    store,
    eviction,
    forwarder,
    maxCacheBytes = config.maxCacheBytes,
    logger = console,
  } = {}) {
    this.index = index ?? new IndexDB();
    this.#ownsIndex = index === undefined;
    this.store = store ?? new BlobStore();
    this.logger = logger;

    if (forwarder !== undefined) assertForwarder(forwarder);
    this.forwarder = forwarder ?? null;

    this.eviction = eviction ?? new Eviction({
      index: this.index,
      store: this.store,
      maxBytes: maxCacheBytes,
      logger,
    });
  }

  /**
   * Serve a request from cache, or fetch it upstream and fill the cache.
   *
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   * @param {{
   *   key?: string,
   *   url?: string,
   *   forwarder?: Function | { forward: Function },
   *   signal?: AbortSignal,
   * }} [options]
   * @returns {Promise<{
   *   hit: boolean,
   *   cached: boolean,
   *   key: string,
   *   statusCode?: number,
   *   entry?: import('./index-db.js').CacheEntry,
   *   size?: number,
   * }>}
   */
  async handle(request, response, options = {}) {
    if (request === null || typeof request !== 'object') {
      throw new TypeError('Cache: request must be an IncomingMessage-like object');
    }

    if (response === null || typeof response !== 'object' || typeof response.writeHead !== 'function') {
      throw new TypeError('Cache: response must be a ServerResponse-like object');
    }

    if (response.writableEnded) {
      throw new Error('Cache: response has already been sent');
    }

    const method = String(request.method ?? 'GET').toUpperCase();
    const url = options.url ?? request.url;

    if (typeof url !== 'string' || url.trim() === '') {
      throw new TypeError('Cache: url must be a non-empty string');
    }

    const key = options.key ?? createCacheKey(method, url);
    if (typeof key !== 'string' || key.trim() === '') {
      throw new TypeError('Cache: key must be a non-empty string');
    }

    options.signal?.throwIfAborted();

    const { signal, cleanup } = createRequestSignal(request, response, options.signal);

    try {
      const hit = await this.#handleHit(key, method, response, signal);
      if (hit !== null) return hit;

      return await this.#handleMiss({
        key,
        method,
        url,
        request,
        response,
        forwarder: options.forwarder ?? this.forwarder,
        signal,
      });
    } finally {
      cleanup();
    }
  }

  /**
   * Remove a blob and its index entry.
   *
   * @param {string} key
   */
  async invalidate(key) {
    await this.#invalidate(key);
  }

  /**
   * Close the SQLite connection if this instance created it.
   */
  close() {
    if (this.#ownsIndex) this.index.close();
  }

  async #handleHit(key, method, response, signal) {
    const entry = this.index.get(key);
    if (entry === null) return null;

    const blob = await this.store.openRead(key);

    if (blob === null) {
      this.#warn(`index entry "${key}" has no blob; invalidating and treating as miss`);
      await this.#invalidate(key);
      return null;
    }

    if (blob.size !== entry.size) {
      this.#warn(
        `blob size mismatch for "${key}" (index ${entry.size}, disk ${blob.size}); invalidating and treating as miss`,
      );
      blob.stream.destroy();
      await this.#invalidate(key);
      return null;
    }

    try {
      this.index.touch(key);
      writeResponseHead(response, 200, entry.headers, blob.size);
    } catch (error) {
      blob.stream.destroy();
      throw error;
    }

    if (method === 'HEAD') {
      blob.stream.destroy();
      response.end();
      return { hit: true, cached: true, key, entry, size: blob.size };
    }

    try {
      await pipeline(blob.stream, response);
    } catch (error) {
      if (!isClientDisconnect(error, signal)) throw error;
    }

    return { hit: true, cached: true, key, entry, size: blob.size };
  }

  async #handleMiss({ key, method, url, request, response, forwarder, signal }) {
    const forward = resolveForwarder(forwarder);

    const upstream = await forward({
      method,
      url,
      headers: { ...(request.headers ?? {}) },
      signal,
    });

    if (upstream === null || typeof upstream !== 'object') {
      throw new TypeError('Cache: forwarder must resolve to an upstream response object');
    }

    const statusCode = normalizeStatusCode(upstream.statusCode ?? upstream.status);
    const headers = normalizeHeaders(upstream.headers);
    const body = upstream.body ?? null;
    const hasBody = body !== null && method !== 'HEAD';

    if (!this.#shouldCache(method, statusCode, headers, body, request)) {
      try {
        writeResponseHead(response, statusCode, headers);
      } catch (error) {
        discardBody(body);
        throw error;
      }

      if (!hasBody) {
        discardBody(body);
        response.end();
        return { hit: false, cached: false, key, statusCode };
      }

      try {
        await pipeline(toNodeReadable(body), response, { signal });
      } catch (error) {
        if (!isClientDisconnect(error, signal)) throw error;
      }

      return { hit: false, cached: false, key, statusCode };
    }

    const [clientBody, cacheBody] = toWebStream(body).tee();
    const storedHeaders = sanitizeHeaders(headers, { forStorage: true });

    try {
      writeResponseHead(response, statusCode, headers);
    } catch (error) {
      await Promise.allSettled([clientBody.cancel(error), cacheBody.cancel(error)]);
      throw error;
    }

    const writePromise = this.store
      .write(key, cacheBody, { signal })
      .then((result) => ({ ok: true, result }))
      .catch((error) => {
        if (!signal.aborted) {
          this.#warn(`failed to write blob "${key}"`, error);
        }
        return { ok: false, error };
      });

    let clientError = null;
    try {
      await pipeline(Readable.fromWeb(clientBody), response, { signal });
    } catch (error) {
      clientError = error;
    }

    const writeOutcome = await writePromise;
    let entry = null;

    if (writeOutcome.ok) {
      try {
        entry = this.index.set({
          key,
          size: writeOutcome.result.size,
          headers: storedHeaders,
        });

        try {
          await this.eviction.enforce();
        } catch (error) {
          this.#warn('eviction failed', error);
        }
      } catch (error) {
        this.#warn(`failed to index blob "${key}"; removing blob`, error);
        await this.store.delete(key).catch((cleanupError) => {
          this.#warn(`failed to remove unindexed blob "${key}"`, cleanupError);
        });
      }
    }

    if (clientError !== null && !isClientDisconnect(clientError, signal)) {
      throw clientError;
    }

    if (entry !== null) {
      return {
        hit: false,
        cached: true,
        key,
        statusCode,
        entry,
        size: writeOutcome.result.size,
      };
    }

    return { hit: false, cached: false, key, statusCode };
  }

  #shouldCache(method, statusCode, headers, body, request) {
    if (method !== 'GET') return false;
    if (statusCode !== 200) return false;
    if (body === null || body === undefined) return false;

    // A shared cache must not store responses to authenticated requests.
    if (requestHeader(request.headers, 'authorization') !== undefined) return false;

    const cacheControl = headerValue(headers, 'cache-control');
    if (cacheControl !== undefined && UNCACHEABLE_CACHE_CONTROL.test(cacheControl)) {
      return false;
    }

    const vary = headerValue(headers, 'vary');
    if (vary !== undefined && vary.split(',').some((value) => value.trim() === '*')) {
      return false;
    }

    return true;
  }

  async #invalidate(key) {
    try {
      this.index.delete(key);
    } catch (error) {
      this.#warn(`failed to delete index entry "${key}"`, error);
    }

    try {
      await this.store.delete(key);
    } catch (error) {
      this.#warn(`failed to delete blob "${key}"`, error);
    }
  }

  #warn(message, error) {
    const logger = this.logger;
    if (!logger) return;

    const text = `[cache] ${message}`;
    if (typeof logger.warn === 'function') {
      logger.warn(text, error);
    } else if (typeof logger === 'function') {
      logger(text, error);
    }
  }
}

export default Cache;
