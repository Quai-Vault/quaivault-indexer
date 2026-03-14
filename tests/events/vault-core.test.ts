import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DecodedEvent } from '../../src/types/index.js';

// Mock services before importing handlers
vi.mock('../../src/services/supabase.js', () => ({
  supabase: {
    upsertTransaction: vi.fn().mockResolvedValue(undefined),
    addConfirmation: vi.fn().mockResolvedValue(undefined),
    updateTransactionStatus: vi.fn().mockResolvedValue(undefined),
    addOwner: vi.fn().mockResolvedValue(undefined),
    removeOwner: vi.fn().mockResolvedValue(undefined),
    updateWalletThreshold: vi.fn().mockResolvedValue(undefined),
    addModule: vi.fn().mockResolvedValue(undefined),
    disableModule: vi.fn().mockResolvedValue(undefined),
    addDeposit: vi.fn().mockResolvedValue(undefined),
    revokeConfirmation: vi.fn().mockResolvedValue(undefined),
    getTokenByAddress: vi.fn().mockResolvedValue(null),
    upsertToken: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/decoder.js', () => ({
  decodeCalldata: vi.fn().mockReturnValue({
    transactionType: 'transfer',
    decodedParams: undefined,
  }),
  getTransactionDescription: vi.fn().mockReturnValue('Transfer'),
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  handleTransactionProposed,
  handleTransactionApproved,
  handleTransactionExecuted,
} from '../../src/events/vault-core.js';
import { supabase } from '../../src/services/supabase.js';

function makeEvent(overrides: Partial<DecodedEvent> = {}): DecodedEvent {
  return {
    name: 'TransactionProposed',
    address: '0xWallet',
    blockNumber: 200,
    transactionHash: '0xtx456',
    logIndex: 0,
    args: {},
    ...overrides,
  };
}

describe('vault-core event handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleTransactionProposed', () => {
    it('decodes calldata and upserts transaction', async () => {
      const event = makeEvent({
        args: {
          txHash: '0xTXHASH',
          proposer: '0xProposer',
          to: '0xTarget',
          value: '1000',
          data: '0x',
          expiration: '1700000000',
          executionDelay: '300',
        },
      });

      await handleTransactionProposed(event);

      expect(supabase.upsertTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          walletAddress: '0xWallet',
          txHash: '0xTXHASH',
          to: '0xTarget',
          value: '1000',
          status: 'pending',
          submittedBy: '0xProposer',
          submittedAtBlock: 200,
          expiration: 1700000000,
          executionDelay: 300,
        })
      );
    });
  });

  describe('handleTransactionApproved', () => {
    it('calls addConfirmation with correct args', async () => {
      const event = makeEvent({
        name: 'TransactionApproved',
        args: {
          txHash: '0xTXHASH',
          approver: '0xApprover',
        },
      });

      await handleTransactionApproved(event);

      expect(supabase.addConfirmation).toHaveBeenCalledWith({
        walletAddress: '0xWallet',
        txHash: '0xTXHASH',
        ownerAddress: '0xApprover',
        confirmedAtBlock: 200,
        confirmedAtTx: '0xtx456',
        isActive: true,
      });
    });
  });

  describe('handleTransactionExecuted', () => {
    it('updates transaction status to executed', async () => {
      const event = makeEvent({
        name: 'TransactionExecuted',
        args: {
          txHash: '0xTXHASH',
          executor: '0xExecutor',
        },
      });

      await handleTransactionExecuted(event);

      expect(supabase.updateTransactionStatus).toHaveBeenCalledWith(
        '0xWallet',
        '0xTXHASH',
        'executed',
        {
          executed_at_block: 200,
          executed_at_tx: '0xtx456',
          executed_by: '0xExecutor',
        }
      );
    });
  });
});
