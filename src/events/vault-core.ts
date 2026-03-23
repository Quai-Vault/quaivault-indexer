/**
 * Core vault event handlers: Transaction*, Owner*, Threshold, Module*, Received
 */

import type { DecodedEvent, TokenStandard } from '../types/index.js';
import { supabase } from '../services/supabase.js';
import { quai } from '../services/quai.js';
import { logger } from '../utils/logger.js';
import { decodeCalldata, getTransactionDescription, isTokenSelector } from '../services/decoder.js';
import { validateEventArgs, safeParseInt } from './helpers.js';

/**
 * Probe an unknown contract via RPC to determine its token standard.
 * Tries ERC20 → ERC721 → ERC1155 in order, upserts to DB if found.
 * Returns the discovered standard, or undefined if not a token.
 */
async function probeTokenStandard(address: string, blockNumber: number): Promise<TokenStandard | undefined> {
  // ERC20: has symbol(), name(), decimals()
  const erc20 = await quai.getERC20Metadata(address);
  if (erc20) {
    await supabase.upsertToken({
      address,
      standard: 'ERC20',
      ...erc20,
      discoveredAtBlock: blockNumber,
      discoveredVia: 'proposal',
    });
    logger.info({ token: address, symbol: erc20.symbol }, 'Auto-discovered ERC20 token via TransactionProposed');
    return 'ERC20';
  }

  // ERC721: has symbol(), name() but no decimals()
  const erc721 = await quai.getERC721Metadata(address);
  if (erc721) {
    await supabase.upsertToken({
      address,
      standard: 'ERC721',
      ...erc721,
      decimals: 0,
      discoveredAtBlock: blockNumber,
      discoveredVia: 'proposal',
    });
    logger.info({ token: address, symbol: erc721.symbol }, 'Auto-discovered ERC721 token via TransactionProposed');
    return 'ERC721';
  }

  // ERC1155: has uri() or optional symbol()/name()
  const erc1155 = await quai.getERC1155Metadata(address);
  if (erc1155) {
    await supabase.upsertToken({
      address,
      standard: 'ERC1155',
      ...erc1155,
      decimals: 0,
      discoveredAtBlock: blockNumber,
      discoveredVia: 'proposal',
    });
    logger.info({ token: address, symbol: erc1155.symbol }, 'Auto-discovered ERC1155 token via TransactionProposed');
    return 'ERC1155';
  }

  return undefined;
}

export async function handleTransactionProposed(event: DecodedEvent): Promise<void> {
  const { txHash, proposer, to, value, data, expiration, executionDelay } = validateEventArgs<{
    txHash: string;
    proposer: string;
    to: string;
    value: string;
    data: string;
    expiration: string;
    executionDelay: string;
  }>(event.args, ['txHash', 'proposer', 'to', 'value', 'data', 'expiration', 'executionDelay'], 'TransactionProposed');

  // Resolve token standard for the target address.
  // 1. Check DB (cheap, covers previously discovered tokens)
  // 2. If unknown and calldata targets a token function, probe via RPC to auto-discover
  let tokenStandard: TokenStandard | undefined;
  try {
    const tokenInfo = await supabase.getTokenByAddress(to);
    if (tokenInfo) {
      tokenStandard = tokenInfo.standard;
    } else if (isTokenSelector(data || '')) {
      tokenStandard = await probeTokenStandard(to, event.blockNumber);
    }
  } catch (err) {
    logger.debug({ err, to }, 'Token lookup/probe failed, proceeding with default classification');
  }

  const decoded = decodeCalldata(to, data || '0x', value, tokenStandard);
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
    expiration: safeParseInt(expiration, 'TransactionProposed.expiration'),
    executionDelay: safeParseInt(executionDelay, 'TransactionProposed.executionDelay'),
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

  await supabase.updateTransactionStatus(event.address, txHash, 'executed', {
    executed_at_block: event.blockNumber,
    executed_at_tx: event.transactionHash,
    executed_by: executor,
  });

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

  await supabase.updateTransactionStatus(event.address, txHash, 'cancelled', {
    cancelled_at_block: event.blockNumber,
    cancelled_at_tx: event.transactionHash,
  });

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

  logger.info({ wallet: event.address, owner }, 'Owner removed');
}

