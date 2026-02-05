/**
 * E2E Tests for QuaiVault Owner Management Events
 *
 * Events covered:
 * 8. OwnerAdded
 * 9. OwnerRemoved
 * 10. ThresholdChanged
 *
 * NOTE: Requires 01-factory tests to run first.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { e2eConfig, contracts, indexer, supabase } from '../setup.js';
import { DatabaseVerifier } from '../helpers/db.js';
import { getTestWallet } from '../shared-state.js';

describe('QuaiVault Owner Events', () => {
  let db: DatabaseVerifier;
  let walletAddress: string;
  let newOwnerAddress: string;

  beforeAll(async () => {
    db = new DatabaseVerifier(supabase, e2eConfig.supabaseSchema);

    // Get the shared test wallet
    walletAddress = getTestWallet();
    console.log(`  Using shared test wallet: ${walletAddress}`);

    // Use a guardian address as the new owner (it's a valid address we control)
    newOwnerAddress = contracts.getGuardianAddress(0);
  });

  it('should index OwnerAdded event', async () => {
    // Add a new owner through multisig
    console.log(`  Adding new owner: ${newOwnerAddress}`);
    await contracts.addOwner(walletAddress, newOwnerAddress);

    // Wait for indexer to process
    console.log('  Waiting for indexer to process OwnerAdded event...');
    await indexer.waitUntil(
      async () => {
        const owners = await db.getWalletOwners(walletAddress);
        const newOwner = owners.find(
          (o) => o.owner_address.toLowerCase() === newOwnerAddress.toLowerCase() && o.is_active
        );
        return newOwner ? owners : null;
      },
      'OwnerAdded event indexed',
      e2eConfig.txConfirmationTimeout
    );

    // Verify the new owner is in the database
    const owners = await db.getWalletOwners(walletAddress);
    const activeOwners = owners.filter((o) => o.is_active);
    expect(activeOwners.length).toBeGreaterThanOrEqual(4); // Original 3 + new owner

    const newOwner = activeOwners.find(
      (o) => o.owner_address.toLowerCase() === newOwnerAddress.toLowerCase()
    );
    expect(newOwner).not.toBeUndefined();

    console.log('  ✓ OwnerAdded event indexed correctly');
  });

  it('should index OwnerRemoved event', async () => {
    // Remove the owner we just added
    console.log(`  Removing owner: ${newOwnerAddress}`);
    await contracts.removeOwner(walletAddress, newOwnerAddress);

    // Wait for indexer to process
    console.log('  Waiting for indexer to process OwnerRemoved event...');
    await indexer.waitUntil(
      async () => {
        const owners = await db.getWalletOwners(walletAddress);
        const removedOwner = owners.find(
          (o) => o.owner_address.toLowerCase() === newOwnerAddress.toLowerCase()
        );
        // Owner record should exist but not be active
        return removedOwner && !removedOwner.is_active ? owners : null;
      },
      'OwnerRemoved event indexed',
      e2eConfig.txConfirmationTimeout
    );

    // Verify the owner is marked as inactive
    const owners = await db.getWalletOwners(walletAddress);
    const removedOwner = owners.find(
      (o) => o.owner_address.toLowerCase() === newOwnerAddress.toLowerCase()
    );
    expect(removedOwner).not.toBeUndefined();
    expect(removedOwner!.is_active).toBe(false);
    expect(removedOwner!.removed_at_block).not.toBeNull();

    console.log('  ✓ OwnerRemoved event indexed correctly');
  });

  it('should index ThresholdChanged event', async () => {
    // Get current threshold
    const walletBefore = await db.getWallet(walletAddress);
    const currentThreshold = walletBefore!.threshold;
    const newThreshold = currentThreshold === 2 ? 1 : 2;

    // Change the threshold
    console.log(`  Changing threshold from ${currentThreshold} to ${newThreshold}`);
    await contracts.changeThreshold(walletAddress, newThreshold);

    // Wait for indexer to process
    console.log('  Waiting for indexer to process ThresholdChanged event...');
    await indexer.waitUntil(
      async () => {
        const wallet = await db.getWallet(walletAddress);
        // Use Number() to handle potential string/number type mismatch from Supabase
        return wallet && Number(wallet.threshold) === newThreshold ? wallet : null;
      },
      'ThresholdChanged event indexed',
      e2eConfig.txConfirmationTimeout
    );

    // Verify the threshold was updated
    const walletAfter = await db.getWallet(walletAddress);
    expect(walletAfter!.threshold).toBe(newThreshold);

    console.log('  ✓ ThresholdChanged event indexed correctly');
  });
});
