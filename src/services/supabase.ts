import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import type {
  Wallet,
  WalletOwner,
  WalletModule,
  MultisigTransaction,
  Confirmation,
  IndexerState,
  SocialRecoveryConfig,
  SocialRecovery,
  SocialRecoveryApproval,
  ModuleExecution,
  TokenInfo,
  TokenTransfer,
  TokenStandard,
  SignedMessage,
} from '../types/index.js';
import {
  validateAndNormalizeAddress,
  validateBytes32,
  normalizeTokenParticipant,
  validateHexData,
} from '../utils/validation.js';
import { withRetry } from '../utils/retry.js';

/**
 * Supabase service for multi-network indexer support.
 *
 * Note: We use `any` for the client type because Supabase's TypeScript types
 * don't support dynamic schema names at runtime. The schema (testnet, mainnet,
 * or public) is configured via SUPABASE_SCHEMA environment variable.
 *
 * Type safety is maintained through:
 * 1. Input validation via validateAndNormalizeAddress/validateBytes32
 * 2. Consistent column naming conventions
 * 3. Runtime error handling from Supabase responses
 */
class SupabaseService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  private schema: string;

  constructor() {
    this.schema = config.supabase.schema;
    this.client = createClient(config.supabase.url, config.supabase.serviceKey, {
      auth: { persistSession: false },
      db: { schema: this.schema },
    });
  }

  /**
   * Wrap a Supabase error with operation context for debuggability.
   * Preserves the original error code for duplicate detection (23505).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private fail(operation: string, error: any): never {
    const wrapped = new Error(`${operation}: ${error.message || JSON.stringify(error)}`);
    (wrapped as any).code = error.code;
    throw wrapped;
  }

  // ============================================
  // INDEXER STATE
  // ============================================

  async getIndexerState(): Promise<IndexerState> {
    const { data, error } = await this.client
      .from('indexer_state')
      .select('*')
      .eq('id', 'main')
      .single();

    if (error) throw new Error(`Failed to get indexer state: ${error.message}`);

    return {
      lastIndexedBlock: data.last_indexed_block,
      lastBlockHash: data.last_block_hash ?? null,
      lastIndexedAt: new Date(data.last_indexed_at),
      isSyncing: data.is_syncing,
    };
  }

  /**
   * Delete events recorded after a given block number (reorg cleanup).
   * Best-effort: logs errors but does not throw, so indexer can continue.
   */
  async deleteEventsAfterBlock(blockNumber: number): Promise<void> {
    const tables = [
      { table: 'token_transfers', column: 'block_number' },
      { table: 'deposits', column: 'deposited_at_block' },
      { table: 'module_executions', column: 'executed_at_block' },
      { table: 'signed_messages', column: 'signed_at_block' },
      { table: 'social_recovery_approvals', column: 'approved_at_block' },
      { table: 'confirmations', column: 'confirmed_at_block' },
      { table: 'social_recovery_configs', column: 'setup_at_block' },
      { table: 'social_recovery_guardians', column: 'added_at_block' },
    ];
    for (const { table, column } of tables) {
      const { error } = await this.client.from(table).delete().gt(column, blockNumber);
      if (error) logger.error({ err: error, table, blockNumber }, 'Reorg cleanup failed for table');
    }
  }

  async updateIndexerState(blockNumber: number, blockHash?: string): Promise<void> {
    const update: Record<string, unknown> = {
      last_indexed_block: blockNumber,
      last_indexed_at: new Date().toISOString(),
    };
    if (blockHash !== undefined) {
      update.last_block_hash = blockHash;
    }

    const { error } = await this.client
      .from('indexer_state')
      .update(update)
      .eq('id', 'main');

    if (error) throw new Error(`Failed to update indexer state to block ${blockNumber}: ${error.message}`);
  }

  async setIsSyncing(isSyncing: boolean): Promise<void> {
    const { error } = await this.client
      .from('indexer_state')
      .update({ is_syncing: isSyncing })
      .eq('id', 'main');

    if (error) this.fail('setIsSyncing', error);
  }

  // ============================================
  // WALLETS
  // ============================================

  async upsertWallet(wallet: Wallet): Promise<void> {
    const address = validateAndNormalizeAddress(wallet.address, 'wallet.address');
    const createdAtTx = validateBytes32(wallet.createdAtTx, 'wallet.createdAtTx');

    await withRetry(async () => {
      const { error } = await this.client.from('wallets').upsert(
        {
          address,
          name: wallet.name,
          threshold: wallet.threshold,
          owner_count: wallet.ownerCount,
          created_at_block: wallet.createdAtBlock,
          created_at_tx: createdAtTx,
          min_execution_delay: wallet.minExecutionDelay ?? 0,
          delegatecall_disabled: wallet.delegatecallDisabled ?? true,
        },
        {
          onConflict: 'address',
        }
      );

      if (error) this.fail('upsertWallet', error);
    }, { maxAttempts: 3, delayMs: 1000, operation: 'upsertWallet' });
  }

  async getWallet(address: string): Promise<Wallet | null> {
    const normalizedAddress = validateAndNormalizeAddress(address, 'address');

    const { data, error } = await this.client
      .from('wallets')
      .select('*')
      .eq('address', normalizedAddress)
      .single();

    if (error && error.code !== 'PGRST116') this.fail('getWallet', error);
    if (!data) return null;

    return {
      address: data.address,
      name: data.name,
      threshold: data.threshold,
      ownerCount: data.owner_count,
      createdAtBlock: data.created_at_block,
      createdAtTx: data.created_at_tx,
      minExecutionDelay: data.min_execution_delay,
      delegatecallDisabled: data.delegatecall_disabled,
    };
  }

  async getAllWalletAddresses(): Promise<string[]> {
    const PAGE_SIZE = 1000;
    const addresses: string[] = [];
    let offset = 0;

    // Paginate to handle large numbers of wallets efficiently
    while (true) {
      const { data, error } = await this.client
        .from('wallets')
        .select('address')
        .order('address')
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) this.fail('getAllWalletAddresses', error);
      if (!data || data.length === 0) break;

      for (const w of data) {
        addresses.push(w.address);
      }

      // If we got less than PAGE_SIZE, we've reached the end
      if (data.length < PAGE_SIZE) break;

      offset += PAGE_SIZE;
    }

    return addresses;
  }

  async updateWalletThreshold(address: string, threshold: number): Promise<void> {
    const normalizedAddress = validateAndNormalizeAddress(address, 'address');

    await withRetry(async () => {
      const { error } = await this.client
        .from('wallets')
        .update({ threshold })
        .eq('address', normalizedAddress);

      if (error) this.fail('updateWalletThreshold', error);
    }, { maxAttempts: 3, delayMs: 1000, operation: 'updateWalletThreshold' });
  }

  // ============================================
  // OWNERS
  // ============================================

  async addOwner(owner: WalletOwner): Promise<void> {
    const walletAddress = validateAndNormalizeAddress(owner.walletAddress, 'owner.walletAddress');
    const ownerAddress = validateAndNormalizeAddress(owner.ownerAddress, 'owner.ownerAddress');
    const addedAtTx = validateBytes32(owner.addedAtTx, 'owner.addedAtTx');

    await withRetry(async () => {
      const { error } = await this.client.from('wallet_owners').insert({
        wallet_address: walletAddress,
        owner_address: ownerAddress,
        added_at_block: owner.addedAtBlock,
        added_at_tx: addedAtTx,
        is_active: true,
      });

      if (error && error.code !== '23505') this.fail('addOwner', error);
    }, { maxAttempts: 3, delayMs: 1000, operation: 'addOwner' });
  }

  async addOwnersBatch(owners: WalletOwner[]): Promise<void> {
    if (owners.length === 0) return;

    // Validate and normalize all inputs upfront
    const records = owners.map((owner, idx) => ({
      wallet_address: validateAndNormalizeAddress(owner.walletAddress, `owners[${idx}].walletAddress`),
      owner_address: validateAndNormalizeAddress(owner.ownerAddress, `owners[${idx}].ownerAddress`),
      added_at_block: owner.addedAtBlock,
      added_at_tx: validateBytes32(owner.addedAtTx, `owners[${idx}].addedAtTx`),
      is_active: true,
    }));

    const { error } = await this.client
      .from('wallet_owners')
      .upsert(records, {
        onConflict: 'wallet_address,owner_address,added_at_block',
        ignoreDuplicates: true,
      });

    if (error) this.fail('addOwnersBatch', error);
  }

  async removeOwner(
    walletAddress: string,
    ownerAddress: string,
    removedAtBlock: number,
    removedAtTx: string
  ): Promise<void> {
    const normalizedWallet = validateAndNormalizeAddress(walletAddress, 'walletAddress');
    const normalizedOwner = validateAndNormalizeAddress(ownerAddress, 'ownerAddress');
    const normalizedTx = validateBytes32(removedAtTx, 'removedAtTx');

    await withRetry(async () => {
      const { error } = await this.client
        .from('wallet_owners')
        .update({
          is_active: false,
          removed_at_block: removedAtBlock,
          removed_at_tx: normalizedTx,
        })
        .eq('wallet_address', normalizedWallet)
        .eq('owner_address', normalizedOwner)
        .eq('is_active', true);

      if (error) this.fail('removeOwner', error);
    }, { maxAttempts: 3, delayMs: 1000, operation: 'removeOwner' });
  }

  // ============================================
  // MODULES
  // ============================================

  async addModule(module: WalletModule): Promise<void> {
    const walletAddress = validateAndNormalizeAddress(module.walletAddress, 'module.walletAddress');
    const moduleAddress = validateAndNormalizeAddress(module.moduleAddress, 'module.moduleAddress');
    const enabledAtTx = validateBytes32(module.enabledAtTx, 'module.enabledAtTx');

    await withRetry(async () => {
      const { error } = await this.client.from('wallet_modules').upsert(
        {
          wallet_address: walletAddress,
          module_address: moduleAddress,
          enabled_at_block: module.enabledAtBlock,
          enabled_at_tx: enabledAtTx,
          is_active: true,
        },
        { onConflict: 'wallet_address,module_address' }
      );

      if (error) this.fail('addModule', error);
    }, { maxAttempts: 3, delayMs: 1000, operation: 'addModule' });
  }

  async disableModule(
    walletAddress: string,
    moduleAddress: string,
    disabledAtBlock: number,
    disabledAtTx: string
  ): Promise<void> {
    const normalizedWallet = validateAndNormalizeAddress(walletAddress, 'walletAddress');
    const normalizedModule = validateAndNormalizeAddress(moduleAddress, 'moduleAddress');
    const normalizedTx = validateBytes32(disabledAtTx, 'disabledAtTx');

    await withRetry(async () => {
      const { error } = await this.client
        .from('wallet_modules')
        .update({
          is_active: false,
          disabled_at_block: disabledAtBlock,
          disabled_at_tx: normalizedTx,
        })
        .eq('wallet_address', normalizedWallet)
        .eq('module_address', normalizedModule)
        .eq('is_active', true);

      if (error) this.fail('disableModule', error);
    }, { maxAttempts: 3, delayMs: 1000, operation: 'disableModule' });
  }

  // ============================================
  // TRANSACTIONS
  // ============================================

  async upsertTransaction(tx: MultisigTransaction): Promise<void> {
    const walletAddress = validateAndNormalizeAddress(tx.walletAddress, 'tx.walletAddress');
    const toAddress = validateAndNormalizeAddress(tx.to, 'tx.to');
    const submittedBy = validateAndNormalizeAddress(tx.submittedBy, 'tx.submittedBy');
    const txHash = validateBytes32(tx.txHash, 'tx.txHash');
    const submittedAtTx = validateBytes32(tx.submittedAtTx, 'tx.submittedAtTx');
    const validatedData = validateHexData(tx.data, 'tx.data');

    await withRetry(async () => {
      const { error } = await this.client.from('transactions').upsert(
        {
          wallet_address: walletAddress,
          tx_hash: txHash,
          to_address: toAddress,
          value: tx.value,
          data: validatedData,
          transaction_type: tx.transactionType,
          decoded_params: tx.decodedParams || null,
          status: tx.status,
          confirmation_count: tx.confirmationCount,
          submitted_by: submittedBy,
          submitted_at_block: tx.submittedAtBlock,
          submitted_at_tx: submittedAtTx,
          executed_at_block: tx.executedAtBlock,
          executed_at_tx: tx.executedAtTx ? validateBytes32(tx.executedAtTx, 'tx.executedAtTx') : null,
          cancelled_at_block: tx.cancelledAtBlock,
          cancelled_at_tx: tx.cancelledAtTx ? validateBytes32(tx.cancelledAtTx, 'tx.cancelledAtTx') : null,
          expiration: tx.expiration ?? 0,
          execution_delay: tx.executionDelay ?? 0,
        },
        {
          onConflict: 'wallet_address,tx_hash',
        }
      );

      if (error) this.fail('upsertTransaction', error);
    }, { maxAttempts: 3, delayMs: 1000, operation: 'upsertTransaction' });
  }

  async updateTransactionStatus(
    walletAddress: string,
    txHash: string,
    status: 'executed' | 'cancelled' | 'expired' | 'failed',
    fields: {
      executed_at_block?: number;
      executed_at_tx?: string;
      executed_by?: string;
      cancelled_at_block?: number;
      cancelled_at_tx?: string;
      is_expired?: boolean;
      failed_return_data?: string;
    }
  ): Promise<void> {
    const normalizedWallet = validateAndNormalizeAddress(walletAddress, 'walletAddress');
    const normalizedTxHash = validateBytes32(txHash, 'txHash');

    const updateData: Record<string, unknown> = { status };

    if (fields.executed_at_block !== undefined) updateData.executed_at_block = fields.executed_at_block;
    if (fields.executed_at_tx) updateData.executed_at_tx = validateBytes32(fields.executed_at_tx, 'executed_at_tx');
    if (fields.executed_by) updateData.executed_by = validateAndNormalizeAddress(fields.executed_by, 'executed_by');
    if (fields.cancelled_at_block !== undefined) updateData.cancelled_at_block = fields.cancelled_at_block;
    if (fields.cancelled_at_tx) updateData.cancelled_at_tx = validateBytes32(fields.cancelled_at_tx, 'cancelled_at_tx');
    if (fields.is_expired !== undefined) updateData.is_expired = fields.is_expired;
    if (fields.failed_return_data !== undefined) updateData.failed_return_data = validateHexData(fields.failed_return_data, 'failed_return_data');

    await withRetry(async () => {
      const { error } = await this.client
        .from('transactions')
        .update(updateData)
        .eq('wallet_address', normalizedWallet)
        .eq('tx_hash', normalizedTxHash);

      if (error) this.fail('updateTransactionStatus', error);
    }, { maxAttempts: 3, delayMs: 1000, operation: 'updateTransactionStatus' });
  }

  async updateTransactionApproval(
    walletAddress: string,
    txHash: string,
    fields: { approved_at: number; executable_after: number }
  ): Promise<void> {
    const normalizedWallet = validateAndNormalizeAddress(walletAddress, 'walletAddress');
    const normalizedTxHash = validateBytes32(txHash, 'txHash');

    await withRetry(async () => {
      const { error } = await this.client
        .from('transactions')
        .update({
          approved_at: fields.approved_at,
          executable_after: fields.executable_after,
        })
        .eq('wallet_address', normalizedWallet)
        .eq('tx_hash', normalizedTxHash);

      if (error) this.fail('updateTransactionApproval', error);
    }, { maxAttempts: 3, delayMs: 1000, operation: 'updateTransactionApproval' });
  }

  async updateWalletDelay(address: string, minExecutionDelay: number): Promise<void> {
    const normalizedAddress = validateAndNormalizeAddress(address, 'address');

    await withRetry(async () => {
      const { error } = await this.client
        .from('wallets')
        .update({ min_execution_delay: minExecutionDelay })
        .eq('address', normalizedAddress);

      if (error) this.fail('updateWalletDelay', error);
    }, { maxAttempts: 3, delayMs: 1000, operation: 'updateWalletDelay' });
  }

  async updateWalletDelegatecallDisabled(address: string, disabled: boolean): Promise<void> {
    const normalizedAddress = validateAndNormalizeAddress(address, 'address');

    await withRetry(async () => {
      const { error } = await this.client
        .from('wallets')
        .update({ delegatecall_disabled: disabled })
        .eq('address', normalizedAddress);

      if (error) this.fail('updateWalletDelegatecallDisabled', error);
    }, { maxAttempts: 3, delayMs: 1000, operation: 'updateWalletDelegatecallDisabled' });
  }

  // ============================================
  // CONFIRMATIONS
  // ============================================

  async addConfirmation(confirmation: Confirmation): Promise<void> {
    const walletAddress = validateAndNormalizeAddress(confirmation.walletAddress, 'confirmation.walletAddress');
    const ownerAddress = validateAndNormalizeAddress(confirmation.ownerAddress, 'confirmation.ownerAddress');
    const txHash = validateBytes32(confirmation.txHash, 'confirmation.txHash');
    const confirmedAtTx = validateBytes32(confirmation.confirmedAtTx, 'confirmation.confirmedAtTx');

    await withRetry(async () => {
      const { error } = await this.client.from('confirmations').insert({
        wallet_address: walletAddress,
        tx_hash: txHash,
        owner_address: ownerAddress,
        confirmed_at_block: confirmation.confirmedAtBlock,
        confirmed_at_tx: confirmedAtTx,
        is_active: true,
      });

      if (error && error.code !== '23505') this.fail('addConfirmation', error);
    }, { maxAttempts: 3, delayMs: 1000, operation: 'addConfirmation' });
  }

  async revokeConfirmation(
    walletAddress: string,
    txHash: string,
    ownerAddress: string,
    revokedAtBlock: number,
    revokedAtTx: string
  ): Promise<void> {
    const normalizedWallet = validateAndNormalizeAddress(walletAddress, 'walletAddress');
    const normalizedOwner = validateAndNormalizeAddress(ownerAddress, 'ownerAddress');
    const normalizedTxHash = validateBytes32(txHash, 'txHash');
    const normalizedRevokedTx = validateBytes32(revokedAtTx, 'revokedAtTx');

    await withRetry(async () => {
      const { error } = await this.client
        .from('confirmations')
        .update({
          is_active: false,
          revoked_at_block: revokedAtBlock,
          revoked_at_tx: normalizedRevokedTx,
        })
        .eq('wallet_address', normalizedWallet)
        .eq('tx_hash', normalizedTxHash)
        .eq('owner_address', normalizedOwner)
        .eq('is_active', true);

      if (error) this.fail('revokeConfirmation', error);
    }, { maxAttempts: 3, delayMs: 1000, operation: 'revokeConfirmation' });
  }

  // ============================================
  // SOCIAL RECOVERY MODULE
  // ============================================

  async upsertRecoveryConfig(recoveryConfig: SocialRecoveryConfig): Promise<void> {
    const walletAddress = validateAndNormalizeAddress(recoveryConfig.walletAddress, 'config.walletAddress');
    const setupAtTx = validateBytes32(recoveryConfig.setupAtTx, 'config.setupAtTx');

    // Validate all guardian addresses upfront
    const normalizedGuardians = recoveryConfig.guardians.map((guardian, idx) =>
      validateAndNormalizeAddress(guardian, `config.guardians[${idx}]`)
    );

    await withRetry(async () => {
      const { error } = await this.client.rpc('upsert_recovery_config_atomic', {
        p_wallet: walletAddress,
        p_threshold: recoveryConfig.threshold,
        p_recovery_period: recoveryConfig.recoveryPeriod,
        p_setup_at_block: recoveryConfig.setupAtBlock,
        p_setup_at_tx: setupAtTx,
        p_guardians: normalizedGuardians,
      });

      if (error) this.fail('upsertRecoveryConfig', error);
    }, { maxAttempts: 3, delayMs: 1000, operation: 'upsertRecoveryConfig' });
  }

  async upsertRecovery(recovery: SocialRecovery): Promise<void> {
    const walletAddress = validateAndNormalizeAddress(recovery.walletAddress, 'recovery.walletAddress');
    const initiatorAddress = validateAndNormalizeAddress(recovery.initiatorAddress, 'recovery.initiatorAddress');
    const recoveryHash = validateBytes32(recovery.recoveryHash, 'recovery.recoveryHash');
    const initiatedAtTx = validateBytes32(recovery.initiatedAtTx, 'recovery.initiatedAtTx');

    // Validate all new owner addresses
    const normalizedNewOwners = recovery.newOwners.map((owner, idx) =>
      validateAndNormalizeAddress(owner, `recovery.newOwners[${idx}]`)
    );

    const { error } = await this.client.from('social_recoveries').upsert(
      {
        wallet_address: walletAddress,
        recovery_hash: recoveryHash,
        new_owners: normalizedNewOwners,
        new_threshold: recovery.newThreshold,
        initiator_address: initiatorAddress,
        approval_count: recovery.approvalCount,
        required_threshold: recovery.requiredThreshold,
        execution_time: recovery.executionTime,
        expiration: recovery.expiration ?? null,
        status: recovery.status,
        initiated_at_block: recovery.initiatedAtBlock,
        initiated_at_tx: initiatedAtTx,
        executed_at_block: recovery.executedAtBlock,
        executed_at_tx: recovery.executedAtTx ? validateBytes32(recovery.executedAtTx, 'recovery.executedAtTx') : null,
        cancelled_at_block: recovery.cancelledAtBlock,
        cancelled_at_tx: recovery.cancelledAtTx ? validateBytes32(recovery.cancelledAtTx, 'recovery.cancelledAtTx') : null,
      },
      { onConflict: 'wallet_address,recovery_hash' }
    );

    if (error) this.fail('upsertRecovery', error);
  }

  async addRecoveryApproval(approval: SocialRecoveryApproval): Promise<void> {
    const walletAddress = validateAndNormalizeAddress(approval.walletAddress, 'approval.walletAddress');
    const guardianAddress = validateAndNormalizeAddress(approval.guardianAddress, 'approval.guardianAddress');
    const recoveryHash = validateBytes32(approval.recoveryHash, 'approval.recoveryHash');
    const approvedAtTx = validateBytes32(approval.approvedAtTx, 'approval.approvedAtTx');

    // The trigger_update_recovery_approval_count automatically updates
    // the approval_count on social_recoveries when an approval is inserted.
    const { error } = await this.client
      .from('social_recovery_approvals')
      .insert({
        wallet_address: walletAddress,
        recovery_hash: recoveryHash,
        guardian_address: guardianAddress,
        approved_at_block: approval.approvedAtBlock,
        approved_at_tx: approvedAtTx,
        is_active: true,
      });

    if (error && error.code !== '23505') this.fail('addRecoveryApproval', error);
  }

  async revokeRecoveryApproval(
    walletAddress: string,
    recoveryHash: string,
    guardianAddress: string,
    revokedAtBlock: number,
    revokedAtTx: string
  ): Promise<void> {
    const normalizedWallet = validateAndNormalizeAddress(walletAddress, 'walletAddress');
    const normalizedGuardian = validateAndNormalizeAddress(guardianAddress, 'guardianAddress');
    const normalizedRecoveryHash = validateBytes32(recoveryHash, 'recoveryHash');
    const normalizedRevokedTx = validateBytes32(revokedAtTx, 'revokedAtTx');

    // The trigger_update_recovery_approval_count automatically updates
    // the approval_count on social_recoveries when an approval is updated.
    const { error } = await this.client
      .from('social_recovery_approvals')
      .update({
        is_active: false,
        revoked_at_block: revokedAtBlock,
        revoked_at_tx: normalizedRevokedTx,
      })
      .eq('wallet_address', normalizedWallet)
      .eq('recovery_hash', normalizedRecoveryHash)
      .eq('guardian_address', normalizedGuardian)
      .eq('is_active', true);

    if (error) this.fail('revokeRecoveryApproval', error);
  }

  async updateRecoveryStatus(
    walletAddress: string,
    recoveryHash: string,
    status: 'executed' | 'cancelled' | 'invalidated' | 'expired',
    blockNumber: number,
    txHash: string
  ): Promise<void> {
    const normalizedWallet = validateAndNormalizeAddress(walletAddress, 'walletAddress');
    const normalizedRecoveryHash = validateBytes32(recoveryHash, 'recoveryHash');
    const normalizedTxHash = validateBytes32(txHash, 'txHash');

    const updateData: Record<string, unknown> = { status };

    if (status === 'executed') {
      updateData.executed_at_block = blockNumber;
      updateData.executed_at_tx = normalizedTxHash;
    } else if (status === 'invalidated') {
      updateData.invalidated_at_block = blockNumber;
      updateData.invalidated_at_tx = normalizedTxHash;
    } else if (status === 'expired') {
      updateData.expired_at_block = blockNumber;
      updateData.expired_at_tx = normalizedTxHash;
    } else {
      updateData.cancelled_at_block = blockNumber;
      updateData.cancelled_at_tx = normalizedTxHash;
    }

    const { error } = await this.client
      .from('social_recoveries')
      .update(updateData)
      .eq('wallet_address', normalizedWallet)
      .eq('recovery_hash', normalizedRecoveryHash)
      .eq('status', 'pending');

    if (error) this.fail('updateRecoveryStatus', error);
  }

  async getRecoveryConfig(
    walletAddress: string
  ): Promise<{ threshold: number; recoveryPeriod: number } | null> {
    const normalizedWallet = validateAndNormalizeAddress(walletAddress, 'walletAddress');

    const { data, error } = await this.client
      .from('social_recovery_configs')
      .select('threshold, recovery_period')
      .eq('wallet_address', normalizedWallet)
      .eq('is_active', true)
      .single();

    if (error && error.code !== 'PGRST116') this.fail('getRecoveryConfig', error);
    if (!data) return null;

    return {
      threshold: data.threshold,
      recoveryPeriod: data.recovery_period,
    };
  }

  async deactivateRecoveryConfig(walletAddress: string, atBlock: number, atTx: string): Promise<void> {
    const normalizedWallet = validateAndNormalizeAddress(walletAddress, 'walletAddress');
    const normalizedTx = validateBytes32(atTx, 'atTx');

    await withRetry(async () => {
      const { error } = await this.client.rpc('deactivate_recovery_config_atomic', {
        p_wallet: normalizedWallet,
        p_at_block: atBlock,
        p_at_tx: normalizedTx,
      });
      if (error) this.fail('deactivateRecoveryConfig', error);
    }, { maxAttempts: 3, delayMs: 1000, operation: 'deactivateRecoveryConfig' });
  }

  // ============================================
  // MODULE EXECUTIONS (Zodiac IAvatar)
  // ============================================

  async addModuleExecution(execution: ModuleExecution): Promise<void> {
    const walletAddress = validateAndNormalizeAddress(execution.walletAddress, 'execution.walletAddress');
    const moduleAddress = validateAndNormalizeAddress(execution.moduleAddress, 'execution.moduleAddress');
    const executedAtTx = validateBytes32(execution.executedAtTx, 'execution.executedAtTx');

    const record: Record<string, unknown> = {
      wallet_address: walletAddress,
      module_address: moduleAddress,
      success: execution.success,
      executed_at_block: execution.executedAtBlock,
      executed_at_tx: executedAtTx,
    };

    // Add optional fields if present
    if (execution.logIndex !== undefined) {
      record.log_index = execution.logIndex;
    }
    if (execution.operationType !== undefined) {
      record.operation_type = execution.operationType;
    }
    if (execution.toAddress) {
      record.to_address = validateAndNormalizeAddress(execution.toAddress, 'execution.toAddress');
    }
    if (execution.value) {
      record.value = execution.value;
    }
    if (execution.dataHash) {
      record.data_hash = execution.dataHash;
    }

    await withRetry(async () => {
      const { error } = await this.client.from('module_executions').insert(record);

      if (error && error.code !== '23505') this.fail('addModuleExecution', error);
    }, { maxAttempts: 3, delayMs: 1000, operation: 'addModuleExecution' });
  }

  async getModuleExecutions(
    walletAddress: string,
    options?: { moduleAddress?: string; successOnly?: boolean; limit?: number }
  ): Promise<ModuleExecution[]> {
    const normalizedWallet = validateAndNormalizeAddress(walletAddress, 'walletAddress');

    let query = this.client
      .from('module_executions')
      .select('*')
      .eq('wallet_address', normalizedWallet)
      .order('executed_at_block', { ascending: false });

    if (options?.moduleAddress) {
      const normalizedModule = validateAndNormalizeAddress(options.moduleAddress, 'moduleAddress');
      query = query.eq('module_address', normalizedModule);
    }

    if (options?.successOnly) {
      query = query.eq('success', true);
    }

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;

    if (error) this.fail('getModuleExecutions', error);
    if (!data) return [];

    return data.map((row: Record<string, unknown>) => ({
      walletAddress: row.wallet_address as string,
      moduleAddress: row.module_address as string,
      success: row.success as boolean,
      operationType: row.operation_type as number | undefined,
      toAddress: row.to_address as string | undefined,
      value: row.value as string | undefined,
      dataHash: row.data_hash as string | undefined,
      executedAtBlock: row.executed_at_block as number,
      executedAtTx: row.executed_at_tx as string,
    }));
  }

  // ============================================
  // DEPOSITS
  // ============================================

  async addDeposit(deposit: {
    walletAddress: string;
    senderAddress: string;
    amount: string;
    depositedAtBlock: number;
    depositedAtTx: string;
  }): Promise<void> {
    const walletAddress = validateAndNormalizeAddress(deposit.walletAddress, 'deposit.walletAddress');
    const senderAddress = validateAndNormalizeAddress(deposit.senderAddress, 'deposit.senderAddress');
    const depositedAtTx = validateBytes32(deposit.depositedAtTx, 'deposit.depositedAtTx');

    await withRetry(async () => {
      const { error } = await this.client.from('deposits').insert({
        wallet_address: walletAddress,
        sender_address: senderAddress,
        amount: deposit.amount,
        deposited_at_block: deposit.depositedAtBlock,
        deposited_at_tx: depositedAtTx,
      });

      if (error && error.code !== '23505') this.fail('addDeposit', error);
    }, { maxAttempts: 3, delayMs: 1000, operation: 'addDeposit' });
  }

  // ============================================
  // TOKEN TRACKING
  // ============================================

  async upsertToken(
    token: TokenInfo & { discoveredAtBlock?: number; discoveredVia?: string }
  ): Promise<void> {
    const address = validateAndNormalizeAddress(token.address, 'token.address');

    const { error } = await this.client.from('tokens').upsert(
      {
        address,
        standard: token.standard,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        discovered_at_block: token.discoveredAtBlock ?? null,
        discovered_via: token.discoveredVia ?? null,
      },
      { onConflict: 'address' }
    );

    if (error) this.fail('upsertToken', error);
  }

  async getAllTokens(): Promise<Array<{ address: string; standard: TokenStandard }>> {
    const PAGE_SIZE = 1000;
    const tokens: Array<{ address: string; standard: TokenStandard }> = [];
    let offset = 0;

    while (true) {
      const { data, error } = await this.client
        .from('tokens')
        .select('address, standard')
        .order('address')
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) this.fail('getAllTokens', error);
      if (!data || data.length === 0) break;

      for (const t of data) {
        tokens.push(t);
      }

      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    return tokens;
  }

  async getTokenByAddress(
    address: string
  ): Promise<{ address: string; standard: TokenStandard; symbol: string; decimals: number; name: string } | null> {
    const normalized = validateAndNormalizeAddress(address, 'tokenAddress');

    const { data, error } = await this.client
      .from('tokens')
      .select('address, standard, symbol, decimals, name')
      .eq('address', normalized)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null; // Not found
      this.fail('getTokenByAddress', error);
    }
    return data;
  }

  async addTokenTransfer(transfer: TokenTransfer): Promise<void> {
    const tokenAddress = validateAndNormalizeAddress(transfer.tokenAddress, 'transfer.tokenAddress');
    const walletAddress = validateAndNormalizeAddress(transfer.walletAddress, 'transfer.walletAddress');
    const fromAddress = normalizeTokenParticipant(transfer.fromAddress, 'transfer.fromAddress');
    const toAddress = normalizeTokenParticipant(transfer.toAddress, 'transfer.toAddress');
    const transactionHash = validateBytes32(transfer.transactionHash, 'transfer.transactionHash');

    await withRetry(async () => {
      const { error } = await this.client.from('token_transfers').insert({
        token_address: tokenAddress,
        wallet_address: walletAddress,
        from_address: fromAddress,
        to_address: toAddress,
        value: transfer.value,
        token_id: transfer.tokenId ?? null,
        batch_index: transfer.batchIndex ?? 0,
        direction: transfer.direction,
        block_number: transfer.blockNumber,
        transaction_hash: transactionHash,
        log_index: transfer.logIndex,
      });

      if (error && error.code !== '23505') this.fail('addTokenTransfer', error); // Ignore duplicates
    }, { maxAttempts: 3, delayMs: 1000, operation: 'addTokenTransfer' });
  }

  async addTokenTransfersBatch(transfers: TokenTransfer[]): Promise<void> {
    if (transfers.length === 0) return;

    const records = transfers.map((transfer, idx) => ({
      token_address: validateAndNormalizeAddress(transfer.tokenAddress, `transfers[${idx}].tokenAddress`),
      wallet_address: validateAndNormalizeAddress(transfer.walletAddress, `transfers[${idx}].walletAddress`),
      from_address: normalizeTokenParticipant(transfer.fromAddress, `transfers[${idx}].fromAddress`),
      to_address: normalizeTokenParticipant(transfer.toAddress, `transfers[${idx}].toAddress`),
      value: transfer.value,
      token_id: transfer.tokenId ?? null,
      batch_index: transfer.batchIndex ?? 0,
      direction: transfer.direction,
      block_number: transfer.blockNumber,
      transaction_hash: validateBytes32(transfer.transactionHash, `transfers[${idx}].transactionHash`),
      log_index: transfer.logIndex,
    }));

    await withRetry(async () => {
      const { error } = await this.client
        .from('token_transfers')
        .upsert(records, {
          onConflict: 'transaction_hash,log_index,batch_index,wallet_address',
          ignoreDuplicates: true,
        });

      if (error) this.fail('addTokenTransfersBatch', error);
    }, { maxAttempts: 3, delayMs: 1000, operation: 'addTokenTransfersBatch' });
  }

  // ============================================
  // MESSAGE SIGNING (EIP-1271)
  // ============================================

  async upsertSignedMessage(message: SignedMessage): Promise<void> {
    const walletAddress = validateAndNormalizeAddress(message.walletAddress, 'message.walletAddress');
    const signedAtTx = validateBytes32(message.signedAtTx, 'message.signedAtTx');
    const msgHash = validateBytes32(message.msgHash, 'message.msgHash');

    const { error } = await this.client.from('signed_messages').upsert(
      {
        wallet_address: walletAddress,
        msg_hash: msgHash,
        data: message.data ?? null,
        signed_at_block: message.signedAtBlock,
        signed_at_tx: signedAtTx,
        is_active: true,
      },
      { onConflict: 'wallet_address,msg_hash' }
    );

    if (error) this.fail('upsertSignedMessage', error);
  }

  async updateSignedMessage(
    walletAddress: string,
    msgHash: string,
    fields: { unsignedAtBlock: number; unsignedAtTx: string; isActive: boolean }
  ): Promise<void> {
    const normalizedWallet = validateAndNormalizeAddress(walletAddress, 'walletAddress');
    const normalizedHash = validateBytes32(msgHash, 'msgHash');
    const normalizedTx = validateBytes32(fields.unsignedAtTx, 'unsignedAtTx');

    await withRetry(async () => {
      const { error } = await this.client
        .from('signed_messages')
        .update({
          unsigned_at_block: fields.unsignedAtBlock,
          unsigned_at_tx: normalizedTx,
          is_active: fields.isActive,
        })
        .eq('wallet_address', normalizedWallet)
        .eq('msg_hash', normalizedHash);

      if (error) this.fail('updateSignedMessage', error);
    }, { maxAttempts: 3, delayMs: 1000, operation: 'updateSignedMessage' });
  }
}

export const supabase = new SupabaseService();
