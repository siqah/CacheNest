import { createHash, timingSafeEqual } from 'node:crypto';

import { config } from '../config.js';
import { HttpError } from '../routes/common.js';

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;
const BASIC_PATTERN = /^Basic\s+(.+)$/i;

function readHeader(request, name) {
  const headers = request?.headers;
  if (headers === undefined || headers === null) return undefined;

  if (typeof headers.get === 'function') {
    return headers.get(name) ?? undefined;
  }

  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

function addCandidate(candidates, value) {
  if (typeof value !== 'string') return;

  const token = value.trim();
  if (token !== '') candidates.push(token);
}

function addBasicCandidates(candidates, encoded) {
  let decoded;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return;
  }

  const separator = decoded.indexOf(':');
  if (separator === -1) return;

  // Accept the API key as either the username or password. This lets pip use
  // its standard Basic-auth URL form while npm can use Bearer tokens.
  addCandidate(candidates, decoded.slice(0, separator));
  addCandidate(candidates, decoded.slice(separator + 1));
}

function candidateTokens(request) {
  const candidates = [];

  addCandidate(candidates, readHeader(request, 'x-cachenest-key'));

  const authorization = readHeader(request, 'authorization');
  if (authorization !== undefined) {
    const value = authorization.trim();

    const bearer = BEARER_PATTERN.exec(value);
    if (bearer !== null) addCandidate(candidates, bearer[1]);

    const basic = BASIC_PATTERN.exec(value);
    if (basic !== null) addBasicCandidates(candidates, basic[1]);
  }

  return candidates;
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function stripCredentials(request) {
  if (request?.headers === undefined || request.headers === null) return;

  // CacheNest's own credentials must not be forwarded upstream, and the cache
  // must not treat them as upstream Authorization headers (which are never
  // stored, since authenticated responses must not enter a shared cache).
  delete request.headers.authorization;
  delete request.headers['x-cachenest-key'];
}

/**
 * Create API-key authentication middleware.
 *
 * Authentication is disabled when no key is configured. When enabled, callers
 * may use `Authorization: Bearer <key>`, `Authorization: Basic` with the key as
 * the username or password, or `x-cachenest-key: <key>`.
 *
 * @param {{ apiKey?: string | null }} [options]
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, next: Function) => unknown}
 */
export function createAuthMiddleware({ apiKey } = {}) {
  const configured = apiKey === undefined ? config.apiKey : apiKey;

  if (configured !== undefined && configured !== null && typeof configured !== 'string') {
    throw new TypeError('Auth: apiKey must be a string or null');
  }

  const expected = typeof configured === 'string' ? configured.trim() : '';
  if (expected === '') {
    return function authDisabled(request, response, next) {
      return next();
    };
  }

  const expectedDigest = digest(expected);

  return function apiKeyAuth(request, response, next) {
    const valid = candidateTokens(request).some((candidate) => {
      const candidateDigest = digest(candidate);
      return timingSafeEqual(candidateDigest, expectedDigest);
    });

    if (!valid) {
      throw new HttpError(401, 'Unauthorized', {
        code: 'UNAUTHORIZED',
        headers: {
          'www-authenticate': 'Bearer realm="cachenest"',
        },
      });
    }

    stripCredentials(request);
    return next();
  };
}
