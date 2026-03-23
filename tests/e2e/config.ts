import { config as dotenvConfig } from 'dotenv';
import path from 'path';

// Load E2E-specific environment file
dotenvConfig({ path: path.resolve(process.cwd(), '.env.e2e') });

/**
 * E2E Test Configuration Interface
 */
export interface E2EConfig {
  // Blockchain
  rpcUrl: string;
  chainId: number;

  // Test wallets
  ownerPrivateKeys: string[];
  guardianPrivateKeys: string[];

  // Contract addresses
  quaiVaultFactoryAddress: string;
  quaiVaultImplementation: string;
  socialRecoveryModuleAddress?: string;
  multiSendCallOnlyAddress?: string;
  mockModuleAddress?: string;
  mockErc721Address?: string;
  mockErc1155Address?: string;

  // Supabase
  supabaseUrl: string;
  supabaseServiceKey: string;
  supabaseSchema: string;

  // Health check
  healthCheckPort: number;

  // Timing
  indexerPollInterval: number;
  txConfirmationTimeout: number;
}

/**
 * Load E2E configuration from environment variables
 */
export function loadE2EConfig(): E2EConfig {
  const ownerKeys = [
    process.env.OWNER_PRIVATE_KEY_1,
    process.env.OWNER_PRIVATE_KEY_2,
    process.env.OWNER_PRIVATE_KEY_3,
  ].filter((key): key is string => !!key);

  const guardianKeys = [
    process.env.GUARDIAN_PRIVATE_KEY_1,
    process.env.GUARDIAN_PRIVATE_KEY_2,
  ].filter((key): key is string => !!key);

  return {
    // Blockchain - base URL without shard path (usePathing: true handles routing)
    rpcUrl: process.env.QUAI_RPC_URL || 'https://rpc.orchard.quai.network',
    chainId: parseInt(process.env.QUAI_CHAIN_ID || '9000', 10),

    // Test wallets
    ownerPrivateKeys: ownerKeys,
    guardianPrivateKeys: guardianKeys,

    // Contract addresses (SHORT names matching .env.e2e)
    quaiVaultFactoryAddress: process.env.QUAIVAULT_FACTORY || '',
    quaiVaultImplementation: process.env.QUAIVAULT_IMPLEMENTATION || '',
    socialRecoveryModuleAddress: process.env.SOCIAL_RECOVERY_MODULE,
    multiSendCallOnlyAddress: process.env.MULTISEND_CALL_ONLY,
    mockModuleAddress: process.env.MOCK_MODULE,
    mockErc721Address: process.env.MOCK_ERC721,
    mockErc1155Address: process.env.MOCK_ERC1155,

    // Supabase
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || '',
    supabaseSchema: process.env.SUPABASE_SCHEMA || 'dev',

    // Health check
    healthCheckPort: parseInt(process.env.HEALTH_CHECK_PORT || '8081', 10),

    // Timing
    indexerPollInterval: parseInt(process.env.INDEXER_POLL_INTERVAL || '15000', 10),
    txConfirmationTimeout: parseInt(process.env.TX_CONFIRMATION_TIMEOUT || '60000', 10),
  };
}

/**
 * Validate E2E configuration
 * @throws Error if required configuration is missing
 */
export function validateE2EConfig(config: E2EConfig): void {
  const errors: string[] = [];

  // Required fields
  if (!config.rpcUrl) errors.push('QUAI_RPC_URL is required');
  if (!config.quaiVaultFactoryAddress) errors.push('QUAIVAULT_FACTORY is required');
  if (!config.quaiVaultImplementation) errors.push('QUAIVAULT_IMPLEMENTATION is required');
  if (!config.supabaseUrl) errors.push('SUPABASE_URL is required');
  if (!config.supabaseServiceKey) errors.push('SUPABASE_SERVICE_KEY is required');

  // Minimum wallet requirements
  if (config.ownerPrivateKeys.length < 3) {
    errors.push('At least 3 owner private keys are required (OWNER_PRIVATE_KEY_1, _2, _3)');
  }
  if (config.guardianPrivateKeys.length < 2) {
    errors.push('At least 2 guardian private keys are required (GUARDIAN_PRIVATE_KEY_1, _2)');
  }

  // Validate private key format
  for (let i = 0; i < config.ownerPrivateKeys.length; i++) {
    const key = config.ownerPrivateKeys[i];
    if (!key.startsWith('0x') || key.length !== 66) {
      errors.push(`OWNER_PRIVATE_KEY_${i + 1} must be a 64-character hex string starting with 0x`);
    }
  }

  for (let i = 0; i < config.guardianPrivateKeys.length; i++) {
    const key = config.guardianPrivateKeys[i];
    if (!key.startsWith('0x') || key.length !== 66) {
      errors.push(`GUARDIAN_PRIVATE_KEY_${i + 1} must be a 64-character hex string starting with 0x`);
    }
  }

  // Validate address format
  const addressFields = [
    { name: 'quaiVaultFactoryAddress', value: config.quaiVaultFactoryAddress },
    { name: 'quaiVaultImplementation', value: config.quaiVaultImplementation },
  ];

  for (const { name, value } of addressFields) {
    if (value && (!value.startsWith('0x') || value.length !== 42)) {
      errors.push(`${name} must be a valid Ethereum address`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`E2E Configuration Errors:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
}

/**
 * Check which module tests can be run based on configuration
 */
export function getAvailableModuleTests(config: E2EConfig): {
  socialRecovery: boolean;
  multiSend: boolean;
  mockModule: boolean;
  mockErc721: boolean;
  mockErc1155: boolean;
} {
  return {
    socialRecovery: !!config.socialRecoveryModuleAddress,
    multiSend: !!config.multiSendCallOnlyAddress,
    mockModule: !!config.mockModuleAddress,
    mockErc721: !!config.mockErc721Address,
    mockErc1155: !!config.mockErc1155Address,
  };
}
