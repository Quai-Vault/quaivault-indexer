/**
 * Event Handlers for QuaiVault Indexer
 *
 * ERROR HANDLING STRATEGY
 * =======================
 *
 * 1. TOP-LEVEL ISOLATION: The handleEvent() function wraps all event dispatch
 *    in a try-catch. Errors are logged with full context but NOT re-thrown.
 *    This ensures one malformed event doesn't crash the entire indexer.
 *
 * 2. VALIDATION FIRST: All event handlers use validateEventArgs() to verify
 *    required fields exist before processing. Missing fields throw errors
 *    that are caught by the top-level handler.
 *
 * 3. DATABASE ERRORS: Supabase operations may throw on constraint violations
 *    or connection issues. These propagate to the top-level catch and are
 *    logged. The event is skipped, but indexing continues.
 *
 * 4. RPC ERRORS: Some handlers (e.g., WalletRegistered) make RPC calls.
 *    These have their own retry logic via withRetry(). If all retries fail,
 *    the error propagates to top-level and the event is skipped.
 *
 * RECOVERY BEHAVIOR
 * =================
 * - Skipped events are logged at ERROR level with full context
 * - The indexer continues to the next event
 * - Re-indexing the block range will retry failed events
 * - Circuit breaker at poll loop level handles persistent RPC failures
 *
 * WHEN TO THROW vs LOG-AND-SKIP
 * =============================
 * - THROW: Never from handleEvent() - always let indexer continue
 * - LOG-AND-SKIP: All errors within handleEvent() - maintains indexer liveness
 * - Individual handlers may throw; top-level catch handles them uniformly
 */

import type { DecodedEvent } from '../types/index.js';
import { supabase } from '../services/supabase.js';
import { quai } from '../services/quai.js';
import { logger } from '../utils/logger.js';
import { decodeCalldata, getTransactionDescription } from '../services/decoder.js';

// ABI decoding constants
const ABI_CONSTANTS = {
  MAX_ADDRESS_ARRAY_LENGTH: 1000,  // Sanity limit for decoded arrays
  WORD_SIZE: 64,                   // Hex chars per 32-byte word
  HEX_PREFIX_LENGTH: 2,            // "0x" prefix length
  MIN_ARRAY_DATA_LENGTH: 130,      // 0x + offset (64) + length (64)
  OFFSET_START: 64,                // After 0x prefix, where offset word ends
  LENGTH_START: 64,                // Position of length word in data (after offset)
  LENGTH_END: 128,                 // End of length word
  ARRAY_DATA_START: 128,           // Position where array elements begin
  ADDRESS_HEX_LENGTH: 40,          // 20 bytes = 40 hex chars
};

/**
 * Validates that required fields exist in event args.
 * Throws a descriptive error if any field is missing.
 */
function validateEventArgs<T extends Record<string, unknown>>(
  args: Record<string, unknown>,
  requiredFields: (keyof T)[],
  eventName: string
): T {
  for (const field of requiredFields) {
    if (args[field as string] === undefined) {
      throw new Error(`Missing required field "${String(field)}" in ${eventName} event`);
    }
  }
  return args as T;
}

