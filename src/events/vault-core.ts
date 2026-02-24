/**
 * Core vault event handlers: Transaction*, Owner*, Threshold, Module*, Received
 */

import type { DecodedEvent } from '../types/index.js';
import { supabase } from '../services/supabase.js';
import { logger } from '../utils/logger.js';
import { decodeCalldata, getTransactionDescription } from '../services/decoder.js';
import { validateEventArgs } from './helpers.js';

export async function handleTransactionProposed(event: DecodedEvent): Promise<void> {
  const { txHash, proposer, to, value, data } = validateEventArgs<{
    txHash: string;
    proposer: string;
    to: string;
    value: string;
    data: string;
  }>(event.args, ['txHash', 'proposer', 'to', 'value', 'data'], 'TransactionProposed');

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

export async function handleTransactionApproved(event: DecodedEvent): Promise<void> {
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

export async function handleApprovalRevoked(event: DecodedEvent): Promise<void> {
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

export async function handleTransactionExecuted(event: DecodedEvent): Promise<void> {
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
    executor
  );

  logger.info(
    { wallet: event.address, txHash, executor },
    'Transaction executed'
  );
}

export async function handleTransactionCancelled(event: DecodedEvent): Promise<void> {
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

export async function handleOwnerAdded(event: DecodedEvent): Promise<void> {
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

export async function handleOwnerRemoved(event: DecodedEvent): Promise<void> {
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

export async function handleThresholdChanged(event: DecodedEvent): Promise<void> {
  const { threshold } = validateEventArgs<{
    threshold: string;
  }>(event.args, ['threshold'], 'ThresholdChanged');

  await supabase.updateWalletThreshold(event.address, parseInt(threshold));

  logger.info({ wallet: event.address, threshold }, 'Threshold changed');
}

export async function handleModuleEnabled(event: DecodedEvent): Promise<void> {
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

export async function handleModuleDisabled(event: DecodedEvent): Promise<void> {
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

export async function handleReceived(event: DecodedEvent): Promise<void> {
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
