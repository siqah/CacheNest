import { Readable } from 'node:stream';
import { Agent, interceptors, request } from 'undici';

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

const TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

export class UpstreamError extends Error {
  /**
   * @param {string} message Internal diagnostic message.
   * @param {{
   *   cause?: unknown,
   *   code?: string,
   *   statusCode?: number,
   *   publicMessage?: string,
   * }} [options]
   */
  constructor(message, {
    cause,
    code = 'UPSTREAM_UNAVAILABLE',
    statusCode = 502,
    publicMessage = 'The upstream registry could not be reached.',
  } = {}) {
    super(message, { cause });
    this.name = 'UpstreamError';
    this.code = code;
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
  }
}

function normalizeBaseUrl(value) {
  if (value === undefined || value === null || value === '') return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`UpstreamForwarder: invalid baseUrl "${value}"`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('UpstreamForwarder: baseUrl must use http or https');
  }

  if (url.username || url.password) {
    throw new TypeError('UpstreamForwarder: baseUrl must not contain credentials');
  }

  // Treat the base URL as a directory for relative request paths.
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  url.search = '';
  url.hash = '';

  return url;
}

function resolveRequestUrl(value, baseUrl) {
  if (value instanceof URL) value = value.toString();

  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('UpstreamForwarder: url must be a non-empty string or URL');
  }

  const raw = value.trim();

  if (baseUrl && raw.startsWith('//')) {
    throw new TypeError('UpstreamForwarder: protocol-relative URLs are not allowed');
  }

  let parsed;
  try {
    parsed = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
  } catch {
    throw new TypeError(
      baseUrl
        ? `UpstreamForwarder: invalid request URL "${raw}"`
        : `UpstreamForwarder: "${raw}" is not an absolute URL and no baseUrl was configured`,
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('UpstreamForwarder: request URL must use http or https');
  }

  // Fragments are never sent over HTTP and must not affect the upstream path.
  parsed.hash = '';

  return parsed;
}

function normalizeHeaderValue(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((item) => String(item));
  return String(value);
}

function appendHeader(result, name, value) {
  const normalized = normalizeHeaderValue(value);
  if (normalized === undefined) return;

  const key = name.toLowerCase();
  if (result[key] === undefined) {
    result[key] = normalized;
  } else if (Array.isArray(result[key])) {
    result[key].push(normalized);
  } else {
    result[key] = [result[key], normalized];
  }
}

function buildRequestHeaders(headers) {
  const result = {};

  if (headers === undefined || headers === null) {
    // No incoming headers to copy.
  } else if (typeof headers.entries === 'function') {
    for (const [name, value] of headers.entries()) {
      appendHeader(result, name, value);
    }
  } else if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new TypeError('UpstreamForwarder: headers array must contain [name, value] pairs');
      }
      appendHeader(result, pair[0], pair[1]);
    }
  } else if (typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers)) {
      appendHeader(result, name, value);
    }
  } else {
    throw new TypeError('UpstreamForwarder: headers must be an object, Headers, or array of pairs');
  }

  for (const name of Object.keys(result)) {
    if (
      HOP_BY_HOP_HEADERS.has(name)
      || name === 'host'
      || name === 'content-length'
    ) {
      delete result[name];
    }
  }

  // Force one canonical representation per URL. Requesting identity avoids
  // caching gzip/br variants under the same method+URL key.
  result['accept-encoding'] = 'identity';

  return result;
}

function redactUrl(url) {
  const copy = new URL(url.toString());
  copy.username = '';
  copy.password = '';
  copy.search = '';
  return copy.toString();
}

function classifyError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'UPSTREAM_REQUEST_FAILED';

  if (TIMEOUT_CODES.has(code)) {
    return {
      statusCode: 504,
      code: 'UPSTREAM_TIMEOUT',
      publicMessage: 'The upstream registry did not respond in time.',
    };
  }

  return {
    statusCode: 502,
    code: 'UPSTREAM_UNAVAILABLE',
    publicMessage: 'The upstream registry could not be reached.',
  };
}

function createErrorResponse(error) {
  const payload = JSON.stringify({
    error: error.code,
    message: error.publicMessage,
  });

  return {
    statusCode: error.statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(payload)),
      'cache-control': 'no-store',
    },
    body: Readable.from([payload]),
  };
}

/**
 * Undici-backed forwarder for the WAN side of CacheNest.
 *
 * `Cache` calls `forward()` on a miss. The returned response body is teed by
 * the cache: one branch goes to the client and one is written to BlobStore.
 * This class only owns the upstream request, redirects, timeouts, header
 * hygiene, and upstream error handling.
 */
export class UpstreamForwarder {
  #baseUrl;
  #dispatcher;
  #ownsDispatcher;
  #headersTimeout;
  #bodyTimeout;
  #throwOnError;
  #logger;
  #closed;

