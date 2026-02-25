/**
 * Token Transfer event handler.
 *
 * Processes raw IndexerLog entries for ERC20/ERC721 Transfer events.
 * Uses raw topic parsing (NOT decodeEvent) to correctly handle both
 * ERC20 (3 topics) and ERC721 (4 topics) which share the same topic0.
 */

import type { IndexerLog, TokenStandard } from '../types/index.js';
import { supabase } from '../services/supabase.js';
import { logger } from '../utils/logger.js';
import { normalizeTokenParticipant } from '../utils/validation.js';

/**
 * Extract an address from a zero-padded 32-byte topic value.
 * Topics encode addresses as 0x000...address (last 20 bytes of 32).
 */
function addressFromTopic(topic: string): string {
  return '0x' + topic.slice(26);
}

export async function handleTokenTransfer(
  log: IndexerLog,
  standard: TokenStandard,
  trackedWallets: Set<string>
): Promise<void> {
  // Extract from/to from indexed topics
  const from = normalizeTokenParticipant(addressFromTopic(log.topics[1]), 'Transfer.from');
  const to = normalizeTokenParticipant(addressFromTopic(log.topics[2]), 'Transfer.to');
  const tokenAddress = log.address.toLowerCase();

  // Determine value and tokenId based on standard / topic count
  let value: string;
  let tokenId: string | undefined;

  if (log.topics.length === 4) {
    // ERC721: tokenId is in topics[3], value is always '1'
    tokenId = BigInt(log.topics[3]).toString();
    value = '1';
  } else {
    // ERC20: value is in data
    value = log.data === '0x' ? '0' : BigInt(log.data).toString();
    tokenId = undefined;
  }

  const isFromVault = trackedWallets.has(from);
  const isToVault = trackedWallets.has(to);

  // Record outflow (vault is sender)
  if (isFromVault) {
    await supabase.addTokenTransfer({
      tokenAddress,
      walletAddress: from,
      fromAddress: from,
      toAddress: to,
      value,
      tokenId,
      direction: 'outflow',
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.index,
    });
  }

  // Record inflow (vault is receiver)
  if (isToVault) {
    await supabase.addTokenTransfer({
      tokenAddress,
      walletAddress: to,
      fromAddress: from,
      toAddress: to,
      value,
      tokenId,
      direction: 'inflow',
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.index,
    });
  }

  if (isFromVault || isToVault) {
    logger.info(
      {
        token: tokenAddress,
        from,
        to,
        value,
        tokenId,
        standard,
        block: log.blockNumber,
      },
      'Token transfer indexed'
    );
  }
}
