/**
 * Event Dispatcher for QuaiVault Indexer
 *
 * Routes decoded events to domain-specific handlers.
 * All errors are caught and logged — never re-thrown — so
 * one malformed event cannot crash the indexer.
 */

import type { DecodedEvent } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { health } from '../services/health.js';

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
  handleEnabledModule,
  handleDisabledModule,
  handleReceived,
  handleThresholdReached,
  handleTransactionFailed,
  handleTransactionExpired,
  handleMinExecutionDelayChanged,
} from './vault-core.js';
import {
  handleRecoverySetup,
  handleRecoveryInitiated,
  handleRecoveryApproved,
  handleRecoveryApprovalRevoked,
  handleRecoveryExecuted,
  handleRecoveryCancelled,
  handleRecoveryInvalidated,
  handleRecoveryExpiredEvent,
} from './social-recovery.js';
import {
  handleExecutionFromModuleSuccess,
  handleExecutionFromModuleFailure,
} from './zodiac.js';
import {
  handleMessageSigned,
  handleMessageUnsigned,
} from './message-signing.js';

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
      case 'ThresholdReached':
        await handleThresholdReached(event);
        break;
      case 'TransactionFailed':
        await handleTransactionFailed(event);
        break;
      case 'TransactionExpired':
        await handleTransactionExpired(event);
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
      case 'EnabledModule':
        await handleEnabledModule(event);
        break;
      case 'DisabledModule':
        await handleDisabledModule(event);
        break;
      case 'Received':
        await handleReceived(event);
        break;
      case 'MinExecutionDelayChanged':
        await handleMinExecutionDelayChanged(event);
        break;

      // Message signing events (EIP-1271)
      case 'MessageSigned':
        await handleMessageSigned(event);
        break;
      case 'MessageUnsigned':
        await handleMessageUnsigned(event);
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
      case 'RecoveryInvalidated':
        await handleRecoveryInvalidated(event);
        break;
      case 'RecoveryExpiredEvent':
        await handleRecoveryExpiredEvent(event);
        break;

      // Token Transfer events are handled directly by the block processor
      // via handleTokenTransfer(). If one reaches here, log and skip.
      case 'Transfer':
        logger.debug({ address: event.address }, 'Transfer event reached dispatcher (handled by block processor)');
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
    health.incrementSkippedEvents();
  }
}
