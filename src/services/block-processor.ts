import { LRUCache } from 'lru-cache';
import { config } from '../config.js';
import { quai } from './quai.js';
import { supabase } from './supabase.js';
import {
  decodeEvent,
  getWalletEventTopics,
  getModuleEventTopics,
  getTokenTransferTopic,
  getERC1155TransferTopics,
  EVENT_SIGNATURES,
} from './decoder.js';
import { handleEvent } from '../events/index.js';
import { handleTokenTransfer } from '../events/token-transfer.js';
import { logger } from '../utils/logger.js';
import { getModuleContractAddresses } from '../utils/modules.js';
import { IndexerLog, DecodedEvent, TokenStandard } from '../types/index.js';
import { health } from './health.js';

/**
 * Callback context for block processing.
 * Allows callers to react to discovered wallets without coupling to a specific implementation.
 */
export interface BlockProcessorContext {
  /** Set of lowercase wallet addresses currently being tracked */
  trackedWallets: Set<string>;
  /** Map of lowercase token addresses to their standard (ERC20/ERC721/ERC1155) — serves as a cache */
  trackedTokens: Map<string, TokenStandard>;
  /** Addresses confirmed not to be tokens — bounded LRU to prevent unbounded memory growth */
  notTokenCache: LRUCache<string, boolean>;
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

/** Maximum number of new tokens auto-discovered per processBlockRange call. */
const MAX_DISCOVERIES_PER_BATCH = 50;

/**
 * Mutable state shared across transfer scan loops within a single processBlockRange call.
 */
interface DiscoveryState {
  count: number;
  discovered: boolean;
}

/**
 * Configuration for a wildcard transfer scan (ERC20/721 or ERC1155).
 */
interface TransferScanOpts {
  /** Topic filter for the event signature(s) */
  topics: string | string[];
  /** Topic index (0-based) where the inflow wallet address appears */
  inflowTopicIndex: number;
  /** Topic index (0-based) where the outflow wallet address appears */
  outflowTopicIndex: number;
  /** Minimum number of topics for a log to be valid */
  minTopics: number;
  /** Whether logs are ERC1155 (affects auto-discovery probe) */
  isERC1155: boolean;
}

/**
 * Scan for transfer events matching tracked wallets and auto-discover unknown tokens.
 * Shared between ERC20/721 and ERC1155 scan paths.
 */
async function scanTransferLogs(
  opts: TransferScanOpts,
  walletAddresses: string[],
  fromBlock: number,
  toBlock: number,
  ctx: BlockProcessorContext,
  notTokens: LRUCache<string, boolean>,
  seen: Set<string>,
  allLogs: Array<{ log: IndexerLog; priority: number }>,
  discovery: DiscoveryState,
): Promise<void> {
  const chunkSize = config.indexer.getLogsChunkSize;

  for (let i = 0; i < walletAddresses.length; i += chunkSize) {
    const chunk = walletAddresses.slice(i, i + chunkSize);
    const paddedChunk = chunk.map(addressToTopic);

    // Build topic filters with wallet addresses in the correct position
    const inflowTopics: (string | string[] | null)[] = [opts.topics];
    for (let t = 1; t <= opts.inflowTopicIndex; t++) {
      inflowTopics.push(t === opts.inflowTopicIndex ? paddedChunk : null);
    }

    const outflowTopics: (string | string[] | null)[] = [opts.topics];
    for (let t = 1; t <= opts.outflowTopicIndex; t++) {
      outflowTopics.push(t === opts.outflowTopicIndex ? paddedChunk : null);
    }

    const [inflowLogs, outflowLogs] = await Promise.all([
      quai.getLogs(null, inflowTopics, fromBlock, toBlock),
      quai.getLogs(null, outflowTopics, fromBlock, toBlock),
    ]);

    for (const log of [...inflowLogs, ...outflowLogs]) {
      if (log.topics.length < opts.minTopics) continue;
      const key = `${log.transactionHash}-${log.index}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const tokenAddr = log.address.toLowerCase();

      if (!ctx.trackedTokens.has(tokenAddr) && !notTokens.has(tokenAddr)) {
        if (discovery.count >= MAX_DISCOVERIES_PER_BATCH) {
          logger.debug({ token: tokenAddr }, 'Discovery budget exhausted, deferring');
          continue;
        }
        try {
          const standard = await autoDiscoverToken(tokenAddr, log, ctx, opts.isERC1155);
          if (!standard) {
            notTokens.set(tokenAddr, true);
            continue;
          }
          discovery.count++;
          discovery.discovered = true;
        } catch (err) {
          logger.warn({ err, token: tokenAddr }, 'Token auto-discovery failed during Transfer scan');
          notTokens.set(tokenAddr, true);
          continue;
        }
      }

      if (ctx.trackedTokens.has(tokenAddr)) {
        allLogs.push({ log, priority: 3 });
      }
    }
  }
}

/**
 * Auto-discover a token contract by probing for ERC20 / ERC721 / ERC1155 metadata.
 * For Transfer events, uses topic count to determine the likely standard (4 topics = ERC721, 3 = ERC20).
 * For TransferSingle/TransferBatch events, directly probes for ERC1155 metadata.
 * Returns the standard if successfully discovered and upserted, or null if not a token.
 */
async function autoDiscoverToken(
  tokenAddress: string,
  log: IndexerLog,
  ctx: BlockProcessorContext,
  isERC1155Event: boolean = false,
): Promise<TokenStandard | null> {
  // ERC1155: identified by TransferSingle/TransferBatch topic0
  if (isERC1155Event) {
    const metadata = await quai.getERC1155Metadata(tokenAddress);
    if (metadata) {
      await supabase.upsertToken({
        address: tokenAddress,
        standard: 'ERC1155',
        ...metadata,
        decimals: 0,
        discoveredAtBlock: log.blockNumber,
        discoveredVia: 'transfer',
      });
      ctx.trackedTokens.set(tokenAddress, 'ERC1155');
      logger.info({ token: tokenAddress, symbol: metadata.symbol }, 'Auto-discovered ERC1155 token via TransferSingle/Batch event');
      return 'ERC1155';
    }
    return null;
  }

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
export interface ProcessBlockRangeResult {
  /** True if any new tokens were auto-discovered during this block range */
  tokensDiscovered: boolean;
}

export async function processBlockRange(
  fromBlock: number,
  toBlock: number,
  ctx: BlockProcessorContext
): Promise<ProcessBlockRangeResult> {
  let tokensDiscovered = false;
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
    const eventTopics = [getWalletEventTopics()];

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

  // 3. Wildcard Transfer scans: find token transfer events where a tracked wallet
  //    is the sender or receiver. Uses scanTransferLogs helper for both ERC20/721
  //    and ERC1155, with a shared discovery budget to cap RPC probes per batch.
  const discovery: DiscoveryState = { count: 0, discovered: false };

  if (ctx.trackedWallets.size > 0) {
    const walletAddresses = Array.from(ctx.trackedWallets);
    const seen = new Set<string>();

    // ERC20/ERC721 Transfer(from, to, value/tokenId)
    // Topic layout: [sig, from, to] — wallet in topic1 (outflow) or topic2 (inflow)
    await scanTransferLogs(
      {
        topics: getTokenTransferTopic(),
        inflowTopicIndex: 2,
        outflowTopicIndex: 1,
        minTopics: 3,
        isERC1155: false,
      },
      walletAddresses, fromBlock, toBlock, ctx,
      ctx.notTokenCache, seen, allLogs, discovery,
    );

    // ERC1155 TransferSingle/TransferBatch(operator, from, to, ...)
    // Topic layout: [sig, operator, from, to] — wallet in topic2 (outflow) or topic3 (inflow)
    const seen1155 = new Set<string>();

    await scanTransferLogs(
      {
        topics: getERC1155TransferTopics(),
        inflowTopicIndex: 3,
        outflowTopicIndex: 2,
        minTopics: 4,
        isERC1155: true,
      },
      walletAddresses, fromBlock, toBlock, ctx,
      ctx.notTokenCache, seen1155, allLogs, discovery,
    );
  }

  tokensDiscovered = discovery.discovered;

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

  // Process all events (individual try/catch to prevent one bad event from crashing the batch)
  for (const { log, priority } of allLogs) {
    try {
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
    } catch (err) {
      logger.error(
        { err, block: log.blockNumber, tx: log.transactionHash, logIndex: log.index },
        'Failed to process event, skipping'
      );
      health.incrementSkippedEvents();
    }
  }

  return { tokensDiscovered };
}
