import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';
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
  DailyLimitState,
  WhitelistEntry,
  ModuleTransaction,
  ModuleExecution,
} from '../types/index.js';
import {
  validateAndNormalizeAddress,
  validateBytes32,
} from '../utils/validation.js';

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

  // ============================================
  // INDEXER STATE
  // ============================================

  async getIndexerState(): Promise<IndexerState> {
    const { data, error } = await this.client
      .from('indexer_state')
      .select('*')
      .eq('id', 'main')
      .single();

    if (error) throw error;

    return {
      lastIndexedBlock: data.last_indexed_block,
      lastIndexedAt: new Date(data.last_indexed_at),
      isSyncing: data.is_syncing,
    };
  }

  async updateIndexerState(blockNumber: number): Promise<void> {
    const { error } = await this.client
      .from('indexer_state')
      .update({
        last_indexed_block: blockNumber,
        last_indexed_at: new Date().toISOString(),
      })
      .eq('id', 'main');

    if (error) throw error;
  }

  async setIsSyncing(isSyncing: boolean): Promise<void> {
    const { error } = await this.client
      .from('indexer_state')
      .update({ is_syncing: isSyncing })
      .eq('id', 'main');

    if (error) throw error;
  }

  // ============================================
  // WALLETS
  // ============================================

  async upsertWallet(wallet: Wallet): Promise<void> {
    const address = validateAndNormalizeAddress(wallet.address, 'wallet.address');
    const createdAtTx = validateBytes32(wallet.createdAtTx, 'wallet.createdAtTx');

    const { error } = await this.client.from('wallets').upsert(
      {
        address,
        name: wallet.name,
        threshold: wallet.threshold,
        owner_count: wallet.ownerCount,
        created_at_block: wallet.createdAtBlock,
        created_at_tx: createdAtTx,
      },
      {
        onConflict: 'address',
      }
    );

    if (error) throw error;
  }

  async getWallet(address: string): Promise<Wallet | null> {
    const normalizedAddress = validateAndNormalizeAddress(address, 'address');

    const { data, error } = await this.client
      .from('wallets')
      .select('*')
      .eq('address', normalizedAddress)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    if (!data) return null;

    return {
      address: data.address,
      name: data.name,
      threshold: data.threshold,
      ownerCount: data.owner_count,
      createdAtBlock: data.created_at_block,
      createdAtTx: data.created_at_tx,
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
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) throw error;
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

  /**
   * Stream wallet addresses using an async generator.
   * More memory-efficient for very large datasets (10k+ wallets).
   * Yields addresses one page at a time without loading all into memory.
   */
  async *getAllWalletAddressesIterator(): AsyncGenerator<string> {
    const PAGE_SIZE = 1000;
    let offset = 0;

    while (true) {
      const { data, error } = await this.client
        .from('wallets')
        .select('address')
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) throw error;
      if (!data || data.length === 0) break;

      for (const wallet of data) {
        yield wallet.address;
      }

      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }

  async updateWalletThreshold(address: string, threshold: number): Promise<void> {
    const normalizedAddress = validateAndNormalizeAddress(address, 'address');

    const { error } = await this.client
      .from('wallets')
      .update({ threshold })
      .eq('address', normalizedAddress);

    if (error) throw error;
  }

  async updateWalletOwnerCount(address: string, delta: number): Promise<void> {
    const normalizedAddress = validateAndNormalizeAddress(address, 'address');

    const { error } = await this.client.rpc('increment_owner_count', {
      wallet_addr: normalizedAddress,
      delta_value: delta,
    });

    if (error) throw error;
  }

  // ============================================
  // OWNERS
  // ============================================

  async addOwner(owner: WalletOwner): Promise<void> {
    const walletAddress = validateAndNormalizeAddress(owner.walletAddress, 'owner.walletAddress');
    const ownerAddress = validateAndNormalizeAddress(owner.ownerAddress, 'owner.ownerAddress');
    const addedAtTx = validateBytes32(owner.addedAtTx, 'owner.addedAtTx');

    const { error } = await this.client.from('wallet_owners').insert({
      wallet_address: walletAddress,
      owner_address: ownerAddress,
      added_at_block: owner.addedAtBlock,
      added_at_tx: addedAtTx,
      is_active: true,
    });

    if (error && error.code !== '23505') throw error; // Ignore duplicate
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

    if (error) throw error;
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

    if (error) throw error;
  }

  // ============================================
  // MODULES
  // ============================================

  async addModule(module: WalletModule): Promise<void> {
    const walletAddress = validateAndNormalizeAddress(module.walletAddress, 'module.walletAddress');
    const moduleAddress = validateAndNormalizeAddress(module.moduleAddress, 'module.moduleAddress');
    const enabledAtTx = validateBytes32(module.enabledAtTx, 'module.enabledAtTx');

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

    if (error) throw error;
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

    if (error) throw error;
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

    const { error } = await this.client.from('transactions').upsert(
      {
        wallet_address: walletAddress,
        tx_hash: txHash,
        to_address: toAddress,
        value: tx.value,
        data: tx.data,
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
      },
      {
        onConflict: 'wallet_address,tx_hash',
      }
    );

    if (error) throw error;
  }

  async updateTransactionStatus(
    walletAddress: string,
    txHash: string,
    status: 'executed' | 'cancelled',
    blockNumber: number,
    chainTxHash: string,
    executedBy?: string
  ): Promise<void> {
    const normalizedWallet = validateAndNormalizeAddress(walletAddress, 'walletAddress');
    const normalizedTxHash = validateBytes32(txHash, 'txHash');
    const normalizedChainTx = validateBytes32(chainTxHash, 'chainTxHash');

    const updateData: Record<string, unknown> = { status };

    if (status === 'executed') {
      updateData.executed_at_block = blockNumber;
      updateData.executed_at_tx = normalizedChainTx;
      if (executedBy) {
        updateData.executed_by = validateAndNormalizeAddress(executedBy, 'executedBy');
      }
    } else {
      updateData.cancelled_at_block = blockNumber;
      updateData.cancelled_at_tx = normalizedChainTx;
    }

    const { error } = await this.client
      .from('transactions')
      .update(updateData)
      .eq('wallet_address', normalizedWallet)
      .eq('tx_hash', normalizedTxHash);

    if (error) throw error;
  }

  // ============================================
  // CONFIRMATIONS
  // ============================================

  async addConfirmation(confirmation: Confirmation): Promise<void> {
    const walletAddress = validateAndNormalizeAddress(confirmation.walletAddress, 'confirmation.walletAddress');
    const ownerAddress = validateAndNormalizeAddress(confirmation.ownerAddress, 'confirmation.ownerAddress');
    const txHash = validateBytes32(confirmation.txHash, 'confirmation.txHash');
    const confirmedAtTx = validateBytes32(confirmation.confirmedAtTx, 'confirmation.confirmedAtTx');

    const { error } = await this.client.from('confirmations').insert({
      wallet_address: walletAddress,
      tx_hash: txHash,
      owner_address: ownerAddress,
      confirmed_at_block: confirmation.confirmedAtBlock,
      confirmed_at_tx: confirmedAtTx,
      is_active: true,
    });

    if (error && error.code !== '23505') throw error; // Ignore duplicate
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

    if (error) throw error;
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

    // First, upsert the config
    const { error: configError } = await this.client
      .from('social_recovery_configs')
      .upsert(
        {
          wallet_address: walletAddress,
          threshold: recoveryConfig.threshold,
          recovery_period: recoveryConfig.recoveryPeriod,
          setup_at_block: recoveryConfig.setupAtBlock,
          setup_at_tx: setupAtTx,
        },
        { onConflict: 'wallet_address' }
      );

    if (configError) throw configError;

    // Mark all existing guardians as inactive
    await this.client
      .from('social_recovery_guardians')
      .update({ is_active: false })
      .eq('wallet_address', walletAddress);

    // Add new guardians in a single batch insert
    if (normalizedGuardians.length > 0) {
      const guardianRecords = normalizedGuardians.map((guardian) => ({
        wallet_address: walletAddress,
        guardian_address: guardian,
        added_at_block: recoveryConfig.setupAtBlock,
        added_at_tx: setupAtTx,
        is_active: true,
      }));

      const { error: guardianError } = await this.client
        .from('social_recovery_guardians')
        .insert(guardianRecords);

      if (guardianError && guardianError.code !== '23505') throw guardianError;
    }
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

    if (error) throw error;
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

    if (error && error.code !== '23505') throw error;
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

    if (error) throw error;
  }

  async updateRecoveryStatus(
    walletAddress: string,
    recoveryHash: string,
    status: 'executed' | 'cancelled',
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
    } else {
      updateData.cancelled_at_block = blockNumber;
      updateData.cancelled_at_tx = normalizedTxHash;
    }

    const { error } = await this.client
      .from('social_recoveries')
      .update(updateData)
      .eq('wallet_address', normalizedWallet)
      .eq('recovery_hash', normalizedRecoveryHash);

    if (error) throw error;
  }

  async getRecoveryConfig(
    walletAddress: string
  ): Promise<{ threshold: number; recoveryPeriod: number } | null> {
    const normalizedWallet = validateAndNormalizeAddress(walletAddress, 'walletAddress');

    const { data, error } = await this.client
      .from('social_recovery_configs')
      .select('threshold, recovery_period')
      .eq('wallet_address', normalizedWallet)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    if (!data) return null;

    return {
      threshold: data.threshold,
      recoveryPeriod: data.recovery_period,
    };
  }

  // ============================================
  // DAILY LIMIT MODULE
  // ============================================

  async upsertDailyLimit(state: DailyLimitState): Promise<void> {
    const walletAddress = validateAndNormalizeAddress(state.walletAddress, 'state.walletAddress');

    const { error } = await this.client.from('daily_limit_state').upsert(
      {
        wallet_address: walletAddress,
        daily_limit: state.dailyLimit,
        spent_today: state.spentToday,
        last_reset_day: state.lastResetDay,
      },
      { onConflict: 'wallet_address' }
    );

    if (error) throw error;
  }

  async resetDailyLimit(walletAddress: string): Promise<void> {
    const normalizedWallet = validateAndNormalizeAddress(walletAddress, 'walletAddress');

    const { error } = await this.client
      .from('daily_limit_state')
      .update({
        spent_today: '0',
        last_reset_day: new Date().toISOString().split('T')[0],
      })
      .eq('wallet_address', normalizedWallet);

    if (error) throw error;
  }

  async updateDailyLimitSpent(
    walletAddress: string,
    remainingLimit: string
  ): Promise<{ updated: boolean }> {
    const normalizedWallet = validateAndNormalizeAddress(walletAddress, 'walletAddress');

    // Get the current daily limit to calculate spent amount
    const { data, error: fetchError } = await this.client
      .from('daily_limit_state')
      .select('daily_limit')
      .eq('wallet_address', normalizedWallet)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') throw fetchError;
    if (!data) {
      // No daily limit configured for this wallet - this is expected for wallets
      // without the DailyLimit module enabled
      return { updated: false };
    }

    // Calculate spent: daily_limit - remaining_limit
    // Guard against underflow if remaining > dailyLimit (e.g., limit was increased mid-day)
    const dailyLimit = BigInt(data.daily_limit);
    const remaining = BigInt(remainingLimit);
    const spent = remaining > dailyLimit ? '0' : (dailyLimit - remaining).toString();

    const { error } = await this.client
      .from('daily_limit_state')
      .update({ spent_today: spent })
      .eq('wallet_address', normalizedWallet);

    if (error) throw error;
    return { updated: true };
  }

  // ============================================
  // WHITELIST MODULE
  // ============================================

  async addWhitelistEntry(entry: WhitelistEntry): Promise<void> {
    const walletAddress = validateAndNormalizeAddress(entry.walletAddress, 'entry.walletAddress');
    const whitelistedAddress = validateAndNormalizeAddress(entry.whitelistedAddress, 'entry.whitelistedAddress');
    const addedAtTx = validateBytes32(entry.addedAtTx, 'entry.addedAtTx');

    const { error } = await this.client.from('whitelist_entries').insert({
      wallet_address: walletAddress,
      whitelisted_address: whitelistedAddress,
      limit_amount: entry.limit,
      added_at_block: entry.addedAtBlock,
      added_at_tx: addedAtTx,
      is_active: true,
    });

    if (error && error.code !== '23505') throw error;
  }

  async removeWhitelistEntry(
    walletAddress: string,
    whitelistedAddress: string,
    removedAtBlock: number,
    removedAtTx: string
  ): Promise<void> {
    const normalizedWallet = validateAndNormalizeAddress(walletAddress, 'walletAddress');
    const normalizedWhitelisted = validateAndNormalizeAddress(whitelistedAddress, 'whitelistedAddress');
    const normalizedTx = validateBytes32(removedAtTx, 'removedAtTx');

    const { error } = await this.client
      .from('whitelist_entries')
      .update({
        is_active: false,
        removed_at_block: removedAtBlock,
        removed_at_tx: normalizedTx,
      })
      .eq('wallet_address', normalizedWallet)
      .eq('whitelisted_address', normalizedWhitelisted)
      .eq('is_active', true);

    if (error) throw error;
  }

  // ============================================
  // MODULE TRANSACTIONS
  // ============================================

  async addModuleTransaction(tx: ModuleTransaction): Promise<void> {
    const walletAddress = validateAndNormalizeAddress(tx.walletAddress, 'tx.walletAddress');
    const moduleAddress = validateAndNormalizeAddress(tx.moduleAddress, 'tx.moduleAddress');
    const toAddress = validateAndNormalizeAddress(tx.toAddress, 'tx.toAddress');
    const executedAtTx = validateBytes32(tx.executedAtTx, 'tx.executedAtTx');

    const { error } = await this.client.from('module_transactions').insert({
      wallet_address: walletAddress,
      module_type: tx.moduleType,
      module_address: moduleAddress,
      to_address: toAddress,
      value: tx.value,
      remaining_limit: tx.remainingLimit,
      executed_at_block: tx.executedAtBlock,
      executed_at_tx: executedAtTx,
    });

    if (error && error.code !== '23505') throw error; // Ignore duplicates
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

    const { error } = await this.client.from('module_executions').insert(record);

    if (error && error.code !== '23505') throw error; // Ignore duplicates
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

    if (error) throw error;
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

    const { error } = await this.client.from('deposits').insert({
      wallet_address: walletAddress,
      sender_address: senderAddress,
      amount: deposit.amount,
      deposited_at_block: deposit.depositedAtBlock,
      deposited_at_tx: depositedAtTx,
    });

    if (error && error.code !== '23505') throw error; // Ignore duplicates
  }
}

export const supabase = new SupabaseService();
