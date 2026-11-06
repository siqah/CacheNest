import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { config } from '../config.js';

const KEY_PATTERN = /^[a-f0-9]{64}$/;

function assertKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new TypeError(
      'BlobStore: key must be a 64-character lowercase SHA-256 hex string',
    );
  }
}

function toReadable(source) {
  if (source instanceof Readable) return source;

  if (typeof ReadableStream !== 'undefined' && source instanceof ReadableStream) {
    return Readable.fromWeb(source);
  }

  if (source !== null && source !== undefined && typeof source[Symbol.asyncIterator] === 'function') {
    return Readable.from(source);
  }

  throw new TypeError(
    'BlobStore: source must be a Buffer, Uint8Array, Readable, ReadableStream, or async iterable',
  );
}

async function replaceFile(tempPath, targetPath) {
  try {
    await fs.promises.rename(tempPath, targetPath);
    return;
  } catch (error) {
    // On Windows, rename does not replace an existing file. Retry after removing it.
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
  }

  await fs.promises.rm(targetPath, { force: true });
  await fs.promises.rename(tempPath, targetPath);
}

/**
 * Stores immutable package blobs as sharded files under CACHE_DIR/blobs.
 *
 * Files are written to a temporary file in the target shard and atomically
 * renamed into place, so readers never observe a partially written blob.
 */
export class BlobStore {
  /**
   * @param {{ cacheDir?: string, blobsDir?: string }} [options]
   */
  constructor({ cacheDir = config.cacheDir, blobsDir } = {}) {
    if (typeof cacheDir !== 'string' || cacheDir.trim() === '') {
      throw new TypeError('BlobStore: cacheDir must be a non-empty string');
    }

    if (blobsDir !== undefined && (typeof blobsDir !== 'string' || blobsDir.trim() === '')) {
      throw new TypeError('BlobStore: blobsDir must be a non-empty string');
    }

    this.cacheDir = path.resolve(cacheDir);
    this.blobsDir = blobsDir === undefined
      ? path.join(this.cacheDir, 'blobs')
      : path.resolve(blobsDir);

    try {
      fs.mkdirSync(this.blobsDir, { recursive: true });
    } catch (error) {
      throw new Error(
        `BlobStore: unable to create blob directory "${this.blobsDir}": ${error.message}`,
        { cause: error },
      );
    }
  }

  /**
   * Absolute path for a blob. Blobs are sharded by the first two hex
   * characters of the key to keep directory sizes manageable.
   *
   * @param {string} key
   * @returns {string}
   */
  pathForKey(key) {
    assertKey(key);
    return path.join(this.blobsDir, key.slice(0, 2), key);
  }

  /**
   * Atomically write a blob.
   *
   * @param {string} key
   * @param {Buffer | Uint8Array | import('node:stream').Readable | ReadableStream | AsyncIterable<Uint8Array>} source
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<{ key: string, path: string, size: number }>}
   */
  async write(key, source, { signal } = {}) {
    assertKey(key);
    signal?.throwIfAborted();

    const direct = Buffer.isBuffer(source) || source instanceof Uint8Array;
    const readable = direct ? null : toReadable(source);

    const targetPath = this.pathForKey(key);
    const directory = path.dirname(targetPath);

    try {
      await fs.promises.mkdir(directory, { recursive: true });
    } catch (error) {
      readable?.destroy();
      throw new Error(
        `BlobStore: unable to create blob shard "${directory}": ${error.message}`,
        { cause: error },
      );
    }

    const tempPath = path.join(directory, `.${key}.${randomUUID()}.tmp`);

    try {
      // `flush` asks the OS to persist the completed temp file before the
      // atomic rename. The rename then guarantees readers only ever see either
      // no blob or the complete blob, even after an interrupted download.
      if (readable === null) {
        await fs.promises.writeFile(tempPath, source, { flag: 'wx', flush: true, signal });
      } else {
        await pipeline(
          readable,
          fs.createWriteStream(tempPath, { flags: 'wx', flush: true }),
          { signal },
        );
      }

      const stats = await fs.promises.stat(tempPath);
      await replaceFile(tempPath, targetPath);

      return { key, path: targetPath, size: stats.size };
    } catch (error) {
      readable?.destroy();
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
      throw new Error(`BlobStore: failed to write blob "${key}": ${error.message}`, {
        cause: error,
      });
    }
  }

  /**
   * Open a blob for reading. The returned stream owns the file descriptor and
   * closes it automatically when consumed or destroyed.
   *
   * @param {string} key
   * @returns {Promise<{ key: string, path: string, size: number, stream: import('node:fs').ReadStream } | null>}
   */
  async openRead(key) {
    assertKey(key);
    const blobPath = this.pathForKey(key);

    let handle;
    try {
      handle = await fs.promises.open(blobPath, 'r');
    } catch (error) {
      if (error.code === 'ENOENT') return null;

      throw new Error(`BlobStore: failed to open blob "${key}": ${error.message}`, {
        cause: error,
      });
    }

    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        await handle.close();
        return null;
      }

      return {
        key,
        path: blobPath,
        size: stats.size,
        stream: handle.createReadStream({ autoClose: true }),
      };
    } catch (error) {
      await handle.close().catch(() => {});
      throw new Error(`BlobStore: failed to read blob "${key}": ${error.message}`, {
        cause: error,
      });
    }
  }

  /**
   * Delete a blob. Missing files are not an error.
   *
   * @param {string} key
   * @returns {Promise<boolean>} True when a file was removed.
   */
  async delete(key) {
    assertKey(key);

    try {
      await fs.promises.unlink(this.pathForKey(key));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;

      throw new Error(`BlobStore: failed to delete blob "${key}": ${error.message}`, {
        cause: error,
      });
    }
  }
}