export async function handleEvent(event: DecodedEvent): Promise<void> {
  try {
    switch (event.name) {
      // QuaiVaultFactory events
      case 'WalletCreated':
        await handleWalletCreated(event);
        break;
      case 'WalletRegistered':
        await handleWalletRegistered(event);
        break;

      // QuaiVault events (formerly MultisigWallet)
      case 'TransactionProposed':
        await handleTransactionProposed(event);
        break;
      case 'TransactionApproved':
        await handleTransactionApproved(event);
        break;
      case 'ApprovalRevoked':
        await handleApprovalRevoked(event);
        break;
      case 'TransactionExecuted':
        await handleTransactionExecuted(event);
        break;
      case 'TransactionCancelled':
        await handleTransactionCancelled(event);
        break;
      case 'OwnerAdded':
        await handleOwnerAdded(event);
        break;
      case 'OwnerRemoved':
        await handleOwnerRemoved(event);
        break;
      case 'ThresholdChanged':
        await handleThresholdChanged(event);
        break;
      case 'ModuleEnabled':
        await handleModuleEnabled(event);
        break;
      case 'ModuleDisabled':
        await handleModuleDisabled(event);
        break;
      case 'Received':
        await handleReceived(event);
        break;

      // Zodiac IAvatar events
      case 'ExecutionFromModuleSuccess':
        await handleExecutionFromModuleSuccess(event);
        break;
      case 'ExecutionFromModuleFailure':
        await handleExecutionFromModuleFailure(event);
        break;

      // Social Recovery Module events
      case 'RecoverySetup':
        await handleRecoverySetup(event);
        break;
      case 'RecoveryInitiated':
        await handleRecoveryInitiated(event);
        break;
      case 'RecoveryApproved':
        await handleRecoveryApproved(event);
        break;
      case 'RecoveryApprovalRevoked':
        await handleRecoveryApprovalRevoked(event);
        break;
      case 'RecoveryExecuted':
        await handleRecoveryExecuted(event);
        break;
      case 'RecoveryCancelled':
        await handleRecoveryCancelled(event);
        break;

      // Daily Limit Module events
      case 'DailyLimitSet':
        await handleDailyLimitSet(event);
        break;
      case 'DailyLimitReset':
        await handleDailyLimitReset(event);
        break;
      case 'DailyLimitTransactionExecuted':
        await handleDailyLimitTransactionExecuted(event);
        break;

      // Whitelist Module events
      case 'AddressWhitelisted':
        await handleAddressWhitelisted(event);
        break;
      case 'AddressRemovedFromWhitelist':
        await handleAddressRemovedFromWhitelist(event);
        break;
      case 'WhitelistTransactionExecuted':
        await handleWhitelistTransactionExecuted(event);
        break;

      default:
        logger.debug({ event: event.name }, 'Unhandled event');
    }
  } catch (err) {
    // Log error with event context but DON'T re-throw
    // This allows the indexer to continue processing other events
    // Use 'err' property - pino auto-serializes Error objects with this key
    logger.error(
      {
        err,
        event: {
          name: event.name,
          address: event.address,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
        },
      },
      'Error handling event - skipping'
    );
    // Don't re-throw: let indexer continue with remaining events
  }
}

// ============================================
// PROXY FACTORY EVENTS
// ============================================

