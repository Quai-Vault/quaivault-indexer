/**
 * E2E Tests for QuaiVault Module Events
 *
 * Events covered:
 * 11. ModuleEnabled
 * 12. ModuleDisabled
 *
 * NOTE: Requires 01-factory tests to run first.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { e2eConfig, contracts, indexer, supabase } from '../setup.js';
import { DatabaseVerifier } from '../helpers/db.js';
import { getAvailableModuleTests } from '../config.js';
import { getTestWallet, addEnabledModule, removeEnabledModule } from '../shared-state.js';

describe('QuaiVault Module Events', () => {
  let db: DatabaseVerifier;
  let walletAddress: string;
  let moduleAddress: string;

  beforeAll(async () => {
    db = new DatabaseVerifier(supabase, e2eConfig.supabaseSchema);

    // Get the shared test wallet
    walletAddress = getTestWallet();
    console.log(`  Using shared test wallet: ${walletAddress}`);

    // Check if module addresses are configured
    const availableTests = getAvailableModuleTests(e2eConfig);
    if (!availableTests.dailyLimit && !availableTests.whitelist && !availableTests.socialRecovery) {
      console.log('  ⚠️ No module addresses configured - tests will use a mock address');
    }

    // Use the first available module address, or a mock address for testing
    moduleAddress =
      e2eConfig.dailyLimitModuleAddress ||
      e2eConfig.whitelistModuleAddress ||
      e2eConfig.socialRecoveryModuleAddress ||
      '0x0000000000000000000000000000000000000001'; // Sentinel address for testing

    console.log(`  Module address: ${moduleAddress}`);
  });

  it('should index ModuleEnabled event', async () => {
    // Enable the module on the wallet
    console.log(`  Enabling module: ${moduleAddress}`);
    await contracts.enableModule(walletAddress, moduleAddress);

    // Wait for indexer to process
    console.log('  Waiting for indexer to process ModuleEnabled event...');
    await indexer.waitUntil(
      async () => {
        const modules = await db.getWalletModules(walletAddress);
        const enabledModule = modules.find(
          (m) => m.module_address.toLowerCase() === moduleAddress.toLowerCase() && m.is_active
        );
        return enabledModule ? modules : null;
      },
      'ModuleEnabled event indexed',
      e2eConfig.txConfirmationTimeout
    );

    // Verify the module is enabled
    await db.verifyModuleEnabled(walletAddress, moduleAddress);

    // Track in shared state for other tests
    addEnabledModule(moduleAddress);

    console.log('  ✓ ModuleEnabled event indexed correctly');
  });

  it('should index ModuleDisabled event', async () => {
    // The Zodiac module storage uses a linked list, so we need to specify the previous module
    // For the first (and only) module, prevModule is the sentinel address
    const sentinelAddress = '0x0000000000000000000000000000000000000001';

    // Disable the module
    console.log(`  Disabling module: ${moduleAddress}`);
    await contracts.disableModule(walletAddress, sentinelAddress, moduleAddress);

    // Wait for indexer to process
    console.log('  Waiting for indexer to process ModuleDisabled event...');
    await indexer.waitUntil(
      async () => {
        const modules = await db.getWalletModules(walletAddress);
        const disabledModule = modules.find(
          (m) => m.module_address.toLowerCase() === moduleAddress.toLowerCase()
        );
        return disabledModule && !disabledModule.is_active ? modules : null;
      },
      'ModuleDisabled event indexed',
      e2eConfig.txConfirmationTimeout
    );

    // Verify the module is disabled
    await db.verifyModuleDisabled(walletAddress, moduleAddress);

    // Verify the module record has disabled_at fields populated
    const modules = await db.getWalletModules(walletAddress);
    const disabledModule = modules.find(
      (m) => m.module_address.toLowerCase() === moduleAddress.toLowerCase()
    );
    expect(disabledModule!.disabled_at_block).not.toBeNull();
    expect(disabledModule!.disabled_at_tx).not.toBeNull();

    // Update shared state so subsequent tests know this module is disabled
    removeEnabledModule(moduleAddress);

    console.log('  ✓ ModuleDisabled event indexed correctly');
  });
});
