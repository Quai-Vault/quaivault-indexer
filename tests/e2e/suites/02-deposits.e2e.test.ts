/**
 * E2E Tests for QuaiVault Deposit Events
 *
 * Events covered:
 * 13. Received
 *
 * NOTE: Requires 01-factory tests to run first (creates the shared wallet).
 */

import { describe, it, beforeAll } from 'vitest';
import * as quais from 'quais';
import { e2eConfig, contracts, indexer, supabase } from '../setup.js';
import { DatabaseVerifier } from '../helpers/db.js';
import { getTestWallet, markWalletFunded } from '../shared-state.js';

describe('QuaiVault Deposit Events', () => {
  let db: DatabaseVerifier;
  let walletAddress: string;

  beforeAll(async () => {
    db = new DatabaseVerifier(supabase, e2eConfig.supabaseSchema);

    // Get the shared test wallet created by factory tests
    walletAddress = getTestWallet();
    console.log(`  Using shared test wallet: ${walletAddress}`);
  });

  it('should index Received event when sending QUAI to wallet', async () => {
    // Amount to send (small amount for testing)
    const amount = quais.parseQuai('0.001');
    const senderAddress = contracts.getWalletAddress(0);

    // Send QUAI to the wallet
    console.log(`  Sending ${quais.formatQuai(amount)} QUAI to wallet...`);
    await contracts.sendQuaiToWallet(walletAddress, amount, 0);

    // Wait for indexer to process the Received event
    console.log('  Waiting for indexer to process Received event...');
    await indexer.waitUntil(
      async () => {
        const deposits = await db.getDeposits(walletAddress);
        const matchingDeposit = deposits.find(
          (d) =>
            d.sender_address.toLowerCase() === senderAddress.toLowerCase() &&
            d.amount === amount.toString()
        );
        return matchingDeposit ? deposits : null;
      },
      'Received event indexed',
      e2eConfig.txConfirmationTimeout
    );

    // Verify the deposit was recorded
    await db.verifyDepositReceived(walletAddress, senderAddress, amount.toString());

    // Mark wallet as funded for other tests
    markWalletFunded();

    console.log('  ✓ Received event indexed correctly');
  });

  it('should index multiple Received events', async () => {
    // Send a different amount from a different sender
    const amount = quais.parseQuai('0.002');
    const senderAddress = contracts.getWalletAddress(1);

    // Send QUAI to the wallet
    console.log(`  Sending ${quais.formatQuai(amount)} QUAI from second owner...`);
    await contracts.sendQuaiToWallet(walletAddress, amount, 1);

    // Wait for indexer to process
    console.log('  Waiting for indexer to process second Received event...');
    await indexer.waitUntil(
      async () => {
        const deposits = await db.getDeposits(walletAddress);
        const matchingDeposit = deposits.find(
          (d) =>
            d.sender_address.toLowerCase() === senderAddress.toLowerCase() &&
            d.amount === amount.toString()
        );
        return matchingDeposit ? deposits : null;
      },
      'Second Received event indexed',
      e2eConfig.txConfirmationTimeout
    );

    // Verify both deposits are in the database
    const deposits = await db.getDeposits(walletAddress);
    const depositCount = deposits.length;
    console.log(`  Found ${depositCount} deposits for wallet`);

    // Verify the specific deposit
    await db.verifyDepositReceived(walletAddress, senderAddress, amount.toString());

    console.log('  ✓ Multiple Received events indexed correctly');
  });
});
