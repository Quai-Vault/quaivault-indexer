/**
 * Daily limit module event handlers: DailyLimitSet, DailyLimitReset,
 * DailyLimitTransactionExecuted
 */

import type { DecodedEvent } from '../types/index.js';
import { supabase } from '../services/supabase.js';
import { logger } from '../utils/logger.js';
import { validateEventArgs } from './helpers.js';

export async function handleDailyLimitSet(event: DecodedEvent): Promise<void> {
  const { wallet, limit } = validateEventArgs<{
    wallet: string;
    limit: string;
  }>(event.args, ['wallet', 'limit'], 'DailyLimitSet');

  await supabase.upsertDailyLimit({
    walletAddress: wallet,
    dailyLimit: limit,
    spentToday: '0',
    lastResetDay: new Date().toISOString().split('T')[0],
  });

  logger.info({ wallet, limit }, 'Daily limit set');
}

export async function handleDailyLimitReset(event: DecodedEvent): Promise<void> {
  const { wallet } = validateEventArgs<{
    wallet: string;
  }>(event.args, ['wallet'], 'DailyLimitReset');

  await supabase.resetDailyLimit(wallet);

  logger.info({ wallet }, 'Daily limit reset');
}

export async function handleDailyLimitTransactionExecuted(event: DecodedEvent): Promise<void> {
  const { wallet, to, value, remainingLimit } = validateEventArgs<{
    wallet: string;
    to: string;
    value: string;
    remainingLimit: string;
  }>(event.args, ['wallet', 'to', 'value', 'remainingLimit'], 'DailyLimitTransactionExecuted');

  await supabase.addModuleTransaction({
    walletAddress: wallet,
    moduleType: 'daily_limit',
    moduleAddress: event.address,
    toAddress: to,
    value: value,
    remainingLimit: remainingLimit,
    executedAtBlock: event.blockNumber,
    executedAtTx: event.transactionHash,
  });

  await supabase.updateDailyLimitSpent(wallet, remainingLimit);

  logger.info(
    { wallet, to, value, remainingLimit, module: event.address },
    'Daily limit transaction executed'
  );
}
