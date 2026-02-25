import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IndexerLog } from '../../src/types/index.js';

// Mock services before importing handler
vi.mock('../../src/services/supabase.js', () => ({
  supabase: {
    addTokenTransfer: vi.fn().mockResolvedValue(undefined),
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
});
