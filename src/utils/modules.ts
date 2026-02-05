import { config } from '../config.js';

/**
 * Get all configured module contract addresses.
 * Used by both the indexer and backfill script for event filtering.
 */
export function getModuleContractAddresses(): string[] {
  const addresses: string[] = [];

  if (config.contracts.socialRecoveryModule) {
    addresses.push(config.contracts.socialRecoveryModule);
  }
  if (config.contracts.dailyLimitModule) {
    addresses.push(config.contracts.dailyLimitModule);
  }
  if (config.contracts.whitelistModule) {
    addresses.push(config.contracts.whitelistModule);
  }

  return addresses;
}
