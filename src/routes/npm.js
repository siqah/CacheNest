import config from '../config.js';
import createCacheKey from '../utils/hash.js';
import UpstreamForwarder from '../upstream/forward.js';
import {
  HttpError,
  assertRelativePath,
  joinUrlPath,
  matchesPrefix,
  normalizePrefix,
  parseRequestTarget,
  requireReadMethod,
  stripPrefix,
} from './common.js';

function normalizeUpstream(value) {
  const raw = value instanceof URL ? value.toString() : value;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`NpmRouter: invalid upstream URL "${raw}"`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('NpmRouter: upstream URL must use http or https');
  }

  if (url.username || url.password) {
    throw new TypeError('NpmRouter: upstream URL must not contain credentials');
  }

  url.hash = '';
  url.search = '';

  return url;
}

function assertForwarder(forwarder) {
  if (typeof forwarder === 'function') return;
  if (forwarder !== null && typeof forwarder === 'object' && typeof forwarder.forward === 'function') {
    return;
  }

  throw new TypeError(
    'NpmRouter: forwarder must be a function or an object with a forward() method',
  );
}

/**
 * Handles npm registry traffic mounted at /npm.
 */
export class NpmRouter {
  #ownsForwarder;

  /**
   * @param {{
   *   cache: import('../core/cache.js').Cache,
   *   upstream?: string | URL,
   *   prefix?: string,
   *   forwarder?: Function | { forward: Function },
   *   logger?: { warn?: Function } | Function | null,
   * }} options
   */
  constructor({
    cache,
    upstream = config.upstream.npm,
    prefix = '/npm',
    forwarder,
    logger = console,
  } = {}) {
    if (!cache || typeof cache.handle !== 'function') {
      throw new TypeError('NpmRouter: cache must be a Cache instance');
    }

    this.cache = cache;
    this.prefix = normalizePrefix(prefix);

    const upstreamUrl = normalizeUpstream(upstream);
    this.upstream = upstreamUrl.toString().replace(/\/+$/, '');
    this.basePath = upstreamUrl.pathname;

    if (forwarder !== undefined) assertForwarder(forwarder);
    this.forwarder = forwarder ?? new UpstreamForwarder({
      baseUrl: this.upstream,
      logger,
    });
    this.#ownsForwarder = forwarder === undefined;
    this.logger = logger;
  }

  /**
   * @param {string} pathname
   * @returns {boolean}
   */
  matches(pathname) {
    return matchesPrefix(pathname, this.prefix);
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async handle(request, response) {
    const method = requireReadMethod(request.method);
    const { pathname, search, keyPath } = parseRequestTarget(request.url);
    const rest = stripPrefix(pathname, this.prefix);

    if (rest === null) {
      throw new HttpError(404, 'Not found', { code: 'NOT_FOUND' });
    }

    assertRelativePath(rest);

    // The upstream base may contain a path (for self-hosted registries), so
    // join it explicitly rather than letting WHATWG URL replace it.
    const targetPath = joinUrlPath(this.basePath, rest);
    const target = `${targetPath}${search}`;
    const key = createCacheKey(method, keyPath);

    return this.cache.handle(request, response, {
      key,
      url: target,
      forwarder: this.forwarder,
    });
  }

  /**
   * Release the forwarder when this router created it.
   */
  async close() {
    if (!this.#ownsForwarder || !this.forwarder || typeof this.forwarder.close !== 'function') {
      return;
    }

    const forwarder = this.forwarder;
    this.forwarder = null;
    await forwarder.close();
  }
}

/**
 * @param {ConstructorParameters<typeof NpmRouter>[0]} options
 * @returns {NpmRouter}
 */
export function createNpmRouter(options) {
  return new NpmRouter(options);
}

export default createNpmRouter;
