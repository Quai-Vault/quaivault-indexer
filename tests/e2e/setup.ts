import { beforeAll, afterAll } from 'vitest';
import { SupabaseClient } from '@supabase/supabase-js';
import { loadE2EConfig, validateE2EConfig, E2EConfig } from './config.js';
import { createSupabaseClient } from './helpers/db.js';
import { IndexerHelper } from './helpers/indexer.js';
import { ContractHelper } from './helpers/contracts.js';

// Global test state - exported for use in test suites
export let e2eConfig: E2EConfig;
export let supabase: SupabaseClient;
export let indexer: IndexerHelper;
export let contracts: ContractHelper;

beforeAll(async () => {
  console.log('\n🚀 E2E Test Suite Starting...\n');

  // Load and validate config
  e2eConfig = loadE2EConfig();

  try {
    validateE2EConfig(e2eConfig);
  } catch (error) {
    console.error('❌ Configuration Error:');
    console.error((error as Error).message);
    console.error('\nMake sure to copy .env.e2e.example to .env.e2e and fill in your values.');
    throw error;
  }

  // Initialize Supabase client
  supabase = createSupabaseClient(e2eConfig);

  // Initialize indexer helper
  indexer = new IndexerHelper(
    `http://localhost:${e2eConfig.healthCheckPort}`,
    e2eConfig.indexerPollInterval
  );

  // Initialize contract helper (uses HTTP RPC for reliability)
  contracts = new ContractHelper(e2eConfig.rpcUrl, e2eConfig.ownerPrivateKeys, e2eConfig);

  // Wait for provider to be ready (quais initializes asynchronously)
  console.log('⏳ Waiting for RPC provider to initialize...');
  await contracts.waitForReady();
  console.log('✅ RPC provider ready\n');

  // Verify indexer is running and connected
  console.log('📡 Checking indexer health...');
  try {
    await indexer.verifyHealthy();
    console.log('✅ Indexer is healthy and connected\n');
  } catch (error) {
    console.error('❌ Indexer health check failed:');
    console.error((error as Error).message);
    console.error('\nMake sure the indexer is running with: SUPABASE_SCHEMA=dev npm run dev');
    throw error;
  }

  // Log test wallet addresses (not keys)
  logTestWallets();
});

afterAll(async () => {
  // Cleanup provider connections
  if (contracts) {
    await contracts.cleanup();
  }

  console.log('\n✅ E2E Test Suite Complete\n');
});

function logTestWallets(): void {
  console.log('📋 Test Wallets:');
  console.log('   Owners:');
  for (let i = 0; i < e2eConfig.ownerPrivateKeys.length; i++) {
    const address = contracts.getWalletAddress(i);
    console.log(`     [${i}] ${address}`);
  }
  console.log('   Guardians:');
  for (let i = 0; i < e2eConfig.guardianPrivateKeys.length; i++) {
    const address = contracts.getGuardianAddress(i);
    console.log(`     [${i}] ${address}`);
  }
  console.log('');
}
