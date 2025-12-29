/**
 * Debug script to analyze real DLN transaction instruction data
 * Run with: npx ts-node src/scripts/debug-instruction.ts
 */

import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const DLN_SOURCE_PROGRAM_ID = new PublicKey('src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4');

async function debugInstruction() {
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  
  console.log('Fetching recent DLN Source transactions...\n');
  
  // Get recent signatures
  const signatures = await connection.getSignaturesForAddress(
    DLN_SOURCE_PROGRAM_ID,
    { limit: 10 }
  );
  
  for (const sig of signatures.slice(0, 3)) {
    console.log('='.repeat(80));
    console.log('Signature:', sig.signature);
    console.log('='.repeat(80));
    
    // Fetch full transaction
    const tx = await connection.getParsedTransaction(sig.signature, {
      maxSupportedTransactionVersion: 0,
    });
    
    if (!tx) {
      console.log('Could not fetch transaction\n');
      continue;
    }
    
    // Find DLN Source instruction
    for (const ix of tx.transaction.message.instructions) {
      if (ix.programId.toBase58() === DLN_SOURCE_PROGRAM_ID.toBase58()) {
        if ('data' in ix) {
          const data = Buffer.from(bs58.decode(ix.data));
          
          console.log('\n📦 Instruction Data Analysis:');
          console.log('Total length:', data.length, 'bytes');
          console.log('\nHex dump (first 200 bytes):');
          console.log(data.slice(0, 200).toString('hex'));
          
          console.log('\n🔍 Attempting to parse structure:');
          
          // Discriminator (8 bytes)
          const discriminator = data.slice(0, 8);
          console.log('Discriminator (0-8):', discriminator.toString('hex'));
          
          let offset = 8;
          
          // Try reading fields
          try {
            // Maker nonce (u64 = 8 bytes)
            const makerNonce = data.readBigUInt64LE(offset);
            console.log(`Maker Nonce (${offset}-${offset+8}):`, makerNonce.toString());
            offset += 8;
            
            // Maker address (32 bytes)
            const makerSrc = data.slice(offset, offset + 32);
            console.log(`Maker Src (${offset}-${offset+32}):`, makerSrc.toString('hex'));
            offset += 32;
            
            // Give token address (32 bytes)
            const giveToken = data.slice(offset, offset + 32);
            console.log(`Give Token (${offset}-${offset+32}):`, giveToken.toString('hex'));
            try {
              const giveTokenPubkey = new PublicKey(giveToken);
              console.log('  -> As Base58:', giveTokenPubkey.toBase58());
            } catch {}
            offset += 32;
            
            // Give amount (u64 = 8 bytes)
            const giveAmount = data.readBigUInt64LE(offset);
            console.log(`Give Amount (${offset}-${offset+8}):`, giveAmount.toString());
            offset += 8;
            
            // Give chain ID (u256 = 32 bytes)
            const giveChainLow = data.readBigUInt64LE(offset);
            const giveChainHigh = data.readBigUInt64LE(offset + 8);
            console.log(`Give Chain ID (${offset}-${offset+32}):`, giveChainLow.toString());
            offset += 32;
            
            // Take token address (32 bytes)
            const takeToken = data.slice(offset, offset + 32);
            console.log(`Take Token (${offset}-${offset+32}):`, takeToken.toString('hex'));
            offset += 32;
            
            // Take amount (u64 = 8 bytes)
            const takeAmount = data.readBigUInt64LE(offset);
            console.log(`Take Amount (${offset}-${offset+8}):`, takeAmount.toString());
            offset += 8;
            
            // Take chain ID (u256 = 32 bytes)
            const takeChainLow = data.readBigUInt64LE(offset);
            console.log(`Take Chain ID (${offset}-${offset+32}):`, takeChainLow.toString());
            
          } catch (e) {
            console.log('Parse error:', e);
          }
          
          // Also show token balance changes for comparison
          console.log('\n💰 Token Balance Changes:');
          const preBalances = tx.meta?.preTokenBalances || [];
          const postBalances = tx.meta?.postTokenBalances || [];
          
          for (const post of postBalances) {
            const pre = preBalances.find(p => p.accountIndex === post.accountIndex && p.mint === post.mint);
            const preAmt = Number(pre?.uiTokenAmount?.amount || '0');
            const postAmt = Number(post.uiTokenAmount?.amount || '0');
            const change = postAmt - preAmt;
            
            if (change !== 0) {
              console.log(`  Mint: ${post.mint}`);
              console.log(`  Change: ${change} (${post.uiTokenAmount?.uiAmount || 0} UI)`);
              console.log(`  Decimals: ${post.uiTokenAmount?.decimals}`);
              console.log('');
            }
          }
        }
      }
    }
    
    // Show logs
    console.log('\n📝 Logs (looking for order_id):');
    const logs = tx.meta?.logMessages || [];
    for (const log of logs) {
      if (log.includes('Program data:') || log.includes('order')) {
        console.log(' ', log);
      }
    }
    
    console.log('\n');
  }
}

debugInstruction().catch(console.error);
