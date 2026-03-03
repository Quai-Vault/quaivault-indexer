/**
 * Message signing event handlers: MessageSigned, MessageUnsigned (EIP-1271)
 */

import type { DecodedEvent } from '../types/index.js';
import { supabase } from '../services/supabase.js';
import { logger } from '../utils/logger.js';
import { validateEventArgs } from './helpers.js';
import { validateHexData } from '../utils/validation.js';

export async function handleMessageSigned(event: DecodedEvent): Promise<void> {
  const { msgHash, data } = validateEventArgs<{
    msgHash: string;
    data: string;
  }>(event.args, ['msgHash', 'data'], 'MessageSigned');

  let validatedData: string | null;
  try {
    validatedData = validateHexData(data, 'MessageSigned.data');
  } catch (err) {
    logger.error({ err, wallet: event.address, msgHash, dataLength: (data as string)?.length }, 'MessageSigned data exceeds max length, skipping');
    return;
  }

  await supabase.upsertSignedMessage({
    walletAddress: event.address,
    msgHash,
    data: validatedData ?? data,
    signedAtBlock: event.blockNumber,
    signedAtTx: event.transactionHash,
    isActive: true,
  });

  logger.info(
    { wallet: event.address, msgHash },
    'Message signed'
  );
}

export async function handleMessageUnsigned(event: DecodedEvent): Promise<void> {
  const { msgHash } = validateEventArgs<{
    msgHash: string;
  }>(event.args, ['msgHash'], 'MessageUnsigned');

  await supabase.updateSignedMessage(event.address, msgHash, {
    unsignedAtBlock: event.blockNumber,
    unsignedAtTx: event.transactionHash,
    isActive: false,
  });

  logger.info(
    { wallet: event.address, msgHash },
    'Message unsigned'
  );
}
