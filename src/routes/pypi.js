import { Readable } from 'node:stream';

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

const DEFAULT_FILES_UPSTREAM = 'https://files.pythonhosted.org';
const MAX_REWRITE_BYTES = 16 * 1024 * 1024;
const URL_ATTRIBUTE_PATTERN = /\b(href|src)\s*=\s*(["'])(.*?)\2/gi;
const PYPI_FILES_DOMAIN = '/files.pythonhosted.org';

function normalizeUpstream(value, label) {
  const raw = value instanceof URL ? value.toString() : value;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`PypiRouter: invalid ${label} URL "${raw}"`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`PypiRouter: ${label} URL must use http or https`);
  }

  if (url.username || url.password) {
    throw new TypeError(`PypiRouter: ${label} URL must not contain credentials`);
  }

  url.hash = '';
  url.search = '';

  return url;
}

function normalizeBasePath(pathname) {
  return pathname === '/' ? '' : pathname.replace(/\/+$/, '');
}

function defaultFilesUpstream(pypiUrl) {
  if (pypiUrl.hostname === 'pypi.org' || pypiUrl.hostname === 'www.pypi.org') {
    return DEFAULT_FILES_UPSTREAM;
  }

  return pypiUrl.origin;
}

function assertForwarder(forwarder, label) {
  if (typeof forwarder === 'function') return;
  if (forwarder !== null && typeof forwarder === 'object' && typeof forwarder.forward === 'function') {
    return;
  }

  throw new TypeError(
    `PypiRouter: ${label} must be a function or an object with a forward() method`,
  );
}

function getHeader(headers, name) {
  if (headers === undefined || headers === null) return undefined;

  if (typeof headers.get === 'function') {
    return headers.get(name) ?? undefined;
  }

  const key = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() !== key) continue;
    return Array.isArray(value) ? value.join(', ') : String(value);
  }

  return undefined;
}

function cloneHeaders(headers) {
  if (headers && typeof headers.entries === 'function') return new Headers(headers);
  return { ...(headers ?? {}) };
}

function setHeader(headers, name, value) {
  if (typeof headers.set === 'function') {
    headers.set(name, value);
    return;
  }

  deleteHeader(headers, name);
  headers[name.toLowerCase()] = value;
}

function deleteHeader(headers, name) {
  if (typeof headers.delete === 'function') {
    headers.delete(name);
    return;
  }

  const key = name.toLowerCase();
  for (const headerName of Object.keys(headers)) {
    if (headerName.toLowerCase() === key) delete headers[headerName];
  }
}

function isWebReadableStream(value) {
  return typeof ReadableStream !== 'undefined' && value instanceof ReadableStream;
}

function toWebStream(body) {
  if (isWebReadableStream(body)) return body;
  if (body instanceof Readable) return Readable.toWeb(body);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    });
  }

  if (body !== null && body !== undefined && typeof body[Symbol.asyncIterator] === 'function') {
    return Readable.toWeb(Readable.from(body));
  }

  throw new TypeError('PypiRouter: upstream body is not a readable stream');
}

