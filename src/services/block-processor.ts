import { config } from '../config.js';
import { quai } from './quai.js';
import { supabase } from './supabase.js';
import {
  decodeEvent,
  getAllEventTopics,
  getModuleEventTopics,
  getTokenTransferTopic,
  EVENT_SIGNATURES,
} from './decoder.js';
import { handleEvent } from '../events/index.js';
import { handleTokenTransfer } from '../events/token-transfer.js';
import { logger } from '../utils/logger.js';
import { getModuleContractAddresses } from '../utils/modules.js';
import { IndexerLog, DecodedEvent, TokenStandard } from '../types/index.js';

/**
 * Callback context for block processing.
 * Allows callers to react to discovered wallets without coupling to a specific implementation.
 */
export interface BlockProcessorContext {
  /** Set of lowercase wallet addresses currently being tracked */
  trackedWallets: Set<string>;
  /** Map of lowercase token addresses to their standard (ERC20/ERC721) — serves as a cache */
  trackedTokens: Map<string, TokenStandard>;
  /** Called when a new wallet is discovered via factory events */
  onWalletDiscovered: (address: string, event: DecodedEvent) => void;
}

/**
 * Pad a lowercase address to a 32-byte hex topic value.
 * ERC20/ERC721 Transfer events encode indexed addresses as zero-padded 32-byte values.
 */
function addressToTopic(address: string): string {
  return '0x' + address.slice(2).padStart(64, '0');
}

/**
 * Auto-discover a token contract by probing for ERC20 / ERC721 metadata.
 * Uses topic count to determine the likely standard (4 topics = ERC721, 3 = ERC20).
 * Returns the standard if successfully discovered and upserted, or null if not a token.
 */
async function autoDiscoverToken(
  tokenAddress: string,
  log: IndexerLog,
  ctx: BlockProcessorContext,
): Promise<TokenStandard | null> {
  const isLikelyERC721 = log.topics.length === 4;

  if (isLikelyERC721) {
    const metadata = await quai.getERC721Metadata(tokenAddress);
    if (metadata) {
      await supabase.upsertToken({
        address: tokenAddress,
        standard: 'ERC721',
        ...metadata,
        decimals: 0,
        discoveredAtBlock: log.blockNumber,
        discoveredVia: 'transfer',
      });
      ctx.trackedTokens.set(tokenAddress, 'ERC721');
      logger.info({ token: tokenAddress, symbol: metadata.symbol }, 'Auto-discovered ERC721 token via Transfer event');
      return 'ERC721';
    }
  } else {
    // 3 topics — try ERC20 first, fall back to ERC721
    const erc20Meta = await quai.getERC20Metadata(tokenAddress);
    if (erc20Meta) {
      await supabase.upsertToken({
        address: tokenAddress,
        standard: 'ERC20',
        ...erc20Meta,
        discoveredAtBlock: log.blockNumber,
        discoveredVia: 'transfer',
      });
      ctx.trackedTokens.set(tokenAddress, 'ERC20');
      logger.info({ token: tokenAddress, symbol: erc20Meta.symbol }, 'Auto-discovered ERC20 token via Transfer event');
      return 'ERC20';
    }

    // ERC20 probe failed — some NFTs use 3-topic Transfer events too
    const erc721Meta = await quai.getERC721Metadata(tokenAddress);
    if (erc721Meta) {
      await supabase.upsertToken({
        address: tokenAddress,
        standard: 'ERC721',
        ...erc721Meta,
        decimals: 0,
        discoveredAtBlock: log.blockNumber,
        discoveredVia: 'transfer',
      });
      ctx.trackedTokens.set(tokenAddress, 'ERC721');
      logger.info({ token: tokenAddress, symbol: erc721Meta.symbol }, 'Auto-discovered ERC721 token via Transfer event (ERC20 fallback)');
      return 'ERC721';
    }
  }

  return null;
}

/**
 * Process a range of blocks: fetch factory events, wallet events (chunked),
 * module events, token transfer events, sort, decode, and handle.
 *
 * This is the core indexing logic shared between the real-time indexer and
 * the standalone backfill script.
 */
