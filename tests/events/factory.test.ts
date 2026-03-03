import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DecodedEvent } from '../../src/types/index.js';

// Mock services before importing handlers
vi.mock('../../src/services/supabase.js', () => ({
  supabase: {
    upsertWallet: vi.fn().mockResolvedValue(undefined),
    addOwnersBatch: vi.fn().mockResolvedValue(undefined),
    updateWalletDelay: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/quai.js', () => ({
  quai: {
    callContract: vi.fn().mockResolvedValue('0x'),
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

import { handleWalletCreated, handleWalletRegistered } from '../../src/events/factory.js';
import { supabase } from '../../src/services/supabase.js';
import { quai } from '../../src/services/quai.js';

function makeEvent(overrides: Partial<DecodedEvent> = {}): DecodedEvent {
  return {
    name: 'WalletCreated',
    address: '0xfactory',
    blockNumber: 100,
    transactionHash: '0xtx123',
    logIndex: 0,
    args: {},
    ...overrides,
  };
}

describe('factory event handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleWalletCreated', () => {
    it('calls upsertWallet and addOwnersBatch with correct args', async () => {
      const event = makeEvent({
        args: {
          wallet: '0xWALLET',
          owners: ['0xOwner1', '0xOwner2'],
          threshold: '2',
        },
      });

      await handleWalletCreated(event);

      expect(supabase.upsertWallet).toHaveBeenCalledWith({
        address: '0xWALLET',
        threshold: 2,
        ownerCount: 2,
        createdAtBlock: 100,
        createdAtTx: '0xtx123',
      });

      expect(supabase.addOwnersBatch).toHaveBeenCalledWith([
        {
          walletAddress: '0xWALLET',
          ownerAddress: '0xOwner1',
          addedAtBlock: 100,
          addedAtTx: '0xtx123',
          isActive: true,
        },
        {
          walletAddress: '0xWALLET',
          ownerAddress: '0xOwner2',
          addedAtBlock: 100,
          addedAtTx: '0xtx123',
          isActive: true,
        },
      ]);
    });

    it('throws on missing required field', async () => {
      const event = makeEvent({
        args: { wallet: '0xWALLET' }, // missing owners + threshold
      });

      await expect(handleWalletCreated(event)).rejects.toThrow(
        'Missing required field "owners" in WalletCreated event'
      );
    });
  });

  describe('handleWalletRegistered', () => {
    it('queries contract for owners/threshold and upserts', async () => {
      // Mock callContract to return ABI-encoded data
      // getOwners() returns address[] with 2 addresses
      // threshold() returns uint256 = 2
      const ownersData =
        '0x' +
        '0000000000000000000000000000000000000000000000000000000000000020' + // offset
        '0000000000000000000000000000000000000000000000000000000000000002' + // length = 2
        '000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' + // addr1
        '000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; // addr2

      const thresholdData = '0x0000000000000000000000000000000000000000000000000000000000000002';

      vi.mocked(quai.callContract)
        .mockResolvedValueOnce(ownersData)
        .mockResolvedValueOnce(thresholdData);

      const event = makeEvent({
        name: 'WalletRegistered',
        args: {
          wallet: '0xWALLET',
          registrar: '0xRegistrar',
        },
      });

      await handleWalletRegistered(event);

      expect(supabase.upsertWallet).toHaveBeenCalledWith({
        address: '0xWALLET',
        threshold: 2,
        ownerCount: 2,
        createdAtBlock: 100,
        createdAtTx: '0xtx123',
      });

      expect(supabase.addOwnersBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            walletAddress: '0xWALLET',
            ownerAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          }),
          expect.objectContaining({
            walletAddress: '0xWALLET',
            ownerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          }),
        ])
      );
    });
  });
});