function toBuffer(value) {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

async function readBody(body, limit) {
  const reader = body.getReader();
  const chunks = [];
  let size = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { buffer: Buffer.concat(chunks, size) };

      const chunk = toBuffer(value);
      chunks.push(chunk);
      size += chunk.length;

      if (size > limit) {
        return { tooLarge: true, chunks, reader };
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}

function combineReadable(chunks, reader) {
  return Readable.from((async function* replay() {
    try {
      for (const chunk of chunks) yield chunk;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield toBuffer(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  })());
}

/**
 * Maps a URL pathname below a configured base path and returns the remaining
 * suffix, or null when the path is outside that base.
 */
function pathSuffix(pathname, basePath) {
  if (basePath === '') return pathname;
  if (pathname === basePath) return '/';
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  return null;
}

function isPathOrChild(pathname, base) {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * Handles PyPI Simple API and package-file traffic mounted at /pypi.
 *
 * Supported shapes:
 *   /pypi/simple/<project>/     -> UPSTREAM_PYPI + <project>/
 *   /pypi/<project>/            -> UPSTREAM_PYPI + <project>/
 *   /pypi/files/<path>          -> files.pythonhosted.org/<path>
 *   /pypi/packages/<path>       -> files.pythonhosted.org/packages/<path>
 *
 * Simple API JSON and HTML links to files.pythonhosted.org are rewritten to
 * root-relative /pypi/files/... URLs so pip's downloads also pass through the
 * cache.
 */
export class PypiRouter {
  #ownsSimpleForwarder;
  #ownsFilesForwarder;

  /**
   * @param {{
   *   cache: import('../core/cache.js').Cache,
   *   upstream?: string | URL,
   *   filesUpstream?: string | URL,
   *   prefix?: string,
   *   simpleForwarder?: Function | { forward: Function },
   *   filesForwarder?: Function | { forward: Function },
   *   logger?: { warn?: Function } | Function | null,
   * }} options
   */
  constructor({
    cache,
    upstream = config.upstream.pypi,
    filesUpstream,
    prefix = '/pypi',
    simpleForwarder,
    filesForwarder,
    logger = console,
  } = {}) {
    if (!cache || typeof cache.handle !== 'function') {
      throw new TypeError('PypiRouter: cache must be a Cache instance');
    }

    this.cache = cache;
    this.prefix = normalizePrefix(prefix);
    this.logger = logger;

    const pypiUrl = normalizeUpstream(upstream, 'upstream');
    const filesUrl = normalizeUpstream(
      filesUpstream ?? defaultFilesUpstream(pypiUrl),
      'filesUpstream',
    );

    this.pypiOrigin = pypiUrl.origin;
    this.simpleBasePath = normalizeBasePath(pypiUrl.pathname);
    this.filesOrigin = filesUrl.origin;
    this.filesBasePath = normalizeBasePath(filesUrl.pathname);

    if (simpleForwarder !== undefined) assertForwarder(simpleForwarder, 'simpleForwarder');
    if (filesForwarder !== undefined) assertForwarder(filesForwarder, 'filesForwarder');

    try {
      this.simpleForwarder = simpleForwarder ?? new UpstreamForwarder({
        baseUrl: pypiUrl.toString(),
        logger,
      });
      this.#ownsSimpleForwarder = simpleForwarder === undefined;

      this.filesForwarder = filesForwarder ?? new UpstreamForwarder({
        baseUrl: filesUrl.toString(),
        logger,
      });
      this.#ownsFilesForwarder = filesForwarder === undefined;
    } catch (error) {
      if (this.#ownsSimpleForwarder && this.simpleForwarder?.close) {
        void this.simpleForwarder.close().catch(() => {});
      }
      throw error;
    }

    // Cache calls this adapter for Simple API responses so link rewriting is
    // applied before the body is teed into the blob store.
    this.simpleProxy = {
      forward: (input) => this.#forwardSimple(input),
    };
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

    const target = this.#resolveTarget(rest);
    const key = createCacheKey(method, keyPath);
    const forwarder = target.kind === 'files' ? this.filesForwarder : this.simpleProxy;

    return this.cache.handle(request, response, {
      key,
      url: `${target.path}${search}`,
      forwarder,
    });
  }

  async #forwardSimple(input) {
    const forward = typeof this.simpleForwarder === 'function'
      ? this.simpleForwarder
      : this.simpleForwarder.forward.bind(this.simpleForwarder);

    const upstream = await forward(input);
    return this.#rewriteSimpleResponse(upstream);
  }

  #resolveTarget(rest) {
    if (isPathOrChild(rest, '/files')) {
      const tail = rest.slice('/files'.length) || '/';
      return { kind: 'files', path: joinUrlPath(this.filesBasePath, tail) };
    }

    if (isPathOrChild(rest, '/packages')) {
      return { kind: 'files', path: joinUrlPath(this.filesBasePath, rest) };
    }

    if (isPathOrChild(rest, PYPI_FILES_DOMAIN)) {
      const tail = rest.slice(PYPI_FILES_DOMAIN.length) || '/';
      return { kind: 'files', path: joinUrlPath(this.filesBasePath, tail) };
    }

    if (isPathOrChild(rest, '/simple')) {
      if (this.simpleBasePath.endsWith('/simple')) {
        const tail = rest.slice('/simple'.length) || '/';
        return { kind: 'simple', path: joinUrlPath(this.simpleBasePath, tail) };
      }

      return { kind: 'simple', path: joinUrlPath(this.simpleBasePath, rest) };
    }

    return { kind: 'simple', path: joinUrlPath(this.simpleBasePath, rest) };
  }

  async #rewriteSimpleResponse(upstream) {
    if (upstream === null || typeof upstream !== 'object') return upstream;

    const statusCode = Number(upstream.statusCode ?? upstream.status);
    if (statusCode !== 200) return upstream;

    const headers = upstream.headers;
    const contentType = (getHeader(headers, 'content-type') ?? '').toLowerCase();
    const isJson = contentType.includes('json');
    const isHtml = contentType.includes('text/html');

    if (!isJson && !isHtml) return upstream;

    const encoding = getHeader(headers, 'content-encoding');
    if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') {
      return upstream;
    }

    if (upstream.body === null || upstream.body === undefined) return upstream;

    const declaredLength = Number(getHeader(headers, 'content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REWRITE_BYTES) {
      return upstream;
    }

    let body;
    try {
      body = toWebStream(upstream.body);
    } catch (error) {
      this.#warn('unable to read Simple API body for link rewriting', error);
      return upstream;
    }

    const read = await readBody(body, MAX_REWRITE_BYTES);

    if (read.tooLarge) {
      return {
        ...upstream,
        body: combineReadable(read.chunks, read.reader),
      };
    }

    const original = read.buffer.toString('utf8');
    let rewritten;

    try {
      rewritten = isJson
        ? this.#rewriteJson(original)
        : this.#rewriteHtml(original);
    } catch (error) {
      this.#warn('unable to rewrite Simple API links', error);
      return { ...upstream, body: Readable.from([read.buffer]) };
    }

    if (rewritten === original) {
      return { ...upstream, body: Readable.from([read.buffer]) };
    }

    const updatedHeaders = cloneHeaders(headers);
    setHeader(updatedHeaders, 'content-length', String(Buffer.byteLength(rewritten)));

    // The representation changed, so upstream validators no longer apply.
    deleteHeader(updatedHeaders, 'etag');
    deleteHeader(updatedHeaders, 'content-md5');
    deleteHeader(updatedHeaders, 'digest');

    return {
      ...upstream,
      headers: updatedHeaders,
      body: Readable.from([rewritten]),
    };
  }

  #rewriteJson(text) {
    const document = JSON.parse(text);
    if (document === null || typeof document !== 'object' || !Array.isArray(document.files)) {
      return text;
    }

    for (const file of document.files) {
      if (file !== null && typeof file === 'object' && typeof file.url === 'string') {
        file.url = this.#rewriteUrl(file.url);
      }
    }

    return JSON.stringify(document);
  }

  #rewriteHtml(html) {
    return html.replace(
      URL_ATTRIBUTE_PATTERN,
      (match, attribute, quote, value) => {
        const rewritten = this.#rewriteUrl(value);
        if (rewritten === value) return match;
        return `${attribute}=${quote}${rewritten}${quote}`;
      },
    );
  }

  #rewriteUrl(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return value;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return value;

    if (url.origin === this.filesOrigin) {
      const suffix = pathSuffix(url.pathname, this.filesBasePath);
      if (suffix === null) return value;

      return `${this.prefix}/files${suffix}${url.search}${url.hash}`;
    }

    if (url.origin === this.pypiOrigin) {
      const suffix = pathSuffix(url.pathname, this.simpleBasePath);
      if (suffix === null) return value;

      if (this.simpleBasePath.endsWith('/simple')) {
        return `${this.prefix}/simple${suffix}${url.search}${url.hash}`;
      }

      return `${this.prefix}${suffix}${url.search}${url.hash}`;
    }

    return value;
  }

  /**
   * Release forwarders created by this router.
   */
  async close() {
    const closers = [];

    if (this.#ownsSimpleForwarder && typeof this.simpleForwarder?.close === 'function') {
      closers.push(this.simpleForwarder.close());
    }

    if (
      this.#ownsFilesForwarder
      && this.filesForwarder !== this.simpleForwarder
      && typeof this.filesForwarder?.close === 'function'
    ) {
      closers.push(this.filesForwarder.close());
    }

    await Promise.allSettled(closers);
  }

  #warn(message, error) {
    const logger = this.logger;
    if (!logger) return;

    const text = `[pypi] ${message}`;
    if (typeof logger.warn === 'function') {
      logger.warn(text, error);
    } else if (typeof logger === 'function') {
      logger(text, error);
    }
  }
}

/**
 * @param {ConstructorParameters<typeof PypiRouter>[0]} options
 * @returns {PypiRouter}
 */
export function createPypiRouter(options) {
  return new PypiRouter(options);
}

export default createPypiRouter;
