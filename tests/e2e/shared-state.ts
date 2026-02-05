/**
 * Shared state for E2E tests
 *
 * This module maintains state across test files so tests can build on each other.
 * The factory test creates the wallet, and subsequent tests use it.
 *
 * Uses globalThis to ensure state persists across module reloads within the same process.
 */

export interface SharedTestState {
  /** The main test wallet address created by factory tests */
  walletAddress?: string;
  /** Whether the wallet has been funded */
  walletFunded?: boolean;
  /** Module addresses that have been enabled */
  enabledModules?: string[];
}

// Use globalThis to persist state across module reloads (vitest isolates module contexts)
const GLOBAL_STATE_KEY = '__e2e_shared_state__';

// Initialize shared state on globalThis if not already present
if (!(globalThis as unknown as Record<string, unknown>)[GLOBAL_STATE_KEY]) {
  (globalThis as unknown as Record<string, SharedTestState>)[GLOBAL_STATE_KEY] = {};
}

// Reference to the persistent state
export const sharedState: SharedTestState = (globalThis as unknown as Record<string, SharedTestState>)[GLOBAL_STATE_KEY];

/**
 * Set the test wallet address (called by factory tests)
 */
export function setTestWallet(address: string): void {
  sharedState.walletAddress = address;
  console.log(`  [SharedState] Wallet address set: ${address}`);
}

/**
 * Get the test wallet address
 * @throws Error if wallet hasn't been created yet
 */
export function getTestWallet(): string {
  if (!sharedState.walletAddress) {
    throw new Error(
      'Test wallet not created yet. Make sure factory tests run first (01-factory.e2e.test.ts)'
    );
  }
  return sharedState.walletAddress;
}

/**
 * Check if test wallet exists
 */
export function hasTestWallet(): boolean {
  return !!sharedState.walletAddress;
}

/**
 * Mark wallet as funded
 */
export function markWalletFunded(): void {
  sharedState.walletFunded = true;
}

/**
 * Check if wallet has been funded
 */
export function isWalletFunded(): boolean {
  return !!sharedState.walletFunded;
}

/**
 * Track enabled module
 */
export function addEnabledModule(moduleAddress: string): void {
  if (!sharedState.enabledModules) {
    sharedState.enabledModules = [];
  }
  sharedState.enabledModules.push(moduleAddress);
}

/**
 * Check if a module is enabled
 */
export function isModuleEnabled(moduleAddress: string): boolean {
  return sharedState.enabledModules?.includes(moduleAddress) ?? false;
}

/**
 * Remove a module from enabled list (called when module is disabled)
 */
export function removeEnabledModule(moduleAddress: string): void {
  if (!sharedState.enabledModules) return;
  const index = sharedState.enabledModules.findIndex(
    (m) => m.toLowerCase() === moduleAddress.toLowerCase()
  );
  if (index !== -1) {
    sharedState.enabledModules.splice(index, 1);
  }
}
