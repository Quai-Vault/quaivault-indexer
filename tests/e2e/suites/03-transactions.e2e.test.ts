/**
 * E2E Tests for QuaiVault Transaction Events
 *
 * Events covered:
 * 3. TransactionProposed
 * 4. TransactionApproved
 * 5. ApprovalRevoked
 * 6. TransactionExecuted
 * 7. TransactionCancelled
 *
 * NOTE: Requires 01-factory and 02-deposits tests to run first.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as quais from 'quais';
import { e2eConfig, contracts, indexer, supabase } from '../setup.js';
import { DatabaseVerifier } from '../helpers/db.js';
import { getTestWallet } from '../shared-state.js';

describe('QuaiVault Transaction Events', () => {
  let db: DatabaseVerifier;
  let walletAddress: string;
  let txHash: string;

  beforeAll(async () => {
    db = new DatabaseVerifier(supabase, e2eConfig.supabaseSchema);

    // Get the shared test wallet
    walletAddress = getTestWallet();
    console.log(`  Using shared test wallet: ${walletAddress}`);
  });

  it('should index TransactionProposed event', async () => {
    // Use another owner's address as recipient (a valid address we control)
    const recipient = contracts.getWalletAddress(2);
    const value = quais.parseQuai('0.0001'); // Small amount for testing

    // Propose a transaction (note: proposing does NOT auto-approve in QuaiVault)
    console.log('  Proposing transaction...');
    txHash = await contracts.proposeTransaction(walletAddress, recipient, value, '0x');
    console.log(`  Transaction proposed with hash: ${txHash}`);

    // Wait for indexer to process
    console.log('  Waiting for indexer to process TransactionProposed event...');
    await indexer.waitUntil(
      () => db.getTransaction(walletAddress, txHash),
      'TransactionProposed event indexed',
      e2eConfig.txConfirmationTimeout
    );

    // Verify database record - note: confirmation_count starts at 0
    // QuaiVault requires explicit approval even from the proposer
    console.log('  Verifying transaction record...');
    await db.verifyTransactionProposed(walletAddress, txHash, {
      status: 'pending',
      confirmation_count: 0, // Proposer must explicitly approve
    });

    const tx = await db.getTransaction(walletAddress, txHash);
    expect(tx!.to_address.toLowerCase()).toBe(recipient.toLowerCase());

    console.log('  ✓ TransactionProposed event indexed correctly');
  });

  it('should index TransactionApproved event', async () => {
    // First owner (proposer) approves the transaction
    console.log('  First owner (proposer) approving transaction...');
    await contracts.approveTransaction(walletAddress, txHash, 0);

    // Wait for indexer to process first approval
    console.log('  Waiting for indexer to process first TransactionApproved event...');
    await indexer.waitUntil(
      async () => {
        const confirmations = await db.getConfirmations(txHash);
        const activeCount = confirmations.filter((c) => c.is_active).length;
        return activeCount >= 1 ? confirmations : null;
      },
      'First TransactionApproved event indexed',
      e2eConfig.txConfirmationTimeout
    );

    // Verify first confirmation
    await db.verifyConfirmationCount(txHash, 1);
    console.log('  ✓ First approval indexed');

    // Second owner approves the transaction
    console.log('  Second owner approving transaction...');
    await contracts.approveTransaction(walletAddress, txHash, 1);

    // Wait for indexer to process second approval
    console.log('  Waiting for indexer to process second TransactionApproved event...');
    await indexer.waitUntil(
      async () => {
        const confirmations = await db.getConfirmations(txHash);
        const activeCount = confirmations.filter((c) => c.is_active).length;
        return activeCount >= 2 ? confirmations : null;
      },
      'Second TransactionApproved event indexed',
      e2eConfig.txConfirmationTimeout
    );

    // Verify confirmation count (threshold of 2 met)
    await db.verifyConfirmationCount(txHash, 2);

    console.log('  ✓ TransactionApproved events indexed correctly');
  });

  it('should index ApprovalRevoked event', async () => {
    // Second owner revokes their approval
    console.log('  Second owner revoking approval...');
    await contracts.revokeApproval(walletAddress, txHash, 1);

    // Wait for indexer to process
    console.log('  Waiting for indexer to process ApprovalRevoked event...');
    await indexer.waitUntil(
      async () => {
        const confirmations = await db.getConfirmations(txHash);
        const activeCount = confirmations.filter((c) => c.is_active).length;
        return activeCount === 1 ? confirmations : null;
      },
      'ApprovalRevoked event indexed',
      e2eConfig.txConfirmationTimeout
    );

    // Verify confirmation count decreased
    const confirmations = await db.getConfirmations(txHash);
    const activeCount = confirmations.filter((c) => c.is_active).length;
    expect(activeCount).toBe(1);

    console.log('  ✓ ApprovalRevoked event indexed correctly');
  });

  it('should index TransactionExecuted event', async () => {
    // Re-approve to meet threshold
    console.log('  Re-approving transaction...');
    await contracts.approveTransaction(walletAddress, txHash, 1);

    // Wait for approval to be indexed
    await indexer.waitUntil(
      async () => {
        const confirmations = await db.getConfirmations(txHash);
        const activeCount = confirmations.filter((c) => c.is_active).length;
        return activeCount >= 2 ? confirmations : null;
      },
      'Re-approval indexed',
      e2eConfig.txConfirmationTimeout
    );

    // Execute the transaction
    console.log('  Executing transaction...');
    await contracts.executeTransaction(walletAddress, txHash);

    // Wait for indexer to process
    console.log('  Waiting for indexer to process TransactionExecuted event...');
    await indexer.waitUntil(
      async () => {
        const tx = await db.getTransaction(walletAddress, txHash);
        return tx?.status === 'executed' ? tx : null;
      },
      'TransactionExecuted event indexed',
      e2eConfig.txConfirmationTimeout
    );

    // Verify transaction status
    await db.verifyTransactionStatus(walletAddress, txHash, 'executed');

    console.log('  ✓ TransactionExecuted event indexed correctly');
  });

  it('should index TransactionCancelled event', async () => {
    // Create a new transaction to cancel
    const recipient = contracts.getWalletAddress(2);
    console.log('  Proposing new transaction to cancel...');
    const newTxHash = await contracts.proposeTransaction(walletAddress, recipient, 0n, '0x');

    // Wait for proposal to be indexed
    await indexer.waitUntil(
      () => db.getTransaction(walletAddress, newTxHash),
      'New transaction proposed',
      e2eConfig.txConfirmationTimeout
    );

    // Cancel the transaction (only proposer can cancel)
    console.log('  Cancelling transaction...');
    await contracts.cancelTransaction(walletAddress, newTxHash, 0);

    // Wait for indexer to process
    console.log('  Waiting for indexer to process TransactionCancelled event...');
    await indexer.waitUntil(
      async () => {
        const tx = await db.getTransaction(walletAddress, newTxHash);
        return tx?.status === 'cancelled' ? tx : null;
      },
      'TransactionCancelled event indexed',
      e2eConfig.txConfirmationTimeout
    );

    // Verify transaction status
    await db.verifyTransactionStatus(walletAddress, newTxHash, 'cancelled');

    console.log('  ✓ TransactionCancelled event indexed correctly');
  });
});
