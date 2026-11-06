const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

function requestPath(rawUrl) {
  const value = String(rawUrl ?? '/');
  const queryIndex = value.indexOf('?');
  return queryIndex === -1 ? value : value.slice(0, queryIndex);
}

function asBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function contentLength(response) {
  if (typeof response?.getHeader !== 'function') return 0;

  const value = response.getHeader('content-length');
  const first = Array.isArray(value) ? value[0] : value;
  return asBytes(Number(first));
}

/**
 * In-process counters for cache effectiveness and downstream bandwidth.
 *
 * Counters are intentionally lock-free: Node handles requests on a single
 * event-loop thread, so ordinary numeric increments are atomic between awaits.
 */
export class Metrics {
  #requests = 0;
  #cacheHits = 0;
  #cacheMisses = 0;
  #bandwidthServedBytes = 0;
  #bandwidthSavedBytes = 0;

  /**
   * Count one inbound request. The /metrics scrape endpoint is normally
   * excluded by createMetricsMiddleware().
   */
  recordRequest() {
    this.#requests += 1;
  }

  /**
   * Record the result of a cache lookup and the bytes sent to the client.
   *
   * @param {{ hit: boolean, bytes?: number }} result
   */
  recordCacheResult({ hit, bytes = 0 } = {}) {
    if (typeof hit !== 'boolean') {
      throw new TypeError('Metrics: cache result must include a boolean hit flag');
    }

    const served = asBytes(bytes);
    this.#bandwidthServedBytes += served;

    if (hit) {
      this.#cacheHits += 1;
      this.#bandwidthSavedBytes += served;
    } else {
      this.#cacheMisses += 1;
    }
  }

  /**
   * @returns {{
   *   requests: number,
   *   cacheHits: number,
   *   cacheMisses: number,
   *   bandwidthServedBytes: number,
   *   bandwidthSavedBytes: number,
   *   uptimeSeconds: number,
   * }}
   */
  snapshot() {
    return {
      requests: this.#requests,
      cacheHits: this.#cacheHits,
      cacheMisses: this.#cacheMisses,
      bandwidthServedBytes: this.#bandwidthServedBytes,
      bandwidthSavedBytes: this.#bandwidthSavedBytes,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  /**
   * Render Prometheus text exposition format.
   *
   * @returns {string}
   */
  render() {
    const snapshot = this.snapshot();

    return [
      '# HELP cachenest_requests_total Total HTTP requests handled by CacheNest.',
      '# TYPE cachenest_requests_total counter',
      `cachenest_requests_total ${snapshot.requests}`,
      '# HELP cachenest_cache_hits_total Cache lookups served from local disk.',
      '# TYPE cachenest_cache_hits_total counter',
      `cachenest_cache_hits_total ${snapshot.cacheHits}`,
      '# HELP cachenest_cache_misses_total Cache lookups that required an upstream fetch.',
      '# TYPE cachenest_cache_misses_total counter',
      `cachenest_cache_misses_total ${snapshot.cacheMisses}`,
      '# HELP cachenest_bandwidth_served_bytes_total Response body bytes sent to clients.',
      '# TYPE cachenest_bandwidth_served_bytes_total counter',
      `cachenest_bandwidth_served_bytes_total ${snapshot.bandwidthServedBytes}`,
      '# HELP cachenest_bandwidth_saved_bytes_total Response bytes served from cache instead of upstream.',
      '# TYPE cachenest_bandwidth_saved_bytes_total counter',
      `cachenest_bandwidth_saved_bytes_total ${snapshot.bandwidthSavedBytes}`,
      '# HELP cachenest_uptime_seconds Process uptime in seconds.',
      '# TYPE cachenest_uptime_seconds gauge',
      `cachenest_uptime_seconds ${snapshot.uptimeSeconds}`,
      '',
    ].join('\n');
  }
}

/**
 * HTTP middleware that counts requests and records cache outcomes returned by
 * the route layer. /metrics is excluded by default to avoid self-counting
 * Prometheus scrapes.
 *
 * @param {{
 *   metrics: Metrics,
 *   excludePaths?: string[],
 * }} options
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, next: Function) => Promise<unknown>}
 */
export function createMetricsMiddleware({ metrics, excludePaths = ['/metrics'] } = {}) {
  if (!metrics || typeof metrics.recordRequest !== 'function' || typeof metrics.recordCacheResult !== 'function') {
    throw new TypeError('Metrics: metrics must provide recordRequest() and recordCacheResult()');
  }

  if (!Array.isArray(excludePaths)) {
    throw new TypeError('Metrics: excludePaths must be an array of path strings');
  }

  const excluded = new Set(excludePaths);

  return async function metricsMiddleware(request, response, next) {
    const path = requestPath(request.url);
    const shouldCount = !excluded.has(path);
    if (shouldCount) metrics.recordRequest();

    const result = await next();

    if (shouldCount && result !== null && typeof result === 'object' && typeof result.hit === 'boolean') {
      const bytes = String(request.method ?? 'GET').toUpperCase() === 'HEAD'
        ? 0
        : Number.isFinite(result.size) && result.size > 0
          ? result.size
          : contentLength(response);

      metrics.recordCacheResult({ hit: result.hit, bytes });
    }

    return result;
  };
}

/**
 * Write the Prometheus exposition response.
 *
 * @param {import('node:http').ServerResponse} response
 * @param {Metrics} metrics
 * @param {{ head?: boolean }} [options]
 */
export function sendMetrics(response, metrics, { head = false } = {}) {
  if (!metrics || typeof metrics.render !== 'function') {
    throw new TypeError('Metrics: metrics must provide render()');
  }

  if (response.writableEnded || response.destroyed) return;

  const body = metrics.render();
  response.writeHead(200, {
    'content-type': PROMETHEUS_CONTENT_TYPE,
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(head ? undefined : body);
}
