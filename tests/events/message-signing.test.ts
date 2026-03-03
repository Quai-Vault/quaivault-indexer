import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DecodedEvent } from '../../src/types/index.js';

vi.mock('../../src/services/supabase.js', () => ({
  supabase: {
    upsertSignedMessage: vi.fn().mockResolvedValue(undefined),
    updateSignedMessage: vi.fn().mockResolvedValue(undefined),
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

import { handleMessageSigned } from '../../src/events/message-signing.js';
import { supabase } from '../../src/services/supabase.js';
import { logger } from '../../src/utils/logger.js';
import { MAX_HEX_DATA_LENGTH } from '../../src/utils/validation.js';

function makeEvent(overrides: Partial<DecodedEvent> = {}): DecodedEvent {
  return {
    name: 'MessageSigned',
    address: '0xWallet',
    blockNumber: 100,
    transactionHash: '0xtx123',
    logIndex: 0,
    args: {},
    ...overrides,
  };
}

describe('message-signing event handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores signed message with valid data', async () => {
    const event = makeEvent({
      args: { msgHash: '0xHash', data: '0xdeadbeef' },
    });

    await handleMessageSigned(event);

    expect(supabase.upsertSignedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        walletAddress: '0xWallet',
        msgHash: '0xHash',
        data: '0xdeadbeef',
      })
    );
  });

  it('skips event when data exceeds MAX_HEX_DATA_LENGTH', async () => {
    const oversizedData = '0x' + 'ab'.repeat(MAX_HEX_DATA_LENGTH);

    const event = makeEvent({
      args: { msgHash: '0xHash', data: oversizedData },
    });

    await handleMessageSigned(event);

    expect(supabase.upsertSignedMessage).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ wallet: '0xWallet' }),
      expect.stringContaining('max length')
    );
  });
});
