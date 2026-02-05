import { appendFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * Simple file logger for E2E tests
 * Writes timestamped logs to a file for post-test analysis
 */
export class E2ELogger {
  private logPath: string;
  private startTime: number;

  constructor(logPath: string) {
    this.logPath = logPath;
    this.startTime = Date.now();

    // Ensure directory exists
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Initialize log file with header
    const header = `\n${'='.repeat(80)}\nE2E Test Run: ${new Date().toISOString()}\n${'='.repeat(80)}\n\n`;
    writeFileSync(this.logPath, header);
  }

  private formatTime(): string {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(2);
    return `[+${elapsed}s]`;
  }

  log(message: string, ...args: unknown[]): void {
    const timestamp = new Date().toISOString();
    const formatted = args.length > 0
      ? `${message} ${args.map(a => JSON.stringify(a)).join(' ')}`
      : message;
    const line = `${timestamp} ${this.formatTime()} ${formatted}\n`;

    appendFileSync(this.logPath, line);
    console.log(formatted); // Also print to stdout
  }

  info(message: string, ...args: unknown[]): void {
    this.log(`ℹ️  ${message}`, ...args);
  }

  success(message: string, ...args: unknown[]): void {
    this.log(`✅ ${message}`, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log(`❌ ${message}`, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log(`⚠️  ${message}`, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.log(`🔍 ${message}`, ...args);
  }

  section(title: string): void {
    const line = `\n${'─'.repeat(60)}\n${title}\n${'─'.repeat(60)}\n`;
    appendFileSync(this.logPath, line);
    console.log(`\n--- ${title} ---`);
  }

  /**
   * Log an object as formatted JSON
   */
  json(label: string, obj: unknown): void {
    const formatted = JSON.stringify(obj, null, 2);
    appendFileSync(this.logPath, `${label}:\n${formatted}\n`);
  }
}

// Default log path
const LOG_DIR = 'tests/e2e/logs';
const LOG_FILE = `${LOG_DIR}/e2e-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;

// Export singleton instance
export const logger = new E2ELogger(process.env.E2E_LOG_FILE || LOG_FILE);
