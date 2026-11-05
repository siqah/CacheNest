const DUMMY_ORIGIN = 'http://cachenest.invalid';

/**
 * An HTTP error that the server layer can safely render to a client.
 */
export class HttpError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} message
   * @param {{ code?: string, headers?: Record<string, string> }} [options]
   */
  constructor(statusCode, message, { code = 'HTTP_ERROR', headers = {} } = {}) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.headers = headers;
    this.expose = statusCode < 500;
  }
}

/**
 * Normalize a mount prefix such as "/npm" or "/pypi".
 *
 * @param {string} prefix
 * @returns {string}
 */
export function normalizePrefix(prefix) {
  if (
    typeof prefix !== 'string'
    || !/^\/[^?#\s]*$/.test(prefix)
    || prefix.startsWith('//')
  ) {
    throw new TypeError(
      'Route prefix must start with a single "/" and contain no query or fragment',
    );
  }

  const normalized = prefix.replace(/\/+$/, '');
  return normalized === '' ? '/' : normalized;
}

/**
 * Parse an origin-form request target without allowing an absolute or
 * protocol-relative URL to replace the proxy target.
 *
 * @param {string} rawUrl
 * @returns {{ pathname: string, search: string, keyPath: string }}
 */
export function parseRequestTarget(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new HttpError(400, 'Malformed request URL', { code: 'BAD_REQUEST' });
  }

  let parsed;
  try {
    parsed = new URL(rawUrl, DUMMY_ORIGIN);
  } catch {
    throw new HttpError(400, 'Malformed request URL', { code: 'BAD_REQUEST' });
  }

  if (parsed.origin !== DUMMY_ORIGIN) {
    throw new HttpError(400, 'Only origin-form request URLs are supported', {
      code: 'BAD_REQUEST',
    });
  }

  return {
    pathname: parsed.pathname,
    search: parsed.search,
    keyPath: `${parsed.pathname}${parsed.search}`,
  };
}

/**
 * @param {string} pathname
 * @param {string} prefix
 * @returns {boolean}
 */
export function matchesPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Return the path below a mount prefix, or null when it does not match.
 *
 * @param {string} pathname
 * @param {string} prefix
 * @returns {string | null}
 */
export function stripPrefix(pathname, prefix) {
  if (pathname === prefix) return '/';
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return null;
}

/**
 * Reject paths that would be interpreted as an authority by URL parsers.
 *
 * @param {string} pathname
 * @returns {string}
 */
export function assertRelativePath(pathname) {
  if (!pathname.startsWith('/') || pathname.startsWith('//')) {
    throw new HttpError(400, 'Invalid request path', { code: 'BAD_REQUEST' });
  }

  return pathname;
}

/**
 * Join an upstream base path with a request path without duplicating slashes.
 *
 * @param {string} basePath
 * @param {string} requestPath
 * @returns {string}
 */
export function joinUrlPath(basePath, requestPath) {
  const base = basePath === '/' ? '' : basePath.replace(/\/+$/, '');
  let tail = requestPath === '' ? '/' : requestPath;

  if (!tail.startsWith('/')) tail = `/${tail}`;
  while (tail.startsWith('//')) tail = tail.slice(1);
  if (base === '') return tail;

  return tail === '/' ? `${base}/` : `${base}${tail}`;
}

/**
 * Restrict the proxy to the read-only methods it can cache.
 *
 * @param {string | undefined} method
 * @returns {'GET' | 'HEAD'}
 */
export function requireReadMethod(method) {
  const normalized = String(method ?? 'GET').toUpperCase();

  if (normalized !== 'GET' && normalized !== 'HEAD') {
    throw new HttpError(405, `Method ${normalized} is not allowed`, {
      code: 'METHOD_NOT_ALLOWED',
      headers: { allow: 'GET, HEAD' },
    });
  }

  return normalized;
}
