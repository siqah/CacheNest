import config from '../config.js';

/**
 * LRU eviction backed by the SQLite index.
 *
 * The index is the source of truth for logical cache usage. Blobs are deleted
 * oldest-first until the total indexed size no longer exceeds maxBytes.
 */
export class Eviction {
  #running;

  /**
   * @param {{
   *   index: import('./index-db.js').IndexDB,
   *   store: import('./store.js').BlobStore,
   *   maxBytes?: number,
   *   batchSize?: number,
   *   logger?: { warn?: Function } | Function | null,
   * }} options
   */
  constructor({
    index,
    store,
    maxBytes = config.maxCacheBytes,
    batchSize = 50,
    logger = console,
  } = {}) {
    if (!index || typeof index.totalSize !== 'function' || typeof index.oldest !== 'function') {
      throw new TypeError('Eviction: index must be an IndexDB instance');
    }

    if (!store || typeof store.delete !== 'function') {
      throw new TypeError('Eviction: store must be a BlobStore instance');
    }

    if (maxBytes !== Infinity && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
      throw new TypeError('Eviction: maxBytes must be a positive integer or Infinity');
    }

    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new TypeError('Eviction: batchSize must be a positive integer');
    }

    this.index = index;
    this.store = store;
    this.maxBytes = maxBytes;
    this.batchSize = batchSize;
    this.logger = logger;
  }

  /**
   * Run eviction if the cache is over its limit. Concurrent calls share the
   * same in-flight run instead of deleting in parallel.
   *
   * @returns {Promise<{
   *   maxBytes: number,
   *   totalBytes: number,
   *   freedBytes: number,
   *   evicted: number,
   *   failed: number,
   *   overLimit: boolean,
   * }>}
   */
  enforce() {
    if (this.#running) return this.#running;

    this.#running = this.#run().finally(() => {
      this.#running = undefined;
    });

    return this.#running;
  }

  async #run() {
    const startTotal = this.index.totalSize();
    let total = startTotal;
    let evicted = 0;
    let failed = 0;

    if (total <= this.maxBytes) {
      return this.#result(startTotal, total, evicted, failed);
    }

    // A key that cannot be unlinked would otherwise be selected forever.
    const failedKeys = new Set();

    while (total > this.maxBytes) {
      const candidates = this.index
        .oldest(this.batchSize + failedKeys.size)
        .filter((entry) => !failedKeys.has(entry.key));

      if (candidates.length === 0) break;

      const removedKeys = [];
      let madeProgress = false;

      for (const entry of candidates) {
        if (total <= this.maxBytes) break;

        try {
          await this.store.delete(entry.key);
          removedKeys.push(entry.key);
          total -= entry.size;
          madeProgress = true;
        } catch (error) {
          failedKeys.add(entry.key);
          failed += 1;
          this.#warn(`unable to delete blob "${entry.key}"`, error);
        }
      }

      if (removedKeys.length > 0) {
        evicted += this.index.deleteMany(removedKeys);
      }

      total = this.index.totalSize();

      if (!madeProgress) break;
    }

    return this.#result(startTotal, total, evicted, failed);
  }

  #result(startTotal, total, evicted, failed) {
    return {
      maxBytes: this.maxBytes,
      totalBytes: total,
      freedBytes: Math.max(0, startTotal - total),
      evicted,
      failed,
      overLimit: total > this.maxBytes,
    };
  }

  #warn(message, error) {
    const logger = this.logger;
    if (!logger) return;

    const text = `[eviction] ${message}`;
    if (typeof logger.warn === 'function') {
      logger.warn(text, error);
    } else if (typeof logger === 'function') {
      logger(text, error);
    }
  }
}

export default Eviction;