export async function handleThresholdChanged(event: DecodedEvent): Promise<void> {
  const { threshold } = validateEventArgs<{
    threshold: string;
  }>(event.args, ['threshold'], 'ThresholdChanged');

  await supabase.updateWalletThreshold(event.address, safeParseInt(threshold, 'ThresholdChanged.threshold'));

  logger.info({ wallet: event.address, threshold }, 'Threshold changed');
}

export async function handleEnabledModule(event: DecodedEvent): Promise<void> {
  const { module } = validateEventArgs<{
    module: string;
  }>(event.args, ['module'], 'EnabledModule');

  await supabase.addModule({
    walletAddress: event.address,
    moduleAddress: module,
    enabledAtBlock: event.blockNumber,
    enabledAtTx: event.transactionHash,
    isActive: true,
  });

  logger.info({ wallet: event.address, module }, 'Module enabled');
}

export async function handleDisabledModule(event: DecodedEvent): Promise<void> {
  const { module } = validateEventArgs<{
    module: string;
  }>(event.args, ['module'], 'DisabledModule');

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

export async function handleThresholdReached(event: DecodedEvent): Promise<void> {
  const { txHash, approvedAt, executableAfter } = validateEventArgs<{
    txHash: string;
    approvedAt: string;
    executableAfter: string;
  }>(event.args, ['txHash', 'approvedAt', 'executableAfter'], 'ThresholdReached');

  await supabase.updateTransactionApproval(event.address, txHash, {
    approved_at: safeParseInt(approvedAt, 'ThresholdReached.approvedAt'),
    executable_after: safeParseInt(executableAfter, 'ThresholdReached.executableAfter'),
  });

  logger.info(
    { wallet: event.address, txHash, approvedAt, executableAfter },
    'Threshold reached'
  );
}

export async function handleTransactionFailed(event: DecodedEvent): Promise<void> {
  const { txHash, executor, returnData } = validateEventArgs<{
    txHash: string;
    executor: string;
    returnData: string;
  }>(event.args, ['txHash', 'executor', 'returnData'], 'TransactionFailed');

  await supabase.updateTransactionStatus(event.address, txHash, 'failed', {
    executed_at_block: event.blockNumber,
    executed_at_tx: event.transactionHash,
    executed_by: executor,
    failed_return_data: returnData,
  });

  logger.info(
    { wallet: event.address, txHash, executor },
    'Transaction failed'
  );
}

export async function handleTransactionExpired(event: DecodedEvent): Promise<void> {
  const { txHash } = validateEventArgs<{
    txHash: string;
  }>(event.args, ['txHash'], 'TransactionExpired');

  await supabase.updateTransactionStatus(event.address, txHash, 'expired', {
    cancelled_at_block: event.blockNumber,
    cancelled_at_tx: event.transactionHash,
    is_expired: true,
  });

  logger.info(
    { wallet: event.address, txHash },
    'Transaction expired'
  );
}

export async function handleMinExecutionDelayChanged(event: DecodedEvent): Promise<void> {
  const { newDelay } = validateEventArgs<{
    oldDelay: string;
    newDelay: string;
  }>(event.args, ['newDelay'], 'MinExecutionDelayChanged');

  await supabase.updateWalletDelay(event.address, safeParseInt(newDelay, 'MinExecutionDelayChanged.newDelay'));

  logger.info(
    { wallet: event.address, newDelay },
    'Minimum execution delay changed'
  );
}

export async function handleDelegatecallTargetAdded(event: DecodedEvent): Promise<void> {
  const { target } = validateEventArgs<{
    target: string;
  }>(event.args, ['target'], 'DelegatecallTargetAdded');

  await supabase.addDelegatecallTarget(
    event.address,
    target,
    event.blockNumber,
    event.transactionHash
  );

  logger.info(
    { wallet: event.address, target },
    'DelegateCall target added'
  );
}

export async function handleDelegatecallTargetRemoved(event: DecodedEvent): Promise<void> {
  const { target } = validateEventArgs<{
    target: string;
  }>(event.args, ['target'], 'DelegatecallTargetRemoved');

  await supabase.removeDelegatecallTarget(
    event.address,
    target,
    event.blockNumber,
    event.transactionHash
  );

  logger.info(
    { wallet: event.address, target },
    'DelegateCall target removed'
  );
}
