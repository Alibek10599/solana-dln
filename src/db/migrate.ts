/**
 * Database Migration Script
 * 
 * Run with: npm run migrate
 */

import 'dotenv/config';
import { initializeSchema, closeClickHouse } from './clickhouse.js';
import { logger } from '../utils/logger.js';

async function main() {
  logger.info('Starting database migration...');
  
  try {
    await initializeSchema();
    logger.info('Migration completed successfully!');
  } catch (error) {
    logger.error({ error }, 'Migration failed');
    process.exit(1);
  } finally {
    await closeClickHouse();
  }
}

main();
