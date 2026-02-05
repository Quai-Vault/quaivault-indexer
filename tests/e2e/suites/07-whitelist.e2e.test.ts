/**
 * E2E Tests for WhitelistModule Events
 *
 * Events covered:
 * 19. AddressWhitelisted
 * 20. AddressRemovedFromWhitelist
 * 21. WhitelistTransactionExecuted
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as quais from 'quais';
import { e2eConfig, contracts, indexer, supabase } from '../setup.js';
import { DatabaseVerifier } from '../helpers/db.js';
import { getAvailableModuleTests } from '../config.js';
import { getTestWallet, hasTestWallet, isModuleEnabled, addEnabledModule } from '../shared-state.js';

describe('WhitelistModule Events', () => {
  let db: DatabaseVerifier;
  let walletAddress: string;
  let moduleAddress: string;
  let whitelistedAddress: string;
  let skipAllTests = false;

  beforeAll(async () => {
    db = new DatabaseVerifier(supabase, e2eConfig.supabaseSchema);

    // Check if whitelist module is configured
    const availableTests = getAvailableModuleTests(e2eConfig);
    if (!availableTests.whitelist) {
      console.log('  ⚠️ WhitelistModule not configured - tests will be skipped');
      skipAllTests = true;
      return;
    }

    moduleAddress = e2eConfig.whitelistModuleAddress!;
    // Use a guardian address as the whitelist target
    whitelistedAddress = contracts.getGuardianAddress(0);

    // Check if the shared test wallet exists (created by 01-factory.e2e.test.ts)
    if (!hasTestWallet()) {
      console.log('  ⚠️ Test wallet not created - tests will be skipped (run 01-factory first)');
      skipAllTests = true;
      return;
    }

    walletAddress = getTestWallet();
    console.log(`  Using shared test wallet: ${walletAddress}`);

    // Check if module is already enabled
    if (!isModuleEnabled(moduleAddress)) {
      // Enable the whitelist module
      console.log(`  Enabling WhitelistModule: ${moduleAddress}`);
      await contracts.enableModule(walletAddress, moduleAddress);

      // Wait for module to be enabled
      await indexer.waitUntil(
        async () => {
          const modules = await db.getWalletModules(walletAddress);
          const module = modules.find(
            (m) => m.module_address.toLowerCase() === moduleAddress.toLowerCase() && m.is_active
          );
          return module ? modules : null;
        },
        'Module enabled',
        e2eConfig.txConfirmationTimeout
      );

      addEnabledModule(moduleAddress);
    } else {
      console.log(`  Module already enabled: ${moduleAddress}`);
    }

    console.log(`  WhitelistModule test setup complete`);
  });

  it('should index AddressWhitelisted event', async () => {
    // Skip if prerequisites not met
    if (skipAllTests) {
      console.log('  ⏭️ Skipping - prerequisites not met');
      return;
    }

    // Add an address to the whitelist with a spending limit
    const limit = quais.parseQuai('0.005');
    console.log(`  Whitelisting address: ${whitelistedAddress} with limit ${quais.formatQuai(limit)} QUAI`);
    await contracts.addToWhitelist(walletAddress, whitelistedAddress, limit);

    // Wait for indexer to process
    console.log('  Waiting for indexer to process AddressWhitelisted event...');
    await indexer.waitUntil(
      async () => {
        const entries = await db.getWhitelistEntries(walletAddress);
        const entry = entries.find(
          (e) =>
            e.whitelisted_address.toLowerCase() === whitelistedAddress.toLowerCase() && e.is_active
        );
        return entry ? entries : null;
      },
      'AddressWhitelisted event indexed',
      e2eConfig.txConfirmationTimeout
    );

    // Verify the address was whitelisted
    await db.verifyAddressWhitelisted(walletAddress, whitelistedAddress);

    // Verify the limit was recorded
    const entries = await db.getWhitelistEntries(walletAddress);
    const entry = entries.find(
      (e) => e.whitelisted_address.toLowerCase() === whitelistedAddress.toLowerCase()
    );
    expect(entry).not.toBeUndefined();
    expect(entry!.limit_amount).toBe(limit.toString());

    console.log('  ✓ AddressWhitelisted event indexed correctly');
  });

  it('should index WhitelistTransactionExecuted event', async () => {
    // Skip if prerequisites not met
    if (skipAllTests) {
      console.log('  ⏭️ Skipping - prerequisites not met');
      return;
    }

    // Execute a transfer to the whitelisted address
    const amount = quais.parseQuai('0.001');
    console.log(`  Executing whitelisted transfer of ${quais.formatQuai(amount)} QUAI...`);
    await contracts.executeWhitelistTransfer(walletAddress, whitelistedAddress, amount);

    // Wait for indexer to process
    console.log('  Waiting for indexer to process WhitelistTransactionExecuted event...');
    await indexer.waitUntil(
      async () => {
        const transactions = await db.getModuleTransactions(walletAddress);
        const tx = transactions.find(
          (t) =>
            t.module_type === 'whitelist' &&
            t.to_address.toLowerCase() === whitelistedAddress.toLowerCase()
        );
        return tx ? transactions : null;
      },
      'WhitelistTransactionExecuted event indexed',
      e2eConfig.txConfirmationTimeout
    );

    // Verify the module transaction was recorded
    await db.verifyModuleTransactionExecuted(walletAddress, 'whitelist');

    // Verify the transaction details
    const transactions = await db.getModuleTransactions(walletAddress);
    const tx = transactions.find(
      (t) =>
        t.module_type === 'whitelist' &&
        t.to_address.toLowerCase() === whitelistedAddress.toLowerCase()
    );
    expect(tx).not.toBeUndefined();
    expect(tx!.value).toBe(amount.toString());

    console.log('  ✓ WhitelistTransactionExecuted event indexed correctly');
  });

  it('should index AddressRemovedFromWhitelist event', async () => {
    // Skip if prerequisites not met
    if (skipAllTests) {
      console.log('  ⏭️ Skipping - prerequisites not met');
      return;
    }

    // Remove the address from the whitelist
    console.log(`  Removing address from whitelist: ${whitelistedAddress}`);
    await contracts.removeFromWhitelist(walletAddress, whitelistedAddress);

    // Wait for indexer to process
    console.log('  Waiting for indexer to process AddressRemovedFromWhitelist event...');
    await indexer.waitUntil(
      async () => {
        const entries = await db.getWhitelistEntries(walletAddress);
        const entry = entries.find(
          (e) => e.whitelisted_address.toLowerCase() === whitelistedAddress.toLowerCase()
        );
        return entry && !entry.is_active ? entries : null;
      },
      'AddressRemovedFromWhitelist event indexed',
      e2eConfig.txConfirmationTimeout
    );

    // Verify the address was removed
    await db.verifyAddressRemovedFromWhitelist(walletAddress, whitelistedAddress);

    // Verify the removal was tracked
    const entries = await db.getWhitelistEntries(walletAddress);
    const entry = entries.find(
      (e) => e.whitelisted_address.toLowerCase() === whitelistedAddress.toLowerCase()
    );
    expect(entry).not.toBeUndefined();
    expect(entry!.is_active).toBe(false);
    expect(entry!.removed_at_block).not.toBeNull();

    console.log('  ✓ AddressRemovedFromWhitelist event indexed correctly');
  });
});
