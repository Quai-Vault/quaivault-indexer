import { describe, it, expect, vi, beforeEach } from 'vitest';
import { quais } from 'quais';
import type { IndexerLog } from '../../src/types/index.js';

// Mock services before importing handler
vi.mock('../../src/services/supabase.js', () => ({
  supabase: {
    addTokenTransfer: vi.fn().mockResolvedValue(undefined),
    addTokenTransfersBatch: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { handleTokenTransfer } from '../../src/events/token-transfer.js';
import { supabase } from '../../src/services/supabase.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TRANSFER_SINGLE_TOPIC = quais.id('TransferSingle(address,address,address,uint256,uint256)');
const TRANSFER_BATCH_TOPIC = quais.id('TransferBatch(address,address,address,uint256[],uint256[])');

// Pad address to 32 bytes (topic format)
function padAddress(addr: string): string {
  return '0x' + addr.slice(2).padStart(64, '0');
}

// Realistic addresses
const VAULT_A = '0x1234567890abcdef1234567890abcdef12345678';
const VAULT_B = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const EXTERNAL = '0x9999999999999999999999999999999999999999';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const TOKEN_ADDR = '0x002b2596ecf05c93a31ff916e8b456df6c77c750';

function makeLog(overrides: Partial<IndexerLog> = {}): IndexerLog {
  return {
    address: TOKEN_ADDR,
    topics: [TRANSFER_TOPIC, padAddress(EXTERNAL), padAddress(VAULT_A)],
    data: '0x' + BigInt('1000000000000000000').toString(16).padStart(64, '0'),
    blockNumber: 100,
    transactionHash: '0x' + 'a'.repeat(64),
    transactionIndex: 0,
    blockHash: '0x' + 'b'.repeat(64),
    index: 5,
    removed: false,
    ...overrides,
  };
}

describe('handleTokenTransfer', () => {
  let trackedWallets: Set<string>;

  beforeEach(() => {
    vi.clearAllMocks();
    trackedWallets = new Set([VAULT_A, VAULT_B]);
  });

  it('records inflow when vault is recipient (ERC20)', async () => {
    const log = makeLog({
      topics: [TRANSFER_TOPIC, padAddress(EXTERNAL), padAddress(VAULT_A)],
    });

    await handleTokenTransfer(log, 'ERC20', trackedWallets);

    expect(supabase.addTokenTransfer).toHaveBeenCalledTimes(1);
    expect(supabase.addTokenTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenAddress: TOKEN_ADDR,
        walletAddress: VAULT_A,
        fromAddress: EXTERNAL,
        toAddress: VAULT_A,
        direction: 'inflow',
        blockNumber: 100,
        logIndex: 5,
      })
    );
  });

  it('records outflow when vault is sender (ERC20)', async () => {
    const log = makeLog({
      topics: [TRANSFER_TOPIC, padAddress(VAULT_A), padAddress(EXTERNAL)],
    });

    await handleTokenTransfer(log, 'ERC20', trackedWallets);

    expect(supabase.addTokenTransfer).toHaveBeenCalledTimes(1);
    expect(supabase.addTokenTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        walletAddress: VAULT_A,
        direction: 'outflow',
      })
    );
  });

  it('records both inflow and outflow for vault-to-vault transfer', async () => {
    const log = makeLog({
      topics: [TRANSFER_TOPIC, padAddress(VAULT_A), padAddress(VAULT_B)],
    });

    await handleTokenTransfer(log, 'ERC20', trackedWallets);

    expect(supabase.addTokenTransfer).toHaveBeenCalledTimes(2);

    // Outflow for sender vault
    expect(supabase.addTokenTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        walletAddress: VAULT_A,
        direction: 'outflow',
      })
    );

    // Inflow for receiver vault
    expect(supabase.addTokenTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        walletAddress: VAULT_B,
        direction: 'inflow',
      })
    );
  });

  it('does not record transfer when neither party is tracked', async () => {
    const OTHER = '0x1111111111111111111111111111111111111111';
    const log = makeLog({
      topics: [TRANSFER_TOPIC, padAddress(EXTERNAL), padAddress(OTHER)],
    });

    await handleTokenTransfer(log, 'ERC20', trackedWallets);

    expect(supabase.addTokenTransfer).not.toHaveBeenCalled();
  });

  it('handles ERC721 transfer (4 topics) — extracts tokenId', async () => {
    const tokenId = '42';
    const log = makeLog({
      topics: [
        TRANSFER_TOPIC,
        padAddress(EXTERNAL),
        padAddress(VAULT_A),
        '0x' + BigInt(tokenId).toString(16).padStart(64, '0'),
      ],
      data: '0x',
    });

    await handleTokenTransfer(log, 'ERC721', trackedWallets);

    expect(supabase.addTokenTransfer).toHaveBeenCalledTimes(1);
    expect(supabase.addTokenTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        value: '1',
        tokenId: '42',
        direction: 'inflow',
      })
    );
  });

  it('handles zero address (mint) as inflow to vault', async () => {
    const log = makeLog({
      topics: [TRANSFER_TOPIC, padAddress(ZERO_ADDR), padAddress(VAULT_A)],
    });

    await handleTokenTransfer(log, 'ERC20', trackedWallets);

    expect(supabase.addTokenTransfer).toHaveBeenCalledTimes(1);
    expect(supabase.addTokenTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAddress: ZERO_ADDR,
        toAddress: VAULT_A,
        direction: 'inflow',
      })
    );
  });

  it('handles zero address (burn) as outflow from vault', async () => {
    const log = makeLog({
      topics: [TRANSFER_TOPIC, padAddress(VAULT_A), padAddress(ZERO_ADDR)],
    });

    await handleTokenTransfer(log, 'ERC20', trackedWallets);

    expect(supabase.addTokenTransfer).toHaveBeenCalledTimes(1);
    expect(supabase.addTokenTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAddress: VAULT_A,
        toAddress: ZERO_ADDR,
        direction: 'outflow',
      })
    );
  });

  it('correctly parses ERC20 value from data field', async () => {
    const amount = '5000000000000000000'; // 5 tokens with 18 decimals
    const log = makeLog({
      topics: [TRANSFER_TOPIC, padAddress(EXTERNAL), padAddress(VAULT_A)],
      data: '0x' + BigInt(amount).toString(16).padStart(64, '0'),
    });

    await handleTokenTransfer(log, 'ERC20', trackedWallets);

    expect(supabase.addTokenTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        value: amount,
        tokenId: undefined,
      })
    );
  });

  it('correctly extracts address from zero-padded 32-byte topic', async () => {
    // Verify raw topic parsing — address should be last 20 bytes
    const addr = '0xaabbccddee1234567890aabbccddee1234567890';
    trackedWallets.add(addr);

    const log = makeLog({
      topics: [TRANSFER_TOPIC, padAddress(EXTERNAL), padAddress(addr)],
    });

    await handleTokenTransfer(log, 'ERC20', trackedWallets);

    expect(supabase.addTokenTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        toAddress: addr,
        walletAddress: addr,
      })
    );
  });

  // ============================================
  // ERC1155 TransferSingle Tests
  // ============================================

  it('handles ERC1155 TransferSingle inflow', async () => {
    const OPERATOR = '0x7777777777777777777777777777777777777777';
    // Data: uint256 id=42, uint256 value=100
    const data = '0x'
      + BigInt(42).toString(16).padStart(64, '0')
      + BigInt(100).toString(16).padStart(64, '0');

    const log = makeLog({
      topics: [TRANSFER_SINGLE_TOPIC, padAddress(OPERATOR), padAddress(EXTERNAL), padAddress(VAULT_A)],
      data,
    });

    await handleTokenTransfer(log, 'ERC1155', trackedWallets);

    expect(supabase.addTokenTransfer).toHaveBeenCalledTimes(1);
    expect(supabase.addTokenTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenAddress: TOKEN_ADDR,
        walletAddress: VAULT_A,
        fromAddress: EXTERNAL,
        toAddress: VAULT_A,
        value: '100',
        tokenId: '42',
        batchIndex: 0,
        direction: 'inflow',
      })
    );
  });

  it('handles ERC1155 TransferSingle outflow', async () => {
    const OPERATOR = '0x7777777777777777777777777777777777777777';
    const data = '0x'
      + BigInt(7).toString(16).padStart(64, '0')
      + BigInt(50).toString(16).padStart(64, '0');

    const log = makeLog({
      topics: [TRANSFER_SINGLE_TOPIC, padAddress(OPERATOR), padAddress(VAULT_A), padAddress(EXTERNAL)],
      data,
    });

    await handleTokenTransfer(log, 'ERC1155', trackedWallets);

    expect(supabase.addTokenTransfer).toHaveBeenCalledTimes(1);
    expect(supabase.addTokenTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        walletAddress: VAULT_A,
        direction: 'outflow',
        tokenId: '7',
        value: '50',
      })
    );
  });

  it('handles ERC1155 TransferSingle vault-to-vault (records both directions)', async () => {
    const OPERATOR = '0x7777777777777777777777777777777777777777';
    const data = '0x'
      + BigInt(1).toString(16).padStart(64, '0')
      + BigInt(10).toString(16).padStart(64, '0');

    const log = makeLog({
      topics: [TRANSFER_SINGLE_TOPIC, padAddress(OPERATOR), padAddress(VAULT_A), padAddress(VAULT_B)],
      data,
    });

    await handleTokenTransfer(log, 'ERC1155', trackedWallets);

    expect(supabase.addTokenTransfer).toHaveBeenCalledTimes(2);
    expect(supabase.addTokenTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: VAULT_A, direction: 'outflow' })
    );
    expect(supabase.addTokenTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: VAULT_B, direction: 'inflow' })
    );
  });

  it('handles ERC1155 TransferSingle mint (from zero address)', async () => {
    const OPERATOR = '0x7777777777777777777777777777777777777777';
    const data = '0x'
      + BigInt(1).toString(16).padStart(64, '0')
      + BigInt(1000).toString(16).padStart(64, '0');

    const log = makeLog({
      topics: [TRANSFER_SINGLE_TOPIC, padAddress(OPERATOR), padAddress(ZERO_ADDR), padAddress(VAULT_A)],
      data,
    });

    await handleTokenTransfer(log, 'ERC1155', trackedWallets);

    expect(supabase.addTokenTransfer).toHaveBeenCalledTimes(1);
    expect(supabase.addTokenTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAddress: ZERO_ADDR,
        toAddress: VAULT_A,
        direction: 'inflow',
        value: '1000',
      })
    );
  });

  // ============================================
  // ERC1155 TransferBatch Tests
  // ============================================

  it('handles ERC1155 TransferBatch — fans out to one row per id/value pair via batch insert', async () => {
    const OPERATOR = '0x7777777777777777777777777777777777777777';
    const abiCoder = quais.AbiCoder.defaultAbiCoder();
    const data = abiCoder.encode(
      ['uint256[]', 'uint256[]'],
      [[1n, 2n, 3n], [10n, 20n, 30n]]
    );

    const log = makeLog({
      topics: [TRANSFER_BATCH_TOPIC, padAddress(OPERATOR), padAddress(EXTERNAL), padAddress(VAULT_A)],
      data,
    });

    await handleTokenTransfer(log, 'ERC1155', trackedWallets);

    // Uses batch insert — 1 call with 3 inflow records
    expect(supabase.addTokenTransfersBatch).toHaveBeenCalledTimes(1);
    const records = vi.mocked(supabase.addTokenTransfersBatch).mock.calls[0][0];
    expect(records).toHaveLength(3);
    expect(records[0]).toEqual(expect.objectContaining({ tokenId: '1', value: '10', batchIndex: 0, direction: 'inflow' }));
    expect(records[1]).toEqual(expect.objectContaining({ tokenId: '2', value: '20', batchIndex: 1, direction: 'inflow' }));
    expect(records[2]).toEqual(expect.objectContaining({ tokenId: '3', value: '30', batchIndex: 2, direction: 'inflow' }));
  });

  it('handles ERC1155 TransferBatch vault-to-vault (2x fan-out via batch insert)', async () => {
    const OPERATOR = '0x7777777777777777777777777777777777777777';
    const abiCoder = quais.AbiCoder.defaultAbiCoder();
    const data = abiCoder.encode(
      ['uint256[]', 'uint256[]'],
      [[10n, 20n], [5n, 15n]]
    );

    const log = makeLog({
      topics: [TRANSFER_BATCH_TOPIC, padAddress(OPERATOR), padAddress(VAULT_A), padAddress(VAULT_B)],
      data,
    });

    await handleTokenTransfer(log, 'ERC1155', trackedWallets);

    // 2 ids × 2 vaults = 4 records in a single batch insert
    expect(supabase.addTokenTransfersBatch).toHaveBeenCalledTimes(1);
    const records = vi.mocked(supabase.addTokenTransfersBatch).mock.calls[0][0];
    expect(records).toHaveLength(4);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ walletAddress: VAULT_A, direction: 'outflow', tokenId: '10', batchIndex: 0 }),
      expect.objectContaining({ walletAddress: VAULT_B, direction: 'inflow', tokenId: '10', batchIndex: 0 }),
      expect.objectContaining({ walletAddress: VAULT_A, direction: 'outflow', tokenId: '20', batchIndex: 1 }),
      expect.objectContaining({ walletAddress: VAULT_B, direction: 'inflow', tokenId: '20', batchIndex: 1 }),
    ]));
  });

  // ============================================
  // Security Boundary Tests
  // ============================================

  it('truncates ERC1155 TransferBatch exceeding MAX_BATCH_SIZE (256)', async () => {
    const OPERATOR = '0x7777777777777777777777777777777777777777';
    const abiCoder = quais.AbiCoder.defaultAbiCoder();
    // Create 300 items — should be truncated to 256
    const ids = Array.from({ length: 300 }, (_, i) => BigInt(i + 1));
    const values = Array.from({ length: 300 }, (_, i) => BigInt((i + 1) * 10));
    const data = abiCoder.encode(['uint256[]', 'uint256[]'], [ids, values]);

    const log = makeLog({
      topics: [TRANSFER_BATCH_TOPIC, padAddress(OPERATOR), padAddress(EXTERNAL), padAddress(VAULT_A)],
      data,
    });

    await handleTokenTransfer(log, 'ERC1155', trackedWallets);

    expect(supabase.addTokenTransfersBatch).toHaveBeenCalledTimes(1);
    const records = vi.mocked(supabase.addTokenTransfersBatch).mock.calls[0][0];
    expect(records).toHaveLength(256); // Truncated from 300
  });

  it('skips ERC1155 TransferBatch when neither party is tracked', async () => {
    const OPERATOR = '0x7777777777777777777777777777777777777777';
    const OTHER = '0x1111111111111111111111111111111111111111';
    const abiCoder = quais.AbiCoder.defaultAbiCoder();
    const data = abiCoder.encode(['uint256[]', 'uint256[]'], [[1n], [10n]]);

    const log = makeLog({
      topics: [TRANSFER_BATCH_TOPIC, padAddress(OPERATOR), padAddress(EXTERNAL), padAddress(OTHER)],
      data,
    });

    await handleTokenTransfer(log, 'ERC1155', trackedWallets);

    expect(supabase.addTokenTransfersBatch).not.toHaveBeenCalled();
    expect(supabase.addTokenTransfer).not.toHaveBeenCalled();
  });
});
