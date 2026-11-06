import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_HOST = '0.0.0.0';
const SHUTDOWN_TIMEOUT_MS = 15_000;

function formatHost(address) {
  return address.includes(':') ? `[${address}]` : address;
}

function clientHostFor(host) {
  const normalized = host.trim();
  if (normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]') {
    return '127.0.0.1';
  }

  return normalized;
}

/**
 * Load configuration, start the HTTP proxy, and install signal/error handlers.
 *
 * @returns {Promise<import('./server.js').CacheNestServer>}
 */
export async function main() {
  const [{ config }, { createServer }] = await Promise.all([
    import('./config.js'),
    import('./server.js'),
  ]);

  const logger = console;
  const app = createServer({ config, logger });
  const host = process.env.HOST?.trim() || DEFAULT_HOST;

  try {
    await app.listen({ port: config.port, host });
  } catch (error) {
    await app.close({ graceMs: 0 }).catch(() => {});
    throw error;
  }

  const address = app.address();
  const isAddressInfo = typeof address === 'object' && address !== null;
  const displayAddress = isAddressInfo
    ? `${formatHost(address.address)}:${address.port}`
    : String(address);
  const port = isAddressInfo ? address.port : config.port;
  const clientHost = clientHostFor(host);
  const baseUrl = `http://${formatHost(clientHost)}:${port}`;

  logger.info(`[cachenest] listening on http://${displayAddress}`);
  logger.info(
    `[cachenest] cache ${config.cacheDir} (max ${config.maxCacheGb} GB), npm ${config.upstream.npm}, pypi ${config.upstream.pypi}`,
  );
  logger.info(`[cachenest] metrics: ${baseUrl}/metrics`);

  const authEnabled = typeof config.apiKey === 'string' && config.apiKey !== '';
  logger.info(
    authEnabled
      ? '[cachenest] API key authentication enabled (Bearer, Basic, or x-cachenest-key)'
      : '[cachenest] API key authentication disabled (set API_KEY to enable)',
  );

  if (authEnabled) {
    logger.info(
      `[cachenest] npm: npm config set //${formatHost(clientHost)}:${port}/npm/:_authToken "$API_KEY" && npm install <package> --registry ${baseUrl}/npm`,
    );
    logger.info(
      `[cachenest] pip: python3 -m pip install <package> --index-url "http://cachenest:$API_KEY@${formatHost(clientHost)}:${port}/pypi/simple" --trusted-host ${clientHost}`,
    );
  } else {
    logger.info(`[cachenest] npm: npm install <package> --registry ${baseUrl}/npm`);
    logger.info(
      `[cachenest] pip: python3 -m pip install <package> --index-url ${baseUrl}/pypi/simple --trusted-host ${clientHost}`,
    );
  }

  let shuttingDown = false;

  const shutdown = async (reason, exitCode) => {
    if (shuttingDown) {
      logger.warn(`[cachenest] already shutting down; ignoring ${reason}`);
      return;
    }

    shuttingDown = true;
    logger.info(`[cachenest] ${reason}; shutting down`);

    const forceTimer = setTimeout(() => {
      logger.error(`[cachenest] shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms; forcing exit`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref?.();

    try {
      await app.close({ graceMs: 8_000 });
      process.exitCode = exitCode;
      logger.info('[cachenest] shutdown complete');
    } catch (error) {
      logger.error('[cachenest] shutdown failed', error);
      process.exitCode = 1;
    } finally {
      clearTimeout(forceTimer);
    }
  };

  const onSignal = (signal) => {
    if (shuttingDown) {
      logger.warn(`[cachenest] received ${signal} again; forcing exit`);
      process.exit(1);
    }

    void shutdown(signal, 0);
  };

  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  process.once('unhandledRejection', (reason) => {
    logger.error('[cachenest] unhandled rejection', reason);
    void shutdown('unhandled rejection', 1);
  });

  process.once('uncaughtException', (error) => {
    logger.error('[cachenest] uncaught exception', error);
    void shutdown('uncaught exception', 1);
  });

  return app;
}

const invokedPath = process.argv[1];
const isMain = invokedPath !== undefined
  && pathToFileURL(path.resolve(invokedPath)).href === import.meta.url;

if (isMain) {
  main().catch((error) => {
    const message = error?.name === 'ConfigError' ? error.message : error?.stack ?? String(error);
    console.error(`[cachenest] failed to start: ${message}`);
    process.exitCode = 1;
  });
}