export async function processBlockRange(
  fromBlock: number,
  toBlock: number,
  ctx: BlockProcessorContext
): Promise<void> {
  // 1. Get and process factory events FIRST (new wallet deployments/registrations)
  const factoryLogs = await quai.getLogs(
    config.contracts.quaiVaultFactory,
    [[EVENT_SIGNATURES.WalletCreated, EVENT_SIGNATURES.WalletRegistered]],
    fromBlock,
    toBlock
  );

  for (const log of factoryLogs) {
    const event = decodeEvent(log);
    if (event) {
      await handleEvent(event);
      if (event.name === 'WalletCreated' || event.name === 'WalletRegistered') {
        const walletAddress = event.args.wallet as string;
        ctx.onWalletDiscovered(walletAddress, event);
      }
    }
  }

  // 2. Now fetch wallet and module events (new wallets are now tracked)
  const allLogs: Array<{
    log: IndexerLog;
    priority: number;
  }> = [];

  // Get events from all tracked wallets (chunked to avoid RPC limits)
  if (ctx.trackedWallets.size > 0) {
    const walletAddresses = Array.from(ctx.trackedWallets);
    const chunkSize = config.indexer.getLogsChunkSize;
    const eventTopics = [getAllEventTopics()];

    for (let i = 0; i < walletAddresses.length; i += chunkSize) {
      const chunk = walletAddresses.slice(i, i + chunkSize);
      const walletLogs = await quai.getLogs(
        chunk,
        eventTopics,
        fromBlock,
        toBlock
      );

      for (const log of walletLogs) {
        allLogs.push({ log, priority: 1 });
      }
    }
  }

  // Get events from module contracts
  const moduleAddresses = getModuleContractAddresses();
  if (moduleAddresses.length > 0) {
    const moduleTopics = getModuleEventTopics();
    logger.debug(
      { moduleAddresses, topicCount: moduleTopics.length, fromBlock, toBlock },
      'Querying module contracts for events'
    );

    const moduleLogs = await quai.getLogs(
      moduleAddresses,
      [moduleTopics],
      fromBlock,
      toBlock
    );

    logger.debug(
      { count: moduleLogs.length, fromBlock, toBlock },
      'Module logs retrieved'
    );

    // Build a set for O(1) source validation (defense-in-depth)
    const moduleAddressSet = new Set(moduleAddresses.map((a) => a.toLowerCase()));

    for (const log of moduleLogs) {
      // Validate source address — skip logs from unexpected contracts
      if (!moduleAddressSet.has(log.address.toLowerCase())) {
        logger.warn(
          { address: log.address, topic0: log.topics[0], blockNumber: log.blockNumber },
          'Module log from unexpected address, skipping'
        );
        continue;
      }

      logger.debug(
        { address: log.address, topic0: log.topics[0], blockNumber: log.blockNumber },
        'Module log found'
      );
      allLogs.push({ log, priority: 2 });
    }
  }

  // 3. Wildcard Transfer scan: find ALL ERC20/ERC721 Transfer events where
  //    a tracked wallet is the sender (outflow) or receiver (inflow).
  //    Queries by wallet address in topics rather than by token contract address,
  //    so transfers involving unknown/undiscovered tokens are captured too.
  if (ctx.trackedWallets.size > 0) {
    const transferTopic = getTokenTransferTopic();
    const walletAddresses = Array.from(ctx.trackedWallets);
    const chunkSize = config.indexer.getLogsChunkSize;
    // Track addresses that failed token probing within this batch to avoid re-probing
    const notTokens = new Set<string>();
    const seen = new Set<string>();

    for (let i = 0; i < walletAddresses.length; i += chunkSize) {
      const chunk = walletAddresses.slice(i, i + chunkSize);
      const paddedChunk = chunk.map(addressToTopic);

      // Inflows: Transfer(*, *, walletAddress) — any contract to a tracked vault
      const inflowLogs = await quai.getLogs(
        null,
        [transferTopic, null, paddedChunk],
        fromBlock,
        toBlock
      );

      // Outflows: Transfer(*, walletAddress, *) — a tracked vault to any address
      const outflowLogs = await quai.getLogs(
        null,
        [transferTopic, paddedChunk, null],
        fromBlock,
        toBlock
      );

      for (const log of [...inflowLogs, ...outflowLogs]) {
        if (log.topics.length < 3) continue;
        // Deduplicate (a transfer between two tracked wallets appears in both queries)
        const key = `${log.transactionHash}-${log.index}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const tokenAddr = log.address.toLowerCase();

        // Ensure token is tracked — auto-discover if unknown
        if (!ctx.trackedTokens.has(tokenAddr) && !notTokens.has(tokenAddr)) {
          try {
            const standard = await autoDiscoverToken(tokenAddr, log, ctx);
            if (!standard) {
              notTokens.add(tokenAddr);
              continue;
            }
          } catch (err) {
            logger.warn({ err, token: tokenAddr }, 'Token auto-discovery failed during Transfer scan');
            notTokens.add(tokenAddr);
            continue;
          }
        }

        if (ctx.trackedTokens.has(tokenAddr)) {
          allLogs.push({ log, priority: 3 });
        }
      }
    }
  }

  // Sort by block number, then priority, then log index
  allLogs.sort((a, b) => {
    if (a.log.blockNumber !== b.log.blockNumber) {
      return a.log.blockNumber - b.log.blockNumber;
    }
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.log.index - b.log.index;
  });

  // Process all events
  for (const { log, priority } of allLogs) {
    if (priority === 3) {
      // Token transfer — dispatch directly, bypassing decodeEvent/handleEvent
      const standard = ctx.trackedTokens.get(log.address.toLowerCase());
      if (standard) {
        await handleTokenTransfer(log, standard, ctx.trackedWallets);
      }
    } else {
      const event = decodeEvent(log);
      if (event) {
        await handleEvent(event);
      }
    }
  }
}
