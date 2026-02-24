import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DecodedEvent } from '../../src/types/index.js';

// Mock services before importing handlers
vi.mock('../../src/services/supabase.js', () => ({
  supabase: {
    upsertRecoveryConfig: vi.fn().mockResolvedValue(undefined),
    getRecoveryConfig: vi.fn().mockResolvedValue({
      recoveryPeriod: 3600,
      threshold: 2,
    }),
    upsertRecovery: vi.fn().mockResolvedValue(undefined),
    addRecoveryApproval: vi.fn().mockResolvedValue(undefined),
    revokeRecoveryApproval: vi.fn().mockResolvedValue(undefined),
    updateRecoveryStatus: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/quai.js', () => ({
  quai: {
    getBlockTimestamp: vi.fn().mockResolvedValue(1700000000),
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

import {
  handleRecoverySetup,
  handleRecoveryInitiated,
  handleRecoveryApproved,
  handleRecoveryExecuted,
} from '../../src/events/social-recovery.js';
import { supabase } from '../../src/services/supabase.js';
import { quai } from '../../src/services/quai.js';

function makeEvent(overrides: Partial<DecodedEvent> = {}): DecodedEvent {
  return {
    name: 'RecoverySetup',
    address: '0xModule',
    blockNumber: 300,
    transactionHash: '0xtx789',
    logIndex: 0,
    args: {},
    ...overrides,
  };
}

describe('social-recovery event handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleRecoverySetup', () => {
    it('upserts recovery config with parsed values', async () => {
      const event = makeEvent({
        args: {
          wallet: '0xWallet',
          guardians: ['0xGuardian1', '0xGuardian2'],
          threshold: '2',
          recoveryPeriod: '86400',
        },
      });

      await handleRecoverySetup(event);

      expect(supabase.upsertRecoveryConfig).toHaveBeenCalledWith({
        walletAddress: '0xWallet',
        guardians: ['0xGuardian1', '0xGuardian2'],
        threshold: 2,
        recoveryPeriod: 86400,
        setupAtBlock: 300,
        setupAtTx: '0xtx789',
      });
    });
  });

  describe('handleRecoveryInitiated', () => {
    it('fetches block timestamp and calculates execution time', async () => {
      const event = makeEvent({
        name: 'RecoveryInitiated',
        args: {
          wallet: '0xWallet',
          recoveryHash: '0xHash',
          newOwners: ['0xNewOwner1'],
          newThreshold: '1',
          initiator: '0xGuardian1',
        },
      });

      await handleRecoveryInitiated(event);

      expect(quai.getBlockTimestamp).toHaveBeenCalledWith(300);
      expect(supabase.upsertRecovery).toHaveBeenCalledWith(
        expect.objectContaining({
          walletAddress: '0xWallet',
          recoveryHash: '0xHash',
          executionTime: 1700000000 + 3600, // blockTimestamp + recoveryPeriod
          requiredThreshold: 2,
          status: 'pending',
        })
      );
    });

    it('falls back to current time when block timestamp unavailable', async () => {
      vi.mocked(quai.getBlockTimestamp).mockRejectedValueOnce(new Error('RPC error'));

      const event = makeEvent({
        name: 'RecoveryInitiated',
        args: {
          wallet: '0xWallet',
          recoveryHash: '0xHash',
          newOwners: ['0xNewOwner1'],
          newThreshold: '1',
          initiator: '0xGuardian1',
        },
      });

      await handleRecoveryInitiated(event);

      expect(supabase.upsertRecovery).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'pending',
          // executionTime will be Date.now()/1000 + 3600, just check it was called
        })
      );
    });

    it('falls back to default config when no recovery config found', async () => {
      vi.mocked(supabase.getRecoveryConfig).mockResolvedValueOnce(null);

      const event = makeEvent({
        name: 'RecoveryInitiated',
        args: {
          wallet: '0xWallet',
          recoveryHash: '0xHash',
          newOwners: ['0xNewOwner1'],
          newThreshold: '1',
          initiator: '0xGuardian1',
        },
      });

      await handleRecoveryInitiated(event);

      expect(supabase.upsertRecovery).toHaveBeenCalledWith(
        expect.objectContaining({
          executionTime: 1700000000, // blockTimestamp + 0 (no recovery period)
          requiredThreshold: 1, // fallback
        })
      );
    });
  });

  describe('handleRecoveryApproved', () => {
    it('adds recovery approval', async () => {
      const event = makeEvent({
        name: 'RecoveryApproved',
        args: {
          wallet: '0xWallet',
          recoveryHash: '0xHash',
          guardian: '0xGuardian1',
        },
      });

      await handleRecoveryApproved(event);

      expect(supabase.addRecoveryApproval).toHaveBeenCalledWith({
        walletAddress: '0xWallet',
        recoveryHash: '0xHash',
        guardianAddress: '0xGuardian1',
        approvedAtBlock: 300,
        approvedAtTx: '0xtx789',
        isActive: true,
      });
    });
  });

  describe('handleRecoveryExecuted', () => {
    it('updates recovery status to executed', async () => {
      const event = makeEvent({
        name: 'RecoveryExecuted',
        args: {
          wallet: '0xWallet',
          recoveryHash: '0xHash',
        },
      });

      await handleRecoveryExecuted(event);

      expect(supabase.updateRecoveryStatus).toHaveBeenCalledWith(
        '0xWallet',
        '0xHash',
        'executed',
        300,
        '0xtx789'
      );
    });
  });
});
