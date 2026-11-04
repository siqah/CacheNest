import { createHash } from 'node:crypto';

/**
 * Return a stable SHA-256 hex digest for a string.
 *
 * @param {string} value
 * @returns {string} 64-character lowercase hex digest
 */
export function hashString(value) {
  if (typeof value !== 'string') {
    throw new TypeError('hashString expects a string');
  }

  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Build the cache key for an HTTP request.
 *
 * The key is derived from the uppercase method and the trimmed URL, separated
 * by a single space. Query-string order is intentionally preserved because
 * servers may treat different orderings differently.
 *
 * @param {string} method HTTP method, e.g. "GET"
 * @param {string} url Absolute or relative request URL
 * @returns {string} 64-character lowercase SHA-256 hex digest
 */
export function createCacheKey(method, url) {
  if (typeof method !== 'string' || method.trim() === '') {
    throw new TypeError('createCacheKey expects a non-empty HTTP method');
  }

  if (typeof url !== 'string' || url.trim() === '') {
    throw new TypeError('createCacheKey expects a non-empty URL');
  }

  return hashString(`${method.trim().toUpperCase()} ${url.trim()}`);
}

export default createCacheKey;
