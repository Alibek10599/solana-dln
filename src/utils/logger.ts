/**
 * Logger utility using Pino
 *
 * Provides centralized logging with support for:
 * - Child loggers for component-specific logging
 * - Structured logging with JSON output
 * - Pretty printing in development
 * - Log level configuration
 */

import pino from 'pino';
import pretty from 'pino-pretty';
import { config } from '../config/index.js';

/**
 * Base logger instance
 */
export const logger = config.logging.prettyPrint
  ? pino(
      {
        level: config.logging.level,
      },
      pretty({
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        singleLine: false,
        // Custom colors for different log levels
        customColors: 'trace:gray,debug:blue,info:green,warn:yellow,error:red,fatal:redBright',
        sync: false,
      })
    )
  : pino({
      level: config.logging.level,
    });

/**
 * Create a child logger for a specific component
 *
 * @example
 * const log = createChildLogger('database');
 * log.info({ query: 'SELECT * FROM orders' }, 'Executing query');
 */
export function createChildLogger(component: string) {
  return logger.child({ component });
}

/**
 * Create a child logger with custom context
 *
 * @example
 * const log = createLoggerWithContext({ workflowId: 'abc-123', runId: 'xyz-789' });
 * log.info('Workflow started');
 */
export function createLoggerWithContext(context: Record<string, unknown>) {
  return logger.child(context);
}

export default logger;
