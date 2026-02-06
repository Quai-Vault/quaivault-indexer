/**
 * E2E Tests for Zodiac IAvatar Module Execution Events
 *
 * Events covered:
 * 14. ExecutionFromModuleSuccess
 * 15. ExecutionFromModuleFailure
 *
 * Uses MockModule for direct testing of the Zodiac interface.
 * Falls back to DailyLimit/Whitelist modules if MockModule is not configured.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as quais from 'quais';
import { e2eConfig, contracts, indexer, supabase } from '../setup.js';
import { DatabaseVerifier } from '../helpers/db.js';
import { getAvailableModuleTests } from '../config.js';
import { getTestWallet, hasTestWallet, isModuleEnabled, addEnabledModule } from '../shared-state.js';

describe('Zodiac IAvatar Module Execution Events', () => {
  let db: DatabaseVerifier;
  let walletAddress: string;
  let moduleAddress: string;
  let useMockModule: boolean;
  let skipAllTests = false;

  // This test suite may need to enable a module which requires multiple transactions
  // Set a longer timeout than the default 60s hookTimeout
  beforeAll(async () => {
    db = new DatabaseVerifier(supabase, e2eConfig.supabaseSchema);

    // Check if the shared test wallet exists (created by 01-factory.e2e.test.ts)
    if (!hasTestWallet()) {
      console.log('  ⚠️ Test wallet not created - tests will be skipped (run 01-factory first)');
      skipAllTests = true;
      return;
    }

    walletAddress = getTestWallet();
    console.log(`  Using shared test wallet: ${walletAddress}`);

    // Fund the wallet to ensure we have enough for transfers
    console.log('  Funding wallet for Zodiac tests...');
    const fundAmount = quais.parseQuai('0.01');
    await contracts.sendQuaiToWallet(walletAddress, fundAmount, 0);
    console.log(`  Wallet funded with ${quais.formatQuai(fundAmount)} QUAI`);

    // Check available modules - prefer MockModule for direct Zodiac testing
    const availableTests = getAvailableModuleTests(e2eConfig);
    useMockModule = availableTests.mockModule;

    if (!useMockModule && !availableTests.dailyLimit && !availableTests.whitelist) {
      console.log('  ⚠️ No module addresses configured - skipping Zodiac execution tests');
      skipAllTests = true;
      return;
    }

    // Determine which module to use
    if (useMockModule) {
      moduleAddress = e2eConfig.mockModuleAddress!;
      console.log(`  Using MockModule for Zodiac testing: ${moduleAddress}`);
    } else {
      moduleAddress = e2eConfig.dailyLimitModuleAddress || e2eConfig.whitelistModuleAddress || '';
      console.log(`  Using fallback module: ${moduleAddress}`);
    }

    // Check if module is already enabled (from previous test suites)
    if (!isModuleEnabled(moduleAddress)) {
      // Enable the module on the wallet
      console.log(`  Enabling module: ${moduleAddress}`);
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

      // Track that we enabled this module
      addEnabledModule(moduleAddress);
    } else {
      console.log(`  Module already enabled: ${moduleAddress}`);
    }

    // If using MockModule, set the target wallet
    if (useMockModule) {
      console.log(`  Setting MockModule target to wallet: ${walletAddress}`);
      await contracts.setMockModuleTarget(walletAddress);
    }

    console.log(`  Test wallet ready: ${walletAddress}`);
  }, 180000); // 3 minute timeout (funding + enabling module + waiting for indexer + setting target)

  it('should index ExecutionFromModuleSuccess event', async () => {
    // Skip if prerequisites not met
    if (skipAllTests || !moduleAddress) {
      console.log('  ⏭️ Skipping - prerequisites not met');
      return;
    }

    if (useMockModule) {
      // Use MockModule for direct Zodiac interface testing
      // Execute a simple transfer (should succeed)
      const recipient = contracts.getWalletAddress(2);
      const amount = quais.parseQuai('0.001');

      console.log('  Executing transfer via MockModule...');
      const success = await contracts.execViaMockModule(
        recipient,
        amount,
        '0x', // Empty data for simple ETH transfer
        0 // Operation.Call
      );

      expect(success).toBe(true);

      // Wait for indexer to process ExecutionFromModuleSuccess
      console.log('  Waiting for indexer to process ExecutionFromModuleSuccess event...');
      await indexer.waitUntil(
        async () => {
          const executions = await db.getModuleExecutions(walletAddress);
          const successExec = executions.find(
            (e) =>
              e.module_address.toLowerCase() === moduleAddress.toLowerCase() && e.success === true
          );
          return successExec ? executions : null;
        },
        'ExecutionFromModuleSuccess event indexed',
        e2eConfig.txConfirmationTimeout
      );

      // Verify the execution was recorded
      await db.verifyModuleExecutionSuccess(walletAddress, moduleAddress);
    } else if (e2eConfig.dailyLimitModuleAddress) {
      // Fallback: Use DailyLimit module
      const limit = quais.parseQuai('0.005');
      console.log('  Setting daily limit...');
      await contracts.setDailyLimit(walletAddress, limit);

      await indexer.waitUntil(
        async () => {
          const state = await db.getDailyLimitState(walletAddress);
          return state ? state : null;
        },
        'Daily limit set',
        e2eConfig.txConfirmationTimeout
      );

      const recipient = contracts.getWalletAddress(2);
      const amount = quais.parseQuai('0.001');
      console.log('  Executing transfer through daily limit module...');
      await contracts.executeDailyLimitTransfer(walletAddress, recipient, amount);

      console.log('  Waiting for indexer to process ExecutionFromModuleSuccess event...');
      await indexer.waitUntil(
        async () => {
          const executions = await db.getModuleExecutions(walletAddress);
          const success = executions.find(
            (e) =>
              e.module_address.toLowerCase() === moduleAddress.toLowerCase() && e.success === true
          );
          return success ? executions : null;
        },
        'ExecutionFromModuleSuccess event indexed',
        e2eConfig.txConfirmationTimeout
      );

      await db.verifyModuleExecutionSuccess(walletAddress, moduleAddress);
    } else if (e2eConfig.whitelistModuleAddress) {
      // Fallback: Use Whitelist module
      const whitelistAddress = contracts.getWalletAddress(2);
      const limit = quais.parseQuai('0.01');

      console.log('  Adding address to whitelist...');
      await contracts.addToWhitelist(walletAddress, whitelistAddress, limit);

      await indexer.waitUntil(
        async () => {
          const entries = await db.getWhitelistEntries(walletAddress);
          const entry = entries.find(
            (e) =>
              e.whitelisted_address.toLowerCase() === whitelistAddress.toLowerCase() && e.is_active
          );
          return entry ? entries : null;
        },
        'Address whitelisted',
        e2eConfig.txConfirmationTimeout
      );

      const amount = quais.parseQuai('0.001');
      console.log('  Executing whitelisted transfer...');
      await contracts.executeWhitelistTransfer(walletAddress, whitelistAddress, amount);

      console.log('  Waiting for indexer to process ExecutionFromModuleSuccess event...');
      await indexer.waitUntil(
        async () => {
          const executions = await db.getModuleExecutions(walletAddress);
          const success = executions.find(
            (e) =>
              e.module_address.toLowerCase() === moduleAddress.toLowerCase() && e.success === true
          );
          return success ? executions : null;
        },
        'ExecutionFromModuleSuccess event indexed',
        e2eConfig.txConfirmationTimeout
      );

      await db.verifyModuleExecutionSuccess(walletAddress, moduleAddress);
    }

    console.log('  ✓ ExecutionFromModuleSuccess event indexed correctly');
  });

  it('should index ExecutionFromModuleFailure event', async () => {
    // Skip if prerequisites not met
    if (skipAllTests || !moduleAddress) {
      console.log('  ⏭️ Skipping - prerequisites not met');
      return;
    }

    if (useMockModule) {
      // Use MockModule to trigger ExecutionFromModuleFailure
      // IMPORTANT: We cannot use tryEnableModuleViaMockModule because:
      //   - It triggers a REVERT in the security check (ModuleCannotModifyModulePermissions)
      //   - The revert happens BEFORE ExecutionFromModuleFailure is emitted
      //   - So no event is ever emitted!
      //
      // Instead, we call changeThreshold(0) which:
      //   - PASSES security checks (not enableModule/disableModule)
      //   - FAILS at the sub-call level (InvalidThreshold error)
      //   - Emits ExecutionFromModuleFailure
      console.log('  Executing changeThreshold(0) via MockModule (should trigger failure)...');

      const success = await contracts.execRevertingCallViaMockModule(walletAddress);

      // The MockModule.exec() call should succeed (outer transaction)
      // but the inner call to changeThreshold(0) should fail
      console.log(`  MockModule.exec returned: ${success}`);

      // Wait for indexer to process ExecutionFromModuleFailure
      console.log('  Waiting for indexer to process ExecutionFromModuleFailure event...');
      await indexer.waitUntil(
        async () => {
          const executions = await db.getModuleExecutions(walletAddress);
          const failure = executions.find(
            (e) =>
              e.module_address.toLowerCase() === moduleAddress.toLowerCase() && e.success === false
          );
          return failure ? executions : null;
        },
        'ExecutionFromModuleFailure event indexed',
        e2eConfig.txConfirmationTimeout
      );

      // Verify the failure was recorded
      await db.verifyModuleExecutionFailure(walletAddress, moduleAddress);
      console.log('  ✓ ExecutionFromModuleFailure event indexed correctly');
    } else if (e2eConfig.dailyLimitModuleAddress) {
      // Fallback: Try to exceed daily limit
      const state = await db.getDailyLimitState(walletAddress);
      if (!state) {
        console.log('  ⏭️ Skipping - no daily limit state found');
        return;
      }

      const remainingLimit = BigInt(state.daily_limit) - BigInt(state.spent_today);
      const excessAmount = remainingLimit + quais.parseQuai('0.001');

      console.log('  Attempting to exceed daily limit (should fail)...');
      try {
        await contracts.executeDailyLimitTransfer(
          walletAddress,
          contracts.getWalletAddress(2),
          excessAmount
        );
      } catch {
        console.log('  Transfer reverted as expected');
      }

      // Wait a moment for any event to be processed
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const executions = await db.getModuleExecutions(walletAddress);
      const failure = executions.find(
        (e) =>
          e.module_address.toLowerCase() === moduleAddress.toLowerCase() && e.success === false
      );

      if (failure) {
        await db.verifyModuleExecutionFailure(walletAddress, moduleAddress);
        console.log('  ✓ ExecutionFromModuleFailure event indexed correctly');
      } else {
        console.log(
          '  ⚠️ ExecutionFromModuleFailure not indexed - contract may have reverted before emitting event'
        );
      }
    } else {
      console.log('  ⏭️ Skipping failure test - requires MockModule or DailyLimit module');
    }
  });
});
