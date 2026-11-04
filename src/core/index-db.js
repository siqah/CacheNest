import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import config from '../config.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS cache_entries (
    key        TEXT    PRIMARY KEY NOT NULL,
    size       INTEGER NOT NULL CHECK (size >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    last_used  INTEGER NOT NULL CHECK (last_used >= 0),
    headers    TEXT    NOT NULL CHECK (json_valid(headers))
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS idx_cache_entries_last_used
    ON cache_entries (last_used);
`;

/**
 * @typedef {Object} CacheEntry
 * @property {string} key
 * @property {number} size Size in bytes.
 * @property {number} createdAt Unix timestamp in milliseconds.
 * @property {number} lastUsed Unix timestamp in milliseconds.
 * @property {Record<string, unknown>} headers Response headers.
 */

function assertKey(key) {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new TypeError('IndexDB: key must be a non-empty string');
  }
}

function normalizeTimestamp(value, fallback, field) {
  if (value === undefined) return fallback;

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`IndexDB: ${field} must be a non-negative integer timestamp in milliseconds`);
  }

  return value;
}

function serializeHeaders(headers) {
  const value = headers ?? {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('IndexDB: headers must be a plain object');
  }

  let json;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`IndexDB: headers must be JSON-serializable: ${error.message}`, {
      cause: error,
    });
  }

  if (typeof json !== 'string') {
    throw new TypeError('IndexDB: headers must be JSON-serializable');
  }

  return json;
}

function parseHeaders(raw, key) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError('headers JSON is not an object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`IndexDB: corrupt headers JSON for cache key "${key}"`, { cause: error });
  }
}

/**
 * Persistent index of cached artifacts backed by SQLite.
 *
 * The database lives at `CACHE_DIR/index.sqlite` by default. Each instance
 * owns exactly one connection; call `close()` when the process shuts down.
 */
export class IndexDB {
  #db;
  #getStatement;
  #setStatement;
  #touchStatement;

  /**
   * @param {{ dbPath?: string }} [options]
   */
  constructor({ dbPath = config.indexDbPath } = {}) {
    if (typeof dbPath !== 'string' || dbPath.trim() === '') {
      throw new TypeError('IndexDB: dbPath must be a non-empty string');
    }

    const resolvedPath = path.resolve(dbPath);
    const directory = path.dirname(resolvedPath);

    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch (error) {
      throw new Error(
        `IndexDB: unable to create index directory "${directory}": ${error.message}`,
        { cause: error },
      );
    }

    try {
      this.#db = new Database(resolvedPath);
      this.#db.pragma('journal_mode = WAL');
      this.#db.pragma('synchronous = NORMAL');
      this.#db.pragma('busy_timeout = 5000');
      this.#db.exec(SCHEMA);

      this.#getStatement = this.#db.prepare(`
        SELECT key, size, created_at, last_used, headers
        FROM cache_entries
        WHERE key = ?
      `);

      this.#setStatement = this.#db.prepare(`
        INSERT INTO cache_entries (key, size, created_at, last_used, headers)
        VALUES (@key, @size, @createdAt, @lastUsed, @headers)
        ON CONFLICT(key) DO UPDATE SET
          size       = excluded.size,
          created_at = excluded.created_at,
          last_used  = excluded.last_used,
          headers    = excluded.headers
      `);

      this.#touchStatement = this.#db.prepare(`
        UPDATE cache_entries
        SET last_used = ?
        WHERE key = ?
      `);
    } catch (error) {
      try {
        this.#db?.close();
      } catch {
        // Preserve the original initialization error.
      }
      this.#db = undefined;

      throw new Error(`IndexDB: failed to initialize "${resolvedPath}": ${error.message}`, {
        cause: error,
      });
    }

    this.dbPath = resolvedPath;
  }

  #assertOpen() {
    if (!this.#db?.open) {
      throw new Error('IndexDB: database is closed');
    }
    return this.#db;
  }

  /**
   * Look up an entry without modifying it.
   *
   * @param {string} key
   * @returns {CacheEntry | null}
   */
  get(key) {
    assertKey(key);
    this.#assertOpen();

    const row = this.#getStatement.get(key);
    if (row === undefined) return null;

    return {
      key: row.key,
      size: row.size,
      createdAt: row.created_at,
      lastUsed: row.last_used,
      headers: parseHeaders(row.headers, row.key),
    };
  }

  /**
   * Insert or fully replace an entry.
   *
   * @param {{
   *   key: string,
   *   size: number,
   *   createdAt?: number,
   *   lastUsed?: number,
   *   headers?: Record<string, unknown>,
   * }} entry
   * @returns {CacheEntry}
   */
  set(entry) {
    if (entry === null || typeof entry !== 'object') {
      throw new TypeError('IndexDB: entry must be an object');
    }

    const { key, size } = entry;
    assertKey(key);

    if (!Number.isSafeInteger(size) || size < 0) {
      throw new TypeError('IndexDB: size must be a non-negative integer number of bytes');
    }

    const now = Date.now();
    const createdAt = normalizeTimestamp(entry.createdAt, now, 'createdAt');
    const lastUsed = normalizeTimestamp(entry.lastUsed, now, 'lastUsed');
    const headers = serializeHeaders(entry.headers);

    this.#assertOpen();
    this.#setStatement.run({ key, size, createdAt, lastUsed, headers });

    const stored = this.get(key);
    if (stored === null) {
      throw new Error(`IndexDB: entry "${key}" disappeared immediately after being written`);
    }

    return stored;
  }

  /**
   * Update the last-used timestamp for an entry.
   *
   * @param {string} key
   * @param {number} [timestamp] Unix timestamp in milliseconds. Defaults to now.
   * @returns {boolean} True when an entry was updated, false when the key is unknown.
   */
  touch(key, timestamp = Date.now()) {
    assertKey(key);
    const lastUsed = normalizeTimestamp(timestamp, Date.now(), 'timestamp');

    this.#assertOpen();
    const result = this.#touchStatement.run(lastUsed, key);
    return result.changes > 0;
  }

  /**
   * Close the SQLite connection. Safe to call more than once.
   */
  close() {
    if (!this.#db) return;

    if (this.#db.open) {
      this.#db.close();
    }

    this.#db = undefined;
    this.#getStatement = undefined;
    this.#setStatement = undefined;
    this.#touchStatement = undefined;
  }
}

export default IndexDB;
