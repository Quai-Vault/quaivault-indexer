/**
 * Social recovery event handlers: RecoverySetup, RecoveryInitiated,
 * RecoveryApproved, RecoveryApprovalRevoked, RecoveryExecuted, RecoveryCancelled
 */

import type { DecodedEvent } from '../types/index.js';
import { supabase } from '../services/supabase.js';
import { quai } from '../services/quai.js';
import { logger } from '../utils/logger.js';
import { validateEventArgs } from './helpers.js';

export async function handleRecoverySetup(event: DecodedEvent): Promise<void> {
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

export async function handleRecoveryInitiated(event: DecodedEvent): Promise<void> {
  const { wallet, recoveryHash, newOwners, newThreshold, initiator } = validateEventArgs<{
    wallet: string;
    recoveryHash: string;
    newOwners: string[];
    newThreshold: string;
    initiator: string;
  }>(event.args, ['wallet', 'recoveryHash', 'newOwners', 'newThreshold', 'initiator'], 'RecoveryInitiated');

  const recoveryConfig = await supabase.getRecoveryConfig(wallet);
  const recoveryPeriod = recoveryConfig?.recoveryPeriod || 0;

  let executionTime: number;
  try {
    const blockTimestamp = await quai.getBlockTimestamp(event.blockNumber);
    executionTime = blockTimestamp + recoveryPeriod;
  } catch (err) {
    logger.warn({ err, blockNumber: event.blockNumber }, 'Failed to get block timestamp, using current time');
    executionTime = Math.floor(Date.now() / 1000) + recoveryPeriod;
  }

  await supabase.upsertRecovery({
    walletAddress: wallet,
    recoveryHash: recoveryHash,
    newOwners: newOwners,
    newThreshold: parseInt(newThreshold),
    initiatorAddress: initiator,
    approvalCount: 0,
    requiredThreshold: recoveryConfig?.threshold || 1,
    executionTime: executionTime,
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
