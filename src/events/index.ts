/**
 * Event Dispatcher for QuaiVault Indexer
 *
 * Routes decoded events to domain-specific handlers.
 * All errors are caught and logged — never re-thrown — so
 * one malformed event cannot crash the indexer.
 */

import type { DecodedEvent } from '../types/index.js';
import { logger } from '../utils/logger.js';

// Domain handlers
import { handleWalletCreated, handleWalletRegistered } from './factory.js';
import {
  handleTransactionProposed,
  handleTransactionApproved,
  handleApprovalRevoked,
  handleTransactionExecuted,
  handleTransactionCancelled,
  handleOwnerAdded,
  handleOwnerRemoved,
  handleThresholdChanged,
  handleModuleEnabled,
  handleModuleDisabled,
  handleReceived,
} from './vault-core.js';
import {
  handleRecoverySetup,
  handleRecoveryInitiated,
  handleRecoveryApproved,
  handleRecoveryApprovalRevoked,
  handleRecoveryExecuted,
  handleRecoveryCancelled,
} from './social-recovery.js';
import {
  handleDailyLimitSet,
  handleDailyLimitReset,
  handleDailyLimitTransactionExecuted,
} from './daily-limit.js';
import {
  handleAddressWhitelisted,
  handleAddressRemovedFromWhitelist,
  handleWhitelistTransactionExecuted,
} from './whitelist.js';
import {
  handleExecutionFromModuleSuccess,
  handleExecutionFromModuleFailure,
} from './zodiac.js';

export async function handleEvent(event: DecodedEvent): Promise<void> {
  try {
    switch (event.name) {
      // Factory events
      case 'WalletCreated':
        await handleWalletCreated(event);
        break;
      case 'WalletRegistered':
        await handleWalletRegistered(event);
        break;

      // Vault core events
      case 'TransactionProposed':
        await handleTransactionProposed(event);
        break;
      case 'TransactionApproved':
        await handleTransactionApproved(event);
        break;
      case 'ApprovalRevoked':
        await handleApprovalRevoked(event);
        break;
      case 'TransactionExecuted':
        await handleTransactionExecuted(event);
        break;
      case 'TransactionCancelled':
        await handleTransactionCancelled(event);
        break;
      case 'OwnerAdded':
        await handleOwnerAdded(event);
        break;
      case 'OwnerRemoved':
        await handleOwnerRemoved(event);
        break;
      case 'ThresholdChanged':
        await handleThresholdChanged(event);
        break;
      case 'ModuleEnabled':
        await handleModuleEnabled(event);
        break;
      case 'ModuleDisabled':
        await handleModuleDisabled(event);
        break;
      case 'Received':
        await handleReceived(event);
        break;

      // Zodiac IAvatar events
      case 'ExecutionFromModuleSuccess':
        await handleExecutionFromModuleSuccess(event);
        break;
      case 'ExecutionFromModuleFailure':
        await handleExecutionFromModuleFailure(event);
        break;

      // Social recovery events
      case 'RecoverySetup':
        await handleRecoverySetup(event);
        break;
      case 'RecoveryInitiated':
        await handleRecoveryInitiated(event);
        break;
      case 'RecoveryApproved':
        await handleRecoveryApproved(event);
        break;
      case 'RecoveryApprovalRevoked':
        await handleRecoveryApprovalRevoked(event);
        break;
      case 'RecoveryExecuted':
        await handleRecoveryExecuted(event);
        break;
      case 'RecoveryCancelled':
        await handleRecoveryCancelled(event);
        break;

      // Daily limit events
      case 'DailyLimitSet':
        await handleDailyLimitSet(event);
        break;
      case 'DailyLimitReset':
        await handleDailyLimitReset(event);
        break;
      case 'DailyLimitTransactionExecuted':
        await handleDailyLimitTransactionExecuted(event);
        break;

      // Whitelist events
      case 'AddressWhitelisted':
        await handleAddressWhitelisted(event);
        break;
      case 'AddressRemovedFromWhitelist':
        await handleAddressRemovedFromWhitelist(event);
        break;
      case 'WhitelistTransactionExecuted':
        await handleWhitelistTransactionExecuted(event);
        break;

      default:
        logger.debug({ event: event.name }, 'Unhandled event');
    }
  } catch (err) {
    logger.error(
      {
        err,
        event: {
          name: event.name,
          address: event.address,
          blockNumber: event.blockNumber,
          transactionHash: event.transactionHash,
        },
      },
      'Error handling event - skipping'
    );
  }
}
