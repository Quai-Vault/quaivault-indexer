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
    applyModuleEvent: vi.fn().mockResolvedValue('applied'),
    addDeposit: vi.fn().mockResolvedValue(undefined),
    revokeConfirmation: vi.fn().mockResolvedValue(undefined),
    getTokenByAddress: vi.fn().mockResolvedValue(null),
    upsertToken: vi.fn().mockResolvedValue(undefined),
    addDelegatecallTarget: vi.fn().mockResolvedValue(undefined),
    removeDelegatecallTarget: vi.fn().mockResolvedValue(undefined),
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
  handleDelegatecallTargetAdded,
  handleDelegatecallTargetRemoved,
  handleEnabledModule,
  handleDisabledModule,
} from '../../src/events/vault-core.js';
import { supabase } from '../../src/services/supabase.js';

function makeEvent(overrides: Partial<DecodedEvent> = {}): DecodedEvent {
  return {
    name: 'TransactionProposed',
    address: '0xWallet',
    blockNumber: 200,
    transactionHash: '0xtx456',
    logIndex: 0,
    blockHash: '0xblock456',
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

  describe('handleDelegatecallTargetAdded', () => {
    it('adds delegatecall target', async () => {
      const event = makeEvent({
        name: 'DelegatecallTargetAdded',
        args: { target: '0xTargetAddress' },
      });

      await handleDelegatecallTargetAdded(event);

      expect(supabase.addDelegatecallTarget).toHaveBeenCalledWith(
        '0xWallet',
        '0xTargetAddress',
        200,
        '0xtx456'
      );
    });
  });

  describe('handleDelegatecallTargetRemoved', () => {
    it('removes delegatecall target', async () => {
      const event = makeEvent({
        name: 'DelegatecallTargetRemoved',
        args: { target: '0xTargetAddress' },
      });

      await handleDelegatecallTargetRemoved(event);

      expect(supabase.removeDelegatecallTarget).toHaveBeenCalledWith(
        '0xWallet',
        '0xTargetAddress',
        200,
        '0xtx456'
      );
    });
  });

  describe('module lifecycle handlers', () => {
    it('applies an enabled event with full ordering provenance', async () => {
      const event = makeEvent({
        name: 'EnabledModule',
        logIndex: 7,
        args: { module: '0xModule' },
      });

      await handleEnabledModule(event);

      expect(supabase.applyModuleEvent).toHaveBeenCalledWith({
        walletAddress: '0xWallet',
        moduleAddress: '0xModule',
        eventType: 'enabled',
        eventBlock: 200,
        eventBlockHash: '0xblock456',
        eventTx: '0xtx456',
        logIndex: 7,
      });
    });

    it('applies a disabled event with full ordering provenance', async () => {
      const event = makeEvent({
        name: 'DisabledModule',
        logIndex: 8,
        args: { module: '0xModule' },
      });

      await handleDisabledModule(event);

      expect(supabase.applyModuleEvent).toHaveBeenCalledWith({
        walletAddress: '0xWallet',
        moduleAddress: '0xModule',
        eventType: 'disabled',
        eventBlock: 200,
        eventBlockHash: '0xblock456',
        eventTx: '0xtx456',
        logIndex: 8,
      });
    });

    it('propagates lifecycle write failures so the block cannot be checkpointed', async () => {
      vi.mocked(supabase.applyModuleEvent).mockRejectedValueOnce(new Error('database unavailable'));
      const event = makeEvent({
        name: 'EnabledModule',
        args: { module: '0xModule' },
      });

      await expect(handleEnabledModule(event)).rejects.toThrow('database unavailable');
    });
  });
});