async function handleWalletCreated(event: DecodedEvent): Promise<void> {
  const { wallet, owners, threshold } = validateEventArgs<{
    wallet: string;
    owners: string[];
    threshold: string;
  }>(event.args, ['wallet', 'owners', 'threshold'], 'WalletCreated');

  // Index the wallet
  await supabase.upsertWallet({
    address: wallet,
    threshold: parseInt(threshold),
    ownerCount: owners.length,
    createdAtBlock: event.blockNumber,
    createdAtTx: event.transactionHash,
  });

  // Index all owners in a single batch insert
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

async function handleWalletRegistered(event: DecodedEvent): Promise<void> {
  const { wallet } = validateEventArgs<{
    wallet: string;
    registrar: string;
  }>(event.args, ['wallet'], 'WalletRegistered');

  try {
    // Query the wallet contract to get owners and threshold using direct RPC calls
    const [owners, threshold] = await Promise.all([
      quai.callContract(wallet, 'getOwners()'),
      quai.callContract(wallet, 'threshold()'),
    ]);

    // Decode owners (returns address[])
    const ownerAddresses = decodeAddressArray(owners);
    // Decode threshold (returns uint256)
    const thresholdValue = parseInt(threshold, 16);

    // Index the wallet
    await supabase.upsertWallet({
      address: wallet,
      threshold: thresholdValue,
      ownerCount: ownerAddresses.length,
      createdAtBlock: event.blockNumber,
      createdAtTx: event.transactionHash,
    });

    // Index all owners in a single batch insert
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
 *
 * @param hexData - The 0x-prefixed hex string from quai_call response
 * @returns Array of lowercase address strings
 * @throws Error if data is malformed or unreasonably large
 */
function decodeAddressArray(hexData: string): string[] {
  // Validate input
  if (!hexData || typeof hexData !== 'string') {
    throw new Error('Invalid ABI-encoded address array: data is null or not a string');
  }

  if (!hexData.startsWith('0x')) {
    throw new Error('Invalid ABI-encoded address array: missing 0x prefix');
  }

  // Minimum length: 0x (2) + offset (64) + length (64) = 130 chars
  if (hexData.length < ABI_CONSTANTS.MIN_ARRAY_DATA_LENGTH) {
    throw new Error(
      `Invalid ABI-encoded address array: data too short (${hexData.length} chars, need at least ${ABI_CONSTANTS.MIN_ARRAY_DATA_LENGTH})`
    );
  }

  // Skip 0x prefix
  const data = hexData.slice(ABI_CONSTANTS.HEX_PREFIX_LENGTH);

  // Get array length (bytes 32-63 = chars 64-128)
  const lengthHex = data.slice(ABI_CONSTANTS.LENGTH_START, ABI_CONSTANTS.LENGTH_END);
  const length = parseInt(lengthHex, 16);

  // Sanity check on length
  if (isNaN(length) || length < 0 || length > ABI_CONSTANTS.MAX_ADDRESS_ARRAY_LENGTH) {
    throw new Error(`Invalid ABI-encoded address array: unreasonable length ${length}`);
  }

  // Handle empty array case
  if (length === 0) {
    return [];
  }

  // Validate we have enough data for all addresses
  const expectedLength = ABI_CONSTANTS.ARRAY_DATA_START + (length * ABI_CONSTANTS.WORD_SIZE);
  if (data.length < expectedLength) {
    throw new Error(
      `Invalid ABI-encoded address array: expected ${expectedLength} chars for ${length} addresses, got ${data.length}`
    );
  }

  const addresses: string[] = [];
  for (let i = 0; i < length; i++) {
    // Each address is 32 bytes (64 chars), right-aligned in the word
    const start = ABI_CONSTANTS.ARRAY_DATA_START + (i * ABI_CONSTANTS.WORD_SIZE);
    const addressHex = data.slice(start, start + ABI_CONSTANTS.WORD_SIZE);
    // Take last 40 chars (20 bytes) as the address
    const address = '0x' + addressHex.slice(-ABI_CONSTANTS.ADDRESS_HEX_LENGTH);
    addresses.push(address);
  }
  return addresses;
}

// ============================================
// QUAIVAULT EVENTS (formerly MultisigWallet)
// ============================================

async function handleTransactionProposed(event: DecodedEvent): Promise<void> {
  const { txHash, proposer, to, value, data } = validateEventArgs<{
    txHash: string;
    proposer: string;
    to: string;
    value: string;
    data: string;
  }>(event.args, ['txHash', 'proposer', 'to', 'value', 'data'], 'TransactionProposed');

  // Decode the calldata to determine transaction type
  const decoded = decodeCalldata(to, data || '0x', value);
  const description = getTransactionDescription(decoded);

  await supabase.upsertTransaction({
    walletAddress: event.address,
    txHash: txHash,
    to: to,
    value: value,
    data: data || '0x',
    transactionType: decoded.transactionType,
    decodedParams: decoded.decodedParams,
    status: 'pending',
    confirmationCount: 0,
    submittedBy: proposer,
    submittedAtBlock: event.blockNumber,
    submittedAtTx: event.transactionHash,
  });

  logger.info(
    {
      wallet: event.address,
      txHash,
      proposer,
      to,
      value,
      type: decoded.transactionType,
      description,
    },
    'Transaction proposed'
  );
}

async function handleTransactionApproved(event: DecodedEvent): Promise<void> {
  const { txHash, approver } = validateEventArgs<{
    txHash: string;
    approver: string;
  }>(event.args, ['txHash', 'approver'], 'TransactionApproved');

  await supabase.addConfirmation({
    walletAddress: event.address,
    txHash: txHash,
    ownerAddress: approver,
    confirmedAtBlock: event.blockNumber,
    confirmedAtTx: event.transactionHash,
    isActive: true,
  });

  logger.info(
    { wallet: event.address, txHash, approver },
    'Transaction approved'
  );
}

async function handleApprovalRevoked(event: DecodedEvent): Promise<void> {
  const { txHash, owner } = validateEventArgs<{
    txHash: string;
    owner: string;
  }>(event.args, ['txHash', 'owner'], 'ApprovalRevoked');

  await supabase.revokeConfirmation(
    event.address,
    txHash,
    owner,
    event.blockNumber,
    event.transactionHash
  );

  logger.info(
    { wallet: event.address, txHash, owner },
    'Approval revoked'
  );
}

async function handleTransactionExecuted(event: DecodedEvent): Promise<void> {
  const { txHash, executor } = validateEventArgs<{
    txHash: string;
    executor: string;
  }>(event.args, ['txHash', 'executor'], 'TransactionExecuted');

  await supabase.updateTransactionStatus(
    event.address,
    txHash,
    'executed',
    event.blockNumber,
    event.transactionHash,
    executor // Track who executed the transaction
  );

  logger.info(
    { wallet: event.address, txHash, executor },
    'Transaction executed'
  );
}

async function handleTransactionCancelled(event: DecodedEvent): Promise<void> {
  const { txHash, canceller } = validateEventArgs<{
    txHash: string;
    canceller: string;
  }>(event.args, ['txHash', 'canceller'], 'TransactionCancelled');

  await supabase.updateTransactionStatus(
    event.address,
    txHash,
    'cancelled',
    event.blockNumber,
    event.transactionHash
  );

  logger.info(
    { wallet: event.address, txHash, canceller },
    'Transaction cancelled'
  );
}

async function handleOwnerAdded(event: DecodedEvent): Promise<void> {
  const { owner } = validateEventArgs<{
    owner: string;
  }>(event.args, ['owner'], 'OwnerAdded');

  await supabase.addOwner({
    walletAddress: event.address,
    ownerAddress: owner,
    addedAtBlock: event.blockNumber,
    addedAtTx: event.transactionHash,
    isActive: true,
  });

  await supabase.updateWalletOwnerCount(event.address, 1);

  logger.info({ wallet: event.address, owner }, 'Owner added');
}

async function handleOwnerRemoved(event: DecodedEvent): Promise<void> {
  const { owner } = validateEventArgs<{
    owner: string;
  }>(event.args, ['owner'], 'OwnerRemoved');

  await supabase.removeOwner(
    event.address,
    owner,
    event.blockNumber,
    event.transactionHash
  );

  await supabase.updateWalletOwnerCount(event.address, -1);

  logger.info({ wallet: event.address, owner }, 'Owner removed');
}

async function handleThresholdChanged(event: DecodedEvent): Promise<void> {
  const { threshold } = validateEventArgs<{
    threshold: string;
  }>(event.args, ['threshold'], 'ThresholdChanged');

  await supabase.updateWalletThreshold(event.address, parseInt(threshold));

  logger.info({ wallet: event.address, threshold }, 'Threshold changed');
}

async function handleModuleEnabled(event: DecodedEvent): Promise<void> {
  const { module } = validateEventArgs<{
    module: string;
  }>(event.args, ['module'], 'ModuleEnabled');

  await supabase.addModule({
    walletAddress: event.address,
    moduleAddress: module,
    enabledAtBlock: event.blockNumber,
    enabledAtTx: event.transactionHash,
    isActive: true,
  });

  logger.info({ wallet: event.address, module }, 'Module enabled');
}

async function handleModuleDisabled(event: DecodedEvent): Promise<void> {
  const { module } = validateEventArgs<{
    module: string;
  }>(event.args, ['module'], 'ModuleDisabled');

  await supabase.disableModule(
    event.address,
    module,
    event.blockNumber,
    event.transactionHash
  );

  logger.info({ wallet: event.address, module }, 'Module disabled');
}

async function handleReceived(event: DecodedEvent): Promise<void> {
  const { sender, amount } = validateEventArgs<{
    sender: string;
    amount: string;
  }>(event.args, ['sender', 'amount'], 'Received');

  await supabase.addDeposit({
    walletAddress: event.address,
    senderAddress: sender,
    amount: amount,
    depositedAtBlock: event.blockNumber,
    depositedAtTx: event.transactionHash,
  });

  logger.info(
    { wallet: event.address, sender, amount },
    'Deposit received'
  );
}

// ============================================
// SOCIAL RECOVERY MODULE EVENTS
// ============================================

async function handleRecoverySetup(event: DecodedEvent): Promise<void> {
  const { wallet, guardians, threshold, recoveryPeriod } = validateEventArgs<{
    wallet: string;
    guardians: string[];
    threshold: string;
    recoveryPeriod: string;
  }>(event.args, ['wallet', 'guardians', 'threshold', 'recoveryPeriod'], 'RecoverySetup');

  await supabase.upsertRecoveryConfig({
    walletAddress: wallet,
    guardians: guardians,
    threshold: parseInt(threshold),
    recoveryPeriod: parseInt(recoveryPeriod),
    setupAtBlock: event.blockNumber,
    setupAtTx: event.transactionHash,
  });

  logger.info(
    { wallet, guardians: guardians.length, threshold, recoveryPeriod },
    'Recovery setup configured'
  );
}

async function handleRecoveryInitiated(event: DecodedEvent): Promise<void> {
  const { wallet, recoveryHash, newOwners, newThreshold, initiator } = validateEventArgs<{
    wallet: string;
    recoveryHash: string;
    newOwners: string[];
    newThreshold: string;
    initiator: string;
  }>(event.args, ['wallet', 'recoveryHash', 'newOwners', 'newThreshold', 'initiator'], 'RecoveryInitiated');

  // Get current recovery config for threshold
  const config = await supabase.getRecoveryConfig(wallet);
  const recoveryPeriod = config?.recoveryPeriod || 0;

  // Get the actual block timestamp for accurate execution time calculation
  let executionTime: number;
  try {
    const blockTimestamp = await quai.getBlockTimestamp(event.blockNumber);
    executionTime = blockTimestamp + recoveryPeriod;
  } catch (error) {
    // Fallback to current time if block timestamp unavailable
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn({ error: errorMessage, blockNumber: event.blockNumber }, 'Failed to get block timestamp, using current time');
    executionTime = Math.floor(Date.now() / 1000) + recoveryPeriod;
  }

  await supabase.upsertRecovery({
    walletAddress: wallet,
    recoveryHash: recoveryHash,
    newOwners: newOwners,
    newThreshold: parseInt(newThreshold),
    initiatorAddress: initiator,
    approvalCount: 0, // Contract starts at 0, initiator must call approveRecovery separately
    requiredThreshold: config?.threshold || 1,
    executionTime: executionTime,
    status: 'pending',
    initiatedAtBlock: event.blockNumber,
    initiatedAtTx: event.transactionHash,
  });

  logger.info(
    { wallet, recoveryHash, initiator, newOwners: newOwners.length, newThreshold },
    'Recovery initiated'
  );

  // NOTE: The contract does NOT auto-approve on initiate.
  // Approvals are only tracked when RecoveryApproved events are emitted.
}

async function handleRecoveryApproved(event: DecodedEvent): Promise<void> {
  const { wallet, recoveryHash, guardian } = validateEventArgs<{
    wallet: string;
    recoveryHash: string;
    guardian: string;
  }>(event.args, ['wallet', 'recoveryHash', 'guardian'], 'RecoveryApproved');

  await supabase.addRecoveryApproval({
    walletAddress: wallet,
    recoveryHash: recoveryHash,
    guardianAddress: guardian,
    approvedAtBlock: event.blockNumber,
    approvedAtTx: event.transactionHash,
    isActive: true,
  });

  logger.info(
    { wallet, recoveryHash, guardian },
    'Recovery approved by guardian'
  );
}

async function handleRecoveryApprovalRevoked(
  event: DecodedEvent
): Promise<void> {
  const { wallet, recoveryHash, guardian } = validateEventArgs<{
    wallet: string;
    recoveryHash: string;
    guardian: string;
  }>(event.args, ['wallet', 'recoveryHash', 'guardian'], 'RecoveryApprovalRevoked');

  await supabase.revokeRecoveryApproval(
    wallet,
    recoveryHash,
    guardian,
    event.blockNumber,
    event.transactionHash
  );

  logger.info(
    { wallet, recoveryHash, guardian },
    'Recovery approval revoked'
  );
}

async function handleRecoveryExecuted(event: DecodedEvent): Promise<void> {
  const { wallet, recoveryHash } = validateEventArgs<{
    wallet: string;
    recoveryHash: string;
  }>(event.args, ['wallet', 'recoveryHash'], 'RecoveryExecuted');

  await supabase.updateRecoveryStatus(
    wallet,
    recoveryHash,
    'executed',
    event.blockNumber,
    event.transactionHash
  );

  logger.info(
    { wallet, recoveryHash },
    'Recovery executed'
  );
}

async function handleRecoveryCancelled(event: DecodedEvent): Promise<void> {
  const { wallet, recoveryHash } = validateEventArgs<{
    wallet: string;
    recoveryHash: string;
  }>(event.args, ['wallet', 'recoveryHash'], 'RecoveryCancelled');

  await supabase.updateRecoveryStatus(
    wallet,
    recoveryHash,
    'cancelled',
    event.blockNumber,
    event.transactionHash
  );

  logger.info(
    { wallet, recoveryHash },
    'Recovery cancelled'
  );
}

// ============================================
// DAILY LIMIT MODULE EVENTS
// ============================================

async function handleDailyLimitSet(event: DecodedEvent): Promise<void> {
  const { wallet, limit } = validateEventArgs<{
    wallet: string;
    limit: string;
  }>(event.args, ['wallet', 'limit'], 'DailyLimitSet');

  await supabase.upsertDailyLimit({
    walletAddress: wallet,
    dailyLimit: limit,
    spentToday: '0',
    lastResetDay: new Date().toISOString().split('T')[0],
  });

  logger.info({ wallet, limit }, 'Daily limit set');
}

async function handleDailyLimitReset(event: DecodedEvent): Promise<void> {
  const { wallet } = validateEventArgs<{
    wallet: string;
  }>(event.args, ['wallet'], 'DailyLimitReset');

  await supabase.resetDailyLimit(wallet);

  logger.info({ wallet }, 'Daily limit reset');
}

// ============================================
// WHITELIST MODULE EVENTS
// ============================================

async function handleAddressWhitelisted(event: DecodedEvent): Promise<void> {
  const { wallet, addr, limit } = validateEventArgs<{
    wallet: string;
    addr: string;
    limit: string;
  }>(event.args, ['wallet', 'addr', 'limit'], 'AddressWhitelisted');

  await supabase.addWhitelistEntry({
    walletAddress: wallet,
    whitelistedAddress: addr,
    limit: limit,
    addedAtBlock: event.blockNumber,
    addedAtTx: event.transactionHash,
    isActive: true,
  });

  logger.info(
    { wallet, address: addr, limit },
    'Address added to whitelist'
  );
}

async function handleAddressRemovedFromWhitelist(
  event: DecodedEvent
): Promise<void> {
  const { wallet, addr } = validateEventArgs<{
    wallet: string;
    addr: string;
  }>(event.args, ['wallet', 'addr'], 'AddressRemovedFromWhitelist');

  await supabase.removeWhitelistEntry(
    wallet,
    addr,
    event.blockNumber,
    event.transactionHash
  );

  logger.info(
    { wallet, address: addr },
    'Address removed from whitelist'
  );
}

async function handleWhitelistTransactionExecuted(
  event: DecodedEvent
): Promise<void> {
  const { wallet, to, value } = validateEventArgs<{
    wallet: string;
    to: string;
    value: string;
  }>(event.args, ['wallet', 'to', 'value'], 'WhitelistTransactionExecuted');

  await supabase.addModuleTransaction({
    walletAddress: wallet,
    moduleType: 'whitelist',
    moduleAddress: event.address,
    toAddress: to,
    value: value,
    executedAtBlock: event.blockNumber,
    executedAtTx: event.transactionHash,
  });

  logger.info(
    { wallet, to, value, module: event.address },
    'Whitelist transaction executed'
  );
}

async function handleDailyLimitTransactionExecuted(
  event: DecodedEvent
): Promise<void> {
  const { wallet, to, value, remainingLimit } = validateEventArgs<{
    wallet: string;
    to: string;
    value: string;
    remainingLimit: string;
  }>(event.args, ['wallet', 'to', 'value', 'remainingLimit'], 'DailyLimitTransactionExecuted');

  await supabase.addModuleTransaction({
    walletAddress: wallet,
    moduleType: 'daily_limit',
    moduleAddress: event.address,
    toAddress: to,
    value: value,
    remainingLimit: remainingLimit,
    executedAtBlock: event.blockNumber,
    executedAtTx: event.transactionHash,
  });

  // Update the daily limit state with remaining limit
  await supabase.updateDailyLimitSpent(wallet, remainingLimit);

  logger.info(
    { wallet, to, value, remainingLimit, module: event.address },
    'Daily limit transaction executed'
  );
}

// ============================================
// ZODIAC IAVATAR EVENTS
// ============================================

async function handleExecutionFromModuleSuccess(event: DecodedEvent): Promise<void> {
  const { module } = validateEventArgs<{
    module: string;
  }>(event.args, ['module'], 'ExecutionFromModuleSuccess');

  await supabase.addModuleExecution({
    walletAddress: event.address,
    moduleAddress: module,
    success: true,
    executedAtBlock: event.blockNumber,
    executedAtTx: event.transactionHash,
  });

  logger.info(
    { wallet: event.address, module },
    'Module execution succeeded'
  );
}

async function handleExecutionFromModuleFailure(event: DecodedEvent): Promise<void> {
  const { module } = validateEventArgs<{
    module: string;
  }>(event.args, ['module'], 'ExecutionFromModuleFailure');

  await supabase.addModuleExecution({
    walletAddress: event.address,
    moduleAddress: module,
    success: false,
    executedAtBlock: event.blockNumber,
    executedAtTx: event.transactionHash,
  });

  logger.info(
    { wallet: event.address, module },
    'Module execution failed'
  );
}
