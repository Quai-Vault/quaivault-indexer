/**
 * Social recovery event handlers: RecoverySetup, RecoveryInitiated,
 * RecoveryApproved, RecoveryApprovalRevoked, RecoveryExecuted, RecoveryCancelled
 */

import type { DecodedEvent } from '../types/index.js';
import { supabase } from '../services/supabase.js';
import { quai } from '../services/quai.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { validateEventArgs, safeParseInt } from './helpers.js';

/** Matches SocialRecoveryModule contract MAX_GUARDIANS (defense-in-depth). */
const MAX_GUARDIANS = 20;

export async function handleRecoverySetup(event: DecodedEvent): Promise<void> {
  const { wallet, guardians, threshold, recoveryPeriod } = validateEventArgs<{
    wallet: string;
    guardians: string[];
    threshold: string;
    recoveryPeriod: string;
  }>(event.args, ['wallet', 'guardians', 'threshold', 'recoveryPeriod'], 'RecoverySetup');

  if (guardians.length > MAX_GUARDIANS) {
    logger.error(
      { wallet, guardianCount: guardians.length, max: MAX_GUARDIANS, tx: event.transactionHash },
      'RecoverySetup guardians exceed contract MAX_GUARDIANS, skipping invalid event'
    );
    return;
  }

  await supabase.upsertRecoveryConfig({
    walletAddress: wallet,
    guardians: guardians,
    threshold: safeParseInt(threshold, 'RecoverySetup.threshold'),
    recoveryPeriod: safeParseInt(recoveryPeriod, 'RecoverySetup.recoveryPeriod'),
    setupAtBlock: event.blockNumber,
    setupAtTx: event.transactionHash,
  });

  logger.info(
    { wallet, guardians: guardians.length, threshold, recoveryPeriod },
    'Recovery setup configured'
  );
}

export async function handleRecoveryInitiated(event: DecodedEvent): Promise<void> {
  const { wallet, recoveryHash, newOwners, newThreshold, initiator } = validateEventArgs<{
    wallet: string;
    recoveryHash: string;
    newOwners: string[];
    newThreshold: string;
    initiator: string;
  }>(event.args, ['wallet', 'recoveryHash', 'newOwners', 'newThreshold', 'initiator'], 'RecoveryInitiated');

  const recoveryConfig = await supabase.getRecoveryConfig(wallet);
  if (!recoveryConfig) {
    logger.warn({ wallet }, 'RecoveryInitiated without prior RecoverySetup — using defaults');
  }
  const recoveryPeriod = recoveryConfig?.recoveryPeriod || 0;

  const blockTimestamp = await withRetry(
    () => quai.getBlockTimestamp(event.blockNumber),
    { operation: `getBlockTimestamp(${event.blockNumber})` }
  );
  const executionTime = blockTimestamp + recoveryPeriod;
  if (!Number.isSafeInteger(executionTime)) {
    logger.error({ blockTimestamp, recoveryPeriod, wallet }, 'executionTime exceeds safe integer range');
    return;
  }

  const expiration = executionTime + recoveryPeriod;
  if (!Number.isSafeInteger(expiration)) {
    logger.error({ executionTime, recoveryPeriod, wallet }, 'expiration exceeds safe integer range');
    return;
  }

  await supabase.upsertRecovery({
    walletAddress: wallet,
    recoveryHash: recoveryHash,
    newOwners: newOwners,
    newThreshold: safeParseInt(newThreshold, 'RecoveryInitiated.newThreshold'),
    initiatorAddress: initiator,
    approvalCount: 0,
    requiredThreshold: recoveryConfig?.threshold || 1,
    executionTime: executionTime,
    expiration: expiration,
    status: 'pending',
    initiatedAtBlock: event.blockNumber,
    initiatedAtTx: event.transactionHash,
  });

  logger.info(
    { wallet, recoveryHash, initiator, newOwners: newOwners.length, newThreshold },
    'Recovery initiated'
  );
}

export async function handleRecoveryApproved(event: DecodedEvent): Promise<void> {
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

export async function handleRecoveryApprovalRevoked(event: DecodedEvent): Promise<void> {
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

export async function handleRecoveryExecuted(event: DecodedEvent): Promise<void> {
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

export async function handleRecoveryCancelled(event: DecodedEvent): Promise<void> {
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

export async function handleRecoveryInvalidated(event: DecodedEvent): Promise<void> {
  const { wallet, recoveryHash } = validateEventArgs<{
    wallet: string;
    recoveryHash: string;
  }>(event.args, ['wallet', 'recoveryHash'], 'RecoveryInvalidated');

  await supabase.updateRecoveryStatus(
    wallet,
    recoveryHash,
    'invalidated',
    event.blockNumber,
    event.transactionHash
  );

  logger.info(
    { wallet, recoveryHash },
    'Recovery invalidated (superseded by executed recovery)'
  );
}

export async function handleRecoveryExpiredEvent(event: DecodedEvent): Promise<void> {
  const { wallet, recoveryHash } = validateEventArgs<{
    wallet: string;
    recoveryHash: string;
  }>(event.args, ['wallet', 'recoveryHash'], 'RecoveryExpiredEvent');

  await supabase.updateRecoveryStatus(
    wallet,
    recoveryHash,
    'expired',
    event.blockNumber,
    event.transactionHash
  );

  logger.info(
    { wallet, recoveryHash },
    'Recovery expired'
  );
}
