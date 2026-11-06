import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const BYTES_PER_GB = 1024 ** 3;

class ConfigError extends Error {
  constructor(message) {
    super(`[config] ${message}`);
    this.name = 'ConfigError';
  }
}

const DEFAULTS = Object.freeze({
  port: 8080,
  cacheDir: path.join(os.homedir(), '.cachenest'),
  maxCacheGb: 5,
  upstreamNpm: 'https://registry.npmjs.org',
  upstreamPypi: 'https://pypi.org/simple',
});

function readEnv(name) {
  const raw = process.env[name];
  if (raw === undefined) return undefined;

  const value = raw.trim();
  return value === '' ? undefined : value;
}

function parsePort(raw) {
  if (raw === undefined) return DEFAULTS.port;

  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535 (received "${raw}")`);
  }

  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535 (received "${raw}")`);
  }

  return port;
}

function parseMaxCacheGb(raw) {
  if (raw === undefined) return DEFAULTS.maxCacheGb;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`MAX_CACHE_GB must be a positive number (received "${raw}")`);
  }

  const bytes = Math.floor(value * BYTES_PER_GB);
  if (bytes < 1) {
    throw new ConfigError(`MAX_CACHE_GB is too small to hold any data (received "${raw}")`);
  }

  if (!Number.isSafeInteger(bytes)) {
    throw new ConfigError(`MAX_CACHE_GB is too large (received "${raw}")`);
  }

  return value;
}

function resolveCacheDir(raw) {
  const value = raw ?? DEFAULTS.cacheDir;

  let expanded = value;
  if (value === '~') {
    expanded = os.homedir();
  } else if (/^~[\\/]/.test(value)) {
    expanded = path.join(os.homedir(), value.slice(2));
  }

  const resolved = path.resolve(expanded);
  if (path.parse(resolved).root === resolved) {
    throw new ConfigError('CACHE_DIR cannot be the filesystem root');
  }

  return resolved;
}

function parseUpstream(name, raw, fallback) {
  const value = raw ?? fallback;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be a valid absolute URL (received "${value}")`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${name} must use http or https (received "${value}")`);
  }

  if (url.username || url.password) {
    throw new ConfigError(`${name} must not contain credentials`);
  }

  // Normalize the trailing slash away so upstream paths can be joined safely.
  return url.toString().replace(/\/+$/, '');
}

const cacheDir = resolveCacheDir(readEnv('CACHE_DIR'));
const maxCacheGb = parseMaxCacheGb(readEnv('MAX_CACHE_GB'));

export const config = Object.freeze({
  port: parsePort(readEnv('PORT')),
  apiKey: readEnv('API_KEY') ?? null,
  cacheDir,
  maxCacheGb,
  maxCacheBytes: Math.floor(maxCacheGb * BYTES_PER_GB),
  indexDbPath: path.join(cacheDir, 'index.sqlite'),
  upstream: Object.freeze({
    npm: parseUpstream('UPSTREAM_NPM', readEnv('UPSTREAM_NPM'), DEFAULTS.upstreamNpm),
    pypi: parseUpstream('UPSTREAM_PYPI', readEnv('UPSTREAM_PYPI'), DEFAULTS.upstreamPypi),
  }),
});