  /**
   * @param {{
   *   baseUrl?: string | URL,
   *   dispatcher?: import('undici').Dispatcher,
   *   dispatcherOptions?: import('undici').Agent.Options,
   *   maxRedirections?: number,
   *   headersTimeout?: number,
   *   bodyTimeout?: number,
   *   throwOnError?: boolean,
   *   logger?: { warn?: Function } | Function | null,
   * }} [options]
   */
  constructor({
    baseUrl,
    dispatcher,
    dispatcherOptions,
    maxRedirections = 5,
    headersTimeout = 30_000,
    bodyTimeout = 300_000,
    throwOnError = false,
    logger = console,
  } = {}) {
    if (!Number.isSafeInteger(maxRedirections) || maxRedirections < 0) {
      throw new TypeError('UpstreamForwarder: maxRedirections must be a non-negative integer');
    }

    if (!Number.isSafeInteger(headersTimeout) || headersTimeout <= 0) {
      throw new TypeError('UpstreamForwarder: headersTimeout must be a positive integer');
    }

    if (!Number.isSafeInteger(bodyTimeout) || bodyTimeout <= 0) {
      throw new TypeError('UpstreamForwarder: bodyTimeout must be a positive integer');
    }

    this.#baseUrl = normalizeBaseUrl(baseUrl);
    this.#headersTimeout = headersTimeout;
    this.#bodyTimeout = bodyTimeout;
    this.#throwOnError = Boolean(throwOnError);
    this.#logger = logger;
    this.#closed = false;

    if (dispatcher !== undefined) {
      if (!dispatcher || typeof dispatcher.dispatch !== 'function') {
        throw new TypeError('UpstreamForwarder: dispatcher must be an undici Dispatcher');
      }

      this.#dispatcher = maxRedirections > 0 && typeof dispatcher.compose === 'function'
        ? dispatcher.compose(interceptors.redirect({ maxRedirections }))
        : dispatcher;
      this.#ownsDispatcher = false;
    } else {
      const agent = new Agent(dispatcherOptions ?? {});
      this.#dispatcher = maxRedirections > 0
        ? agent.compose(interceptors.redirect({ maxRedirections }))
        : agent;
      this.#ownsDispatcher = true;
    }
  }

  /**
   * Fetch an upstream resource.
   *
   * @param {{
   *   method?: string,
   *   url: string | URL,
   *   headers?: Record<string, unknown> | Headers | Array<[string, unknown]>,
   *   signal?: AbortSignal,
   * }} input
   * @returns {Promise<{
   *   statusCode: number,
   *   headers: Record<string, string | string[] | undefined>,
   *   body: ReadableStream | null,
   * }>}
   */
  async forward({ method = 'GET', url, headers, signal } = {}) {
    if (this.#closed) {
      throw new Error('UpstreamForwarder: forwarder is closed');
    }

    if (typeof method !== 'string' || method.trim() === '') {
      throw new TypeError('UpstreamForwarder: method must be a non-empty string');
    }

    const target = resolveRequestUrl(url, this.#baseUrl);
    const requestMethod = method.trim().toUpperCase();
    const requestHeaders = buildRequestHeaders(headers);

    try {
      const response = await request(target, {
        method: requestMethod,
        headers: requestHeaders,
        headersTimeout: this.#headersTimeout,
        bodyTimeout: this.#bodyTimeout,
        dispatcher: this.#dispatcher,
        signal,
      });

      return {
        statusCode: response.statusCode,
        headers: response.headers,
        body: response.body,
      };
    } catch (error) {
      // Client disconnects and caller cancellations are not upstream failures.
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }

      const classification = classifyError(error);
      const upstreamError = new UpstreamError(
        `Upstream ${requestMethod} ${redactUrl(target)} failed: ${error?.message ?? String(error)}`,
        {
          cause: error,
          code: classification.code,
          statusCode: classification.statusCode,
          publicMessage: classification.publicMessage,
        },
      );

      this.#warn(
        `upstream request failed for ${requestMethod} ${redactUrl(target)}`,
        upstreamError,
      );

      if (this.#throwOnError) throw upstreamError;
      return createErrorResponse(upstreamError);
    }
  }

  /**
   * Close the internally created undici Agent. An injected dispatcher is left
   * untouched. Safe to call more than once.
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;

    if (this.#ownsDispatcher && this.#dispatcher) {
      const dispatcher = this.#dispatcher;
      this.#dispatcher = undefined;
      await dispatcher.close();
    }
  }

  #warn(message, error) {
    const logger = this.#logger;
    if (!logger) return;

    const text = `[upstream] ${message}`;
    if (typeof logger.warn === 'function') {
      logger.warn(text, error);
    } else if (typeof logger === 'function') {
      logger(text, error);
    }
  }
}

/**
 * @param {ConstructorParameters<typeof UpstreamForwarder>[0]} [options]
 * @returns {UpstreamForwarder}
 */
export function createForwarder(options) {
  return new UpstreamForwarder(options);
}

export default createForwarder;
