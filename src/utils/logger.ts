import { pino } from 'pino';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.join(__dirname, '../../logs');

const isDev = process.env.NODE_ENV !== 'production';
const logLevel = process.env.LOG_LEVEL || 'info';
const enableFileLogging = process.env.LOG_TO_FILE === 'true';

// Build transport targets
const targets: pino.TransportTargetOptions[] = [];

if (isDev) {
  // Pretty console output in development
  targets.push({
    target: 'pino-pretty',
    options: { colorize: true },
    level: logLevel,
  });
} else {
  // JSON to stdout in production
  targets.push({
    target: 'pino/file',
    options: { destination: 1 }, // stdout
    level: logLevel,
  });
}

// File logging with rotation (optional, enabled via LOG_TO_FILE=true)
if (enableFileLogging) {
  targets.push({
    target: 'pino-roll',
    options: {
      file: path.join(logsDir, 'indexer'),
      frequency: 'daily',
      mkdir: true,
      size: '10m',
      extension: '.log',
    },
    level: logLevel,
  });

  // Separate error log file
  targets.push({
    target: 'pino-roll',
    options: {
      file: path.join(logsDir, 'error'),
      frequency: 'daily',
      mkdir: true,
      size: '10m',
      extension: '.log',
    },
    level: 'error',
  });
}

export const logger = pino({
  level: logLevel,
  transport: { targets },
});
