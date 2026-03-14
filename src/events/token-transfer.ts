/**
 * Token Transfer event handler.
 *
 * Processes raw IndexerLog entries for ERC20/ERC721 Transfer and
 * ERC1155 TransferSingle/TransferBatch events.
 * Uses raw topic parsing (NOT decodeEvent) because these events
 * bypass the normal event dispatcher pipeline.
 */

import { quais } from 'quais';
import type { IndexerLog, TokenStandard, TokenTransfer } from '../types/index.js';
import { supabase } from '../services/supabase.js';
import { EVENT_SIGNATURES } from '../services/decoder.js';
import { logger } from '../utils/logger.js';
import { normalizeTokenParticipant } from '../utils/validation.js';

/** Cached ABI coder instance (avoid re-creating per call). */
const abiCoder = quais.AbiCoder.defaultAbiCoder();

/** Maximum items processed from a single TransferBatch event (defense-in-depth). */
const MAX_BATCH_SIZE = 256;

/**
 * Safely parse a hex string as BigInt, returning '0' on failure.
 */
function safeBigInt(hex: string, field: string): string {
  try {
    return BigInt(hex).toString();
  } catch {
    logger.error({ hex: hex.slice(0, 66), field }, 'Invalid BigInt value in token transfer');
    return '0';
  }
}

/**
 * Extract an address from a zero-padded 32-byte topic value.
 * Topics encode addresses as 0x000...address (last 20 bytes of 32).
 */
function addressFromTopic(topic: string): string {
  return '0x' + topic.slice(26);
}

/**
 * Shared logic: record inflow/outflow transfer rows for a single token transfer.
 */
async function recordTransfer(
  tokenAddress: string,
  from: string,
  to: string,
  value: string,
  tokenId: string | undefined,
  batchIndex: number,
  log: IndexerLog,
  trackedWallets: Set<string>,
  standard: TokenStandard
): Promise<void> {
  const isFromVault = trackedWallets.has(from);
  const isToVault = trackedWallets.has(to);

  if (isFromVault) {
    await supabase.addTokenTransfer({
      tokenAddress,
      walletAddress: from,
      fromAddress: from,
      toAddress: to,
      value,
      tokenId,
      batchIndex,
      direction: 'outflow',
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.index,
    });
  }

  if (isToVault) {
    await supabase.addTokenTransfer({
      tokenAddress,
      walletAddress: to,
      fromAddress: from,
      toAddress: to,
      value,
      tokenId,
      batchIndex,
      direction: 'inflow',
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.index,
    });
  }

  if (isFromVault || isToVault) {
    logger.info(
      { token: tokenAddress, from, to, value, tokenId, standard, block: log.blockNumber },
      'Token transfer indexed'
    );
  }
}

/**
 * Handle ERC1155 TransferSingle event.
 * Topics: [sig, operator, from, to]
 * Data: ABI-encoded (uint256 id, uint256 value)
 */
async function handleERC1155TransferSingle(
  log: IndexerLog,
  tokenAddress: string,
  trackedWallets: Set<string>
): Promise<void> {
  if (log.topics.length < 4) return;

  const from = normalizeTokenParticipant(addressFromTopic(log.topics[2]), 'TransferSingle.from');
  const to = normalizeTokenParticipant(addressFromTopic(log.topics[3]), 'TransferSingle.to');

  // Data contains two consecutive uint256 values: id and value (each 32 bytes = 64 hex chars)
  const data = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
  if (data.length < 128) {
    logger.error({ dataLen: data.length, tx: log.transactionHash }, 'TransferSingle data too short');
    return;
  }

  const tokenId = safeBigInt('0x' + data.slice(0, 64), 'TransferSingle.id');
  const value = safeBigInt('0x' + data.slice(64, 128), 'TransferSingle.value');

  await recordTransfer(tokenAddress, from, to, value, tokenId, 0, log, trackedWallets, 'ERC1155');
}

