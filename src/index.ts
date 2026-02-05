import { Indexer } from './indexer.js';
import { logger } from './utils/logger.js';

const indexer = new Indexer();
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn('Shutdown already in progress, forcing exit...');
    process.exit(1);
  }

  isShuttingDown = true;
  logger.info({ signal }, 'Received shutdown signal');

  // Force exit after 10 seconds if graceful shutdown hangs
  const forceExitTimeout = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000);

  try {
    await indexer.stop();
    clearTimeout(forceExitTimeout);
    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExitTimeout);
    logger.error({ error }, 'Error during shutdown');
    process.exit(1);
  }
}

// Graceful shutdown handlers
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Start
indexer.start().catch((error) => {
  logger.error({ error }, 'Failed to start indexer');
  process.exit(1);
});
