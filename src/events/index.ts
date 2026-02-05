import type { DecodedEvent } from '../types/index.js';
import { supabase } from '../services/supabase.js';
import { quai } from '../services/quai.js';
import { logger } from '../utils/logger.js';
import { decodeCalldata, getTransactionDescription } from '../services/decoder.js';

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
  } catch (error) {
    logger.error({ error, event }, 'Error handling event');
    throw error;
  }
}

// ============================================
// PROXY FACTORY EVENTS
// ============================================

async function handleWalletCreated(event: DecodedEvent): Promise<void> {
  const { wallet, owners, threshold } = event.args as {
    wallet: string;
    owners: string[];
    threshold: string;
  };

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
  const { wallet } = event.args as {
    wallet: string;
    registrar: string;
  };

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
  } catch (error) {
    logger.error({ error, wallet }, 'Failed to query wallet contract during registration');
    throw error;
  }
}

// Helper to decode address array from ABI-encoded response
function decodeAddressArray(hexData: string): string[] {
  // Validate input
  if (!hexData || typeof hexData !== 'string') {
    throw new Error('Invalid ABI-encoded address array: data is null or not a string');
  }

  if (!hexData.startsWith('0x')) {
    throw new Error('Invalid ABI-encoded address array: missing 0x prefix');
  }

  // Minimum length: 0x (2) + offset (64) + length (64) = 130 chars
  if (hexData.length < 130) {
    throw new Error(`Invalid ABI-encoded address array: data too short (${hexData.length} chars, need at least 130)`);
  }

  // Skip 0x prefix and first 64 chars (offset to array data)
  const data = hexData.slice(2);
  // Get array length (next 64 chars = 32 bytes)
  const lengthHex = data.slice(64, 128);
  const length = parseInt(lengthHex, 16);

  // Sanity check on length
  if (isNaN(length) || length < 0 || length > 1000) {
    throw new Error(`Invalid ABI-encoded address array: unreasonable length ${length}`);
  }

  // Handle empty array case
  if (length === 0) {
    return [];
  }

  // Validate we have enough data for all addresses
  const expectedLength = 128 + (length * 64);
  if (data.length < expectedLength) {
    throw new Error(`Invalid ABI-encoded address array: expected ${expectedLength} chars for ${length} addresses, got ${data.length}`);
  }

  const addresses: string[] = [];
  for (let i = 0; i < length; i++) {
    // Each address is 32 bytes (64 chars), right-padded
    const start = 128 + (i * 64);
    const addressHex = data.slice(start, start + 64);
    // Take last 40 chars (20 bytes) as the address
    const address = '0x' + addressHex.slice(-40);
    addresses.push(address);
  }
  return addresses;
}

// ============================================
// QUAIVAULT EVENTS (formerly MultisigWallet)
// ============================================

async function handleTransactionProposed(event: DecodedEvent): Promise<void> {
  const { txHash, proposer, to, value, data } = event.args as {
    txHash: string;
    proposer: string;
    to: string;
    value: string;
    data: string;
  };

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
  const { txHash, approver } = event.args as {
    txHash: string;
    approver: string;
  };

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
  const { txHash, owner } = event.args as {
    txHash: string;
    owner: string;
  };

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
  const { txHash, executor } = event.args as { txHash: string; executor: string };

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
  const { txHash, canceller } = event.args as { txHash: string; canceller: string };

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
  const { owner } = event.args as { owner: string };

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
  const { owner } = event.args as { owner: string };

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
  const { threshold } = event.args as { threshold: string };

  await supabase.updateWalletThreshold(event.address, parseInt(threshold));

  logger.info({ wallet: event.address, threshold }, 'Threshold changed');
}

async function handleModuleEnabled(event: DecodedEvent): Promise<void> {
  const { module } = event.args as { module: string };

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
  const { module } = event.args as { module: string };

  await supabase.disableModule(
    event.address,
    module,
    event.blockNumber,
    event.transactionHash
  );

  logger.info({ wallet: event.address, module }, 'Module disabled');
}

async function handleReceived(event: DecodedEvent): Promise<void> {
  const { sender, amount } = event.args as {
    sender: string;
    amount: string;
  };

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
  const { wallet, guardians, threshold, recoveryPeriod } = event.args as {
    wallet: string;
    guardians: string[];
    threshold: string;
    recoveryPeriod: string;
  };

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
  const { wallet, recoveryHash, newOwners, newThreshold, initiator } =
    event.args as {
      wallet: string;
      recoveryHash: string;
      newOwners: string[];
      newThreshold: string;
      initiator: string;
    };

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
  const { wallet, recoveryHash, guardian } = event.args as {
    wallet: string;
    recoveryHash: string;
    guardian: string;
  };

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
  const { wallet, recoveryHash, guardian } = event.args as {
    wallet: string;
    recoveryHash: string;
    guardian: string;
  };

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
  const { wallet, recoveryHash } = event.args as {
    wallet: string;
    recoveryHash: string;
  };

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
  const { wallet, recoveryHash } = event.args as {
    wallet: string;
    recoveryHash: string;
  };

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
  const { wallet, limit } = event.args as {
    wallet: string;
    limit: string;
  };

  await supabase.upsertDailyLimit({
    walletAddress: wallet,
    dailyLimit: limit,
    spentToday: '0',
    lastResetDay: new Date().toISOString().split('T')[0],
  });

  logger.info({ wallet, limit }, 'Daily limit set');
}

async function handleDailyLimitReset(event: DecodedEvent): Promise<void> {
  const { wallet } = event.args as { wallet: string };

  await supabase.resetDailyLimit(wallet);

  logger.info({ wallet }, 'Daily limit reset');
}

// ============================================
// WHITELIST MODULE EVENTS
// ============================================

async function handleAddressWhitelisted(event: DecodedEvent): Promise<void> {
  const { wallet, addr, limit } = event.args as {
    wallet: string;
    addr: string;
    limit: string;
  };

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
  const { wallet, addr } = event.args as {
    wallet: string;
    addr: string;
  };

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
  const { wallet, to, value } = event.args as {
    wallet: string;
    to: string;
    value: string;
  };

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
  const { wallet, to, value, remainingLimit } = event.args as {
    wallet: string;
    to: string;
    value: string;
    remainingLimit: string;
  };

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
  const { module } = event.args as { module: string };

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
  const { module } = event.args as { module: string };

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
