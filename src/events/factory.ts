/**
 * Factory event handlers: WalletCreated, WalletRegistered
 */

import type { DecodedEvent } from '../types/index.js';
import { supabase } from '../services/supabase.js';
import { quai } from '../services/quai.js';
import { logger } from '../utils/logger.js';
import { validateEventArgs, safeParseInt, safeParseHex } from './helpers.js';

// ABI decoding constants
const ABI_CONSTANTS = {
  MAX_ADDRESS_ARRAY_LENGTH: 1000,  // Sanity limit for decoded arrays
  WORD_SIZE: 64,                   // Hex chars per 32-byte word
  HEX_PREFIX_LENGTH: 2,            // "0x" prefix length
  MIN_ARRAY_DATA_LENGTH: 130,      // 0x + offset (64) + length (64)
  LENGTH_START: 64,                // Position of length word in data (after offset)
  LENGTH_END: 128,                 // End of length word
  ARRAY_DATA_START: 128,           // Position where array elements begin
  ADDRESS_HEX_LENGTH: 40,          // 20 bytes = 40 hex chars
};

/** Query minExecutionDelay from a wallet contract, returning 0 on failure. */
async function queryDelay(wallet: string): Promise<number> {
  try {
    const delayHex = await quai.callContract(wallet, 'minExecutionDelay()');
    return safeParseHex(delayHex, 'minExecutionDelay');
  } catch (err) {
    logger.debug({ err, wallet }, 'Could not query minExecutionDelay (may be 0)');
    return 0;
  }
}

/** Query delegatecallDisabled from a wallet contract, defaulting to true. */
async function queryDelegatecallDisabled(wallet: string): Promise<boolean> {
  try {
    const resultHex = await quai.callContract(wallet, 'delegatecallDisabled()');
    return safeParseHex(resultHex, 'delegatecallDisabled') !== 0;
  } catch (err) {
    logger.debug({ err, wallet }, 'Could not query delegatecallDisabled, defaulting to true');
    return true;
  }
}

// AUDIT: Wallet addresses from WalletCreated/WalletRegistered events are validated
// via validateEventArgs → validateAddress() before any DB writes. The indexer trusts
// on-chain events emitted by the verified factory contract; CREATE2 address derivation
// is not re-verified since the factory enforces this at deployment time.
export async function handleWalletCreated(event: DecodedEvent): Promise<void> {
  const { wallet, owners, threshold } = validateEventArgs<{
    wallet: string;
    owners: string[];
    threshold: string;
  }>(event.args, ['wallet', 'owners', 'threshold'], 'WalletCreated');

  const [minDelay, delegatecallDisabled] = await Promise.all([
    queryDelay(wallet),
    queryDelegatecallDisabled(wallet),
  ]);

  await supabase.upsertWallet({
    address: wallet,
    threshold: safeParseInt(threshold, 'WalletCreated.threshold'),
    ownerCount: 0,
    createdAtBlock: event.blockNumber,
    createdAtTx: event.transactionHash,
    minExecutionDelay: minDelay,
    delegatecallDisabled,
  });

  await supabase.addOwnersBatch(
    owners.map((owner) => ({
      walletAddress: wallet,
      ownerAddress: owner,
      addedAtBlock: event.blockNumber,
      addedAtTx: event.transactionHash,
      isActive: true,
    }))
  );

  logger.info({ wallet, owners: owners.length, threshold }, 'Wallet created');
}

export async function handleWalletRegistered(event: DecodedEvent): Promise<void> {
  const { wallet } = validateEventArgs<{
    wallet: string;
    registrar: string;
  }>(event.args, ['wallet'], 'WalletRegistered');

  try {
    const [owners, threshold, minDelay, delegatecallDisabled] = await Promise.all([
      quai.callContract(wallet, 'getOwners()'),
      quai.callContract(wallet, 'threshold()'),
      queryDelay(wallet),
      queryDelegatecallDisabled(wallet),
    ]);

    const ownerAddresses = decodeAddressArray(owners);
    const thresholdValue = safeParseHex(threshold, 'threshold');

    await supabase.upsertWallet({
      address: wallet,
      threshold: thresholdValue,
      ownerCount: 0,
      createdAtBlock: event.blockNumber,
      createdAtTx: event.transactionHash,
      minExecutionDelay: minDelay,
      delegatecallDisabled,
    });

    await supabase.addOwnersBatch(
      ownerAddresses.map((owner) => ({
        walletAddress: wallet,
        ownerAddress: owner,
        addedAtBlock: event.blockNumber,
        addedAtTx: event.transactionHash,
        isActive: true,
      }))
    );

    logger.info({ wallet, owners: ownerAddresses.length, threshold: thresholdValue }, 'Wallet registered');
  } catch (err) {
    logger.error({ err, wallet }, 'Failed to query wallet contract during registration');
    throw err;
  }
}

/**
 * Decodes an ABI-encoded address array from a contract call response.
 *
 * ABI encoding layout for dynamic address[]:
 * - Bytes 0-31 (offset): Pointer to start of array data (always 0x20 = 32 for single return)
 * - Bytes 32-63 (length): Number of addresses in the array
 * - Bytes 64+: Each address padded to 32 bytes (right-aligned, left-padded with zeros)
 */
function decodeAddressArray(hexData: string): string[] {
  if (!hexData || typeof hexData !== 'string') {
    throw new Error('Invalid ABI-encoded address array: data is null or not a string');
  }

  if (!hexData.startsWith('0x')) {
    throw new Error('Invalid ABI-encoded address array: missing 0x prefix');
  }

  if (hexData.length < ABI_CONSTANTS.MIN_ARRAY_DATA_LENGTH) {
    throw new Error(
      `Invalid ABI-encoded address array: data too short (${hexData.length} chars, need at least ${ABI_CONSTANTS.MIN_ARRAY_DATA_LENGTH})`
    );
  }

  const data = hexData.slice(ABI_CONSTANTS.HEX_PREFIX_LENGTH);

  const lengthHex = data.slice(ABI_CONSTANTS.LENGTH_START, ABI_CONSTANTS.LENGTH_END);
  const length = safeParseHex('0x' + lengthHex, 'arrayLength');

  if (length > ABI_CONSTANTS.MAX_ADDRESS_ARRAY_LENGTH) {
    throw new Error(`Invalid ABI-encoded address array: unreasonable length ${length}`);
  }

  if (length === 0) {
    return [];
  }

  const expectedLength = ABI_CONSTANTS.ARRAY_DATA_START + (length * ABI_CONSTANTS.WORD_SIZE);
  if (data.length < expectedLength) {
    throw new Error(
      `Invalid ABI-encoded address array: expected ${expectedLength} chars for ${length} addresses, got ${data.length}`
    );
  }

  const addresses: string[] = [];
  for (let i = 0; i < length; i++) {
    const start = ABI_CONSTANTS.ARRAY_DATA_START + (i * ABI_CONSTANTS.WORD_SIZE);
    const addressHex = data.slice(start, start + ABI_CONSTANTS.WORD_SIZE);
    const address = '0x' + addressHex.slice(-ABI_CONSTANTS.ADDRESS_HEX_LENGTH);
    addresses.push(address);
  }
  return addresses;
}
