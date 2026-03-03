/**
 * Zodiac IAvatar event handlers: ExecutionFromModuleSuccess,
 * ExecutionFromModuleFailure
 */

import type { DecodedEvent } from '../types/index.js';
import { supabase } from '../services/supabase.js';
import { logger } from '../utils/logger.js';
import { validateEventArgs } from './helpers.js';

export async function handleExecutionFromModuleSuccess(event: DecodedEvent): Promise<void> {
  const { module } = validateEventArgs<{
    module: string;
  }>(event.args, ['module'], 'ExecutionFromModuleSuccess');

  await supabase.addModuleExecution({
    walletAddress: event.address,
    moduleAddress: module,
    success: true,
    executedAtBlock: event.blockNumber,
    executedAtTx: event.transactionHash,
    logIndex: event.logIndex,
  });

  logger.info(
    { wallet: event.address, module },
    'Module execution succeeded'
  );
}

export async function handleExecutionFromModuleFailure(event: DecodedEvent): Promise<void> {
  const { module } = validateEventArgs<{
    module: string;
  }>(event.args, ['module'], 'ExecutionFromModuleFailure');

  await supabase.addModuleExecution({
    walletAddress: event.address,
    moduleAddress: module,
    success: false,
    executedAtBlock: event.blockNumber,
    executedAtTx: event.transactionHash,
    logIndex: event.logIndex,
  });

  logger.info(
    { wallet: event.address, module },
    'Module execution failed'
  );
}
