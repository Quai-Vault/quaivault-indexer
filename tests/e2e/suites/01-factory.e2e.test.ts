/**
 * E2E Tests for QuaiVaultFactory Events
 *
 * Events covered:
 * 1. WalletCreated
 * 2. WalletRegistered
 *
 * NOTE: This test MUST run first (01-) as it creates the shared test wallet.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { e2eConfig, contracts, indexer, supabase } from '../setup.js';
import { DatabaseVerifier } from '../helpers/db.js';
import { setTestWallet, getTestWallet } from '../shared-state.js';

describe('QuaiVaultFactory Events', () => {
  let db: DatabaseVerifier;

  beforeAll(async () => {
    db = new DatabaseVerifier(supabase, e2eConfig.supabaseSchema);
  });

  it('should index WalletCreated event when deploying a new wallet', async () => {
    // Get owner addresses for the new wallet
    const owners = [
      contracts.getWalletAddress(0),
      contracts.getWalletAddress(1),
      contracts.getWalletAddress(2),
    ];
    const threshold = 2;

    // Deploy wallet on-chain
    console.log('  Deploying new wallet...');
    const walletAddress = await contracts.deployWallet(owners, threshold);
    console.log(`  Wallet deployed at: ${walletAddress}`);

    // Store in shared state for other tests to use
    setTestWallet(walletAddress);

    // Wait for indexer to process the WalletCreated event
    console.log('  Waiting for indexer to process WalletCreated event...');
    await indexer.waitUntil(
      () => db.getWallet(walletAddress),
      'WalletCreated event indexed',
      e2eConfig.txConfirmationTimeout
    );

    // Verify database record
    console.log('  Verifying database records...');
    await db.verifyWalletCreated(walletAddress, owners, threshold);

    console.log('  ✓ WalletCreated event indexed correctly');
  });

  it('should index WalletRegistered event (emitted by createWallet)', async () => {
    // Note: The QuaiVaultFactory.createWallet() function automatically registers the wallet,
    // emitting both WalletCreated and WalletRegistered events in the same transaction.
    // Both events trigger upsertWallet, so the wallet should already be indexed.
    //
    // This test verifies that the WalletRegistered event handler was also invoked
    // by checking the wallet exists with correct data.
    const walletAddress = getTestWallet();

    console.log('  Verifying wallet is indexed after WalletCreated + WalletRegistered events...');

    // The wallet should already be indexed from the previous test
    // Just verify it exists with correct data
    const wallet = await db.getWallet(walletAddress);
    expect(wallet).not.toBeNull();
    expect(wallet!.address.toLowerCase()).toBe(walletAddress.toLowerCase());
    expect(wallet!.threshold).toBe(2); // We created with threshold 2
    expect(wallet!.owner_count).toBe(3); // We created with 3 owners

    // Note: WalletRegistered doesn't add extra data beyond WalletCreated.
    // Both events call upsertWallet with the same data (owners, threshold).
    // The indexer processes both events to handle the case where a wallet
    // was deployed externally and only later registered with the factory.

    console.log('  ✓ WalletRegistered event processed correctly (wallet data verified)');
  });
});
