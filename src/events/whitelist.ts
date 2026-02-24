/**
 * Whitelist module event handlers: AddressWhitelisted,
 * AddressRemovedFromWhitelist, WhitelistTransactionExecuted
 */

import type { DecodedEvent } from '../types/index.js';
import { supabase } from '../services/supabase.js';
import { logger } from '../utils/logger.js';
import { validateEventArgs } from './helpers.js';

export async function handleAddressWhitelisted(event: DecodedEvent): Promise<void> {
  const { wallet, addr, limit } = validateEventArgs<{
    wallet: string;
    addr: string;
    limit: string;
  }>(event.args, ['wallet', 'addr', 'limit'], 'AddressWhitelisted');

  await supabase.addWhitelistEntry({
    walletAddress: wallet,
    whitelistedAddress: addr,
    limit: limit,
    addedAtBlock: event.blockNumber,
    addedAtTx: event.transactionHash,
    isActive: true,
  });

  logger.info(
    { wallet, address: addr, limit },
    'Address added to whitelist'
  );
}

export async function handleAddressRemovedFromWhitelist(event: DecodedEvent): Promise<void> {
  const { wallet, addr } = validateEventArgs<{
    wallet: string;
    addr: string;
  }>(event.args, ['wallet', 'addr'], 'AddressRemovedFromWhitelist');

  await supabase.removeWhitelistEntry(
    wallet,
    addr,
    event.blockNumber,
    event.transactionHash
  );

  logger.info(
    { wallet, address: addr },
    'Address removed from whitelist'
  );
}

export async function handleWhitelistTransactionExecuted(event: DecodedEvent): Promise<void> {
  const { wallet, to, value } = validateEventArgs<{
    wallet: string;
    to: string;
    value: string;
  }>(event.args, ['wallet', 'to', 'value'], 'WhitelistTransactionExecuted');

  await supabase.addModuleTransaction({
    walletAddress: wallet,
    moduleType: 'whitelist',
    moduleAddress: event.address,
    toAddress: to,
    value: value,
    executedAtBlock: event.blockNumber,
    executedAtTx: event.transactionHash,
  });

  logger.info(
    { wallet, to, value, module: event.address },
    'Whitelist transaction executed'
  );
}