/**
 * Handle ERC1155 TransferBatch event.
 * Topics: [sig, operator, from, to]
 * Data: ABI-encoded (uint256[] ids, uint256[] values) — dynamic arrays
 *
 * Each id/value pair fans out into a separate token_transfer row.
 */
async function handleERC1155TransferBatch(
  log: IndexerLog,
  tokenAddress: string,
  trackedWallets: Set<string>
): Promise<void> {
  if (log.topics.length < 4) return;

  const from = normalizeTokenParticipant(addressFromTopic(log.topics[2]), 'TransferBatch.from');
  const to = normalizeTokenParticipant(addressFromTopic(log.topics[3]), 'TransferBatch.to');

  try {
    const decoded = abiCoder.decode(['uint256[]', 'uint256[]'], log.data);
    const ids = decoded[0] as bigint[];
    const values = decoded[1] as bigint[];

    if (ids.length !== values.length) {
      logger.error(
        { idsLen: ids.length, valuesLen: values.length, tx: log.transactionHash },
        'TransferBatch ids/values length mismatch'
      );
      return;
    }

    const processCount = Math.min(ids.length, MAX_BATCH_SIZE);
    if (ids.length > MAX_BATCH_SIZE) {
      logger.warn(
        { tx: log.transactionHash, total: ids.length, processing: processCount },
        'TransferBatch exceeds max batch size, truncating'
      );
    }

    const isFromVault = trackedWallets.has(from);
    const isToVault = trackedWallets.has(to);
    if (!isFromVault && !isToVault) return;

    const transfers: TokenTransfer[] = [];
    for (let i = 0; i < processCount; i++) {
      const tokenId = ids[i].toString();
      const value = values[i].toString();

      if (isFromVault) {
        transfers.push({
          tokenAddress, walletAddress: from, fromAddress: from, toAddress: to,
          value, tokenId, batchIndex: i, direction: 'outflow',
          blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.index,
        });
      }
      if (isToVault) {
        transfers.push({
          tokenAddress, walletAddress: to, fromAddress: from, toAddress: to,
          value, tokenId, batchIndex: i, direction: 'inflow',
          blockNumber: log.blockNumber, transactionHash: log.transactionHash, logIndex: log.index,
        });
      }
    }

    if (transfers.length > 0) {
      await supabase.addTokenTransfersBatch(transfers);
      logger.info(
        { token: tokenAddress, from, to, items: processCount, standard: 'ERC1155', block: log.blockNumber },
        'ERC1155 TransferBatch indexed'
      );
    }
  } catch (err) {
    logger.error({ err, tx: log.transactionHash }, 'Failed to decode TransferBatch data');
  }
}

export async function handleTokenTransfer(
  log: IndexerLog,
  standard: TokenStandard,
  trackedWallets: Set<string>
): Promise<void> {
  const topic0 = log.topics[0];
  const tokenAddress = log.address.toLowerCase();

  // Check topic0 to determine parsing strategy — ERC1155 has completely different topic layout
  if (topic0 === EVENT_SIGNATURES.TransferBatch) {
    await handleERC1155TransferBatch(log, tokenAddress, trackedWallets);
    return;
  }

  if (topic0 === EVENT_SIGNATURES.TransferSingle) {
    await handleERC1155TransferSingle(log, tokenAddress, trackedWallets);
    return;
  }

  // ERC20/ERC721 Transfer: topics = [sig, from, to, ...]
  const from = normalizeTokenParticipant(addressFromTopic(log.topics[1]), 'Transfer.from');
  const to = normalizeTokenParticipant(addressFromTopic(log.topics[2]), 'Transfer.to');

  let value: string;
  let tokenId: string | undefined;

  if (log.topics.length === 4) {
    // ERC721: tokenId is in topics[3], value is always '1'
    tokenId = safeBigInt(log.topics[3], 'ERC721.tokenId');
    value = '1';
  } else {
    // ERC20: value is in data
    value = log.data === '0x' ? '0' : safeBigInt(log.data, 'ERC20.value');
    tokenId = undefined;
  }

  await recordTransfer(tokenAddress, from, to, value, tokenId, 0, log, trackedWallets, standard);
}
