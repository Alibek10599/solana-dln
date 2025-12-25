/**
 * DLN Solana Dashboard
 * 
 * Main entry point - starts both collector and API server
 */

import 'dotenv/config';

console.log(`
╔═══════════════════════════════════════════════════════════╗
║                 DLN Solana Dashboard                       ║
║         OrderCreated & OrderFulfilled Events               ║
╚═══════════════════════════════════════════════════════════╝

Usage:
  npm run collect   - Collect order events from Solana
  npm run api       - Start API server
  npm run dashboard - Start React dashboard
  npm run migrate   - Initialize ClickHouse schema

For full setup instructions, see README.md
`);
