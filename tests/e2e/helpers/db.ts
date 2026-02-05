import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { expect } from 'vitest';
import type { E2EConfig } from '../config.js';

// Database record types
export interface WalletRecord {
  id: string;
  address: string;
  name?: string;
  threshold: number;
  owner_count: number;
  created_at_block: number;
  created_at_tx: string;
  created_at: string;
  updated_at: string;
}

export interface WalletOwnerRecord {
  id: string;
  wallet_address: string;
  owner_address: string;
  added_at_block: number;
  added_at_tx: string;
  removed_at_block?: number;
  removed_at_tx?: string;
  is_active: boolean;
  created_at: string;
}

export interface TransactionRecord {
  id: string;
  wallet_address: string;
  tx_hash: string;
  to_address: string;
  value: string;
  data?: string;
  transaction_type: string;
  decoded_params?: Record<string, unknown>;
  status: 'pending' | 'executed' | 'cancelled';
  confirmation_count: number;
  submitted_by: string;
  submitted_at_block: number;
  submitted_at_tx: string;
  executed_at_block?: number;
  executed_at_tx?: string;
  executed_by?: string;
  cancelled_at_block?: number;
  cancelled_at_tx?: string;
  created_at: string;
  updated_at: string;
}

export interface ConfirmationRecord {
  id: string;
  wallet_address: string;
  tx_hash: string;
  owner_address: string;
  confirmed_at_block: number;
  confirmed_at_tx: string;
  revoked_at_block?: number;
  revoked_at_tx?: string;
  is_active: boolean;
  created_at: string;
}

export interface DepositRecord {
  id: string;
  wallet_address: string;
  sender_address: string;
  amount: string;
  deposited_at_block: number;
  deposited_at_tx: string;
  created_at: string;
}

export interface WalletModuleRecord {
  id: string;
  wallet_address: string;
  module_address: string;
  enabled_at_block: number;
  enabled_at_tx: string;
  disabled_at_block?: number;
  disabled_at_tx?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ModuleExecutionRecord {
  id: string;
  wallet_address: string;
  module_address: string;
  success: boolean;
  operation_type?: number;
  to_address?: string;
  value?: string;
  data_hash?: string;
  executed_at_block: number;
  executed_at_tx: string;
  created_at: string;
}

export interface DailyLimitStateRecord {
  id: string;
  wallet_address: string;
  daily_limit: string;
  spent_today: string;
  last_reset_day: string;
  updated_at: string;
}

export interface WhitelistEntryRecord {
  id: string;
  wallet_address: string;
  whitelisted_address: string;
  limit_amount?: string;
  added_at_block: number;
  added_at_tx?: string;
  removed_at_block?: number;
  removed_at_tx?: string;
  is_active: boolean;
  created_at: string;
}

export interface ModuleTransactionRecord {
  id: string;
  wallet_address: string;
  module_type: string;
  module_address: string;
  to_address: string;
  value: string;
  remaining_limit?: string;
  executed_at_block: number;
  executed_at_tx: string;
  created_at: string;
}

export interface SocialRecoveryConfigRecord {
  id: string;
  wallet_address: string;
  threshold: number;
  recovery_period: number;
  setup_at_block: number;
  setup_at_tx: string;
  created_at: string;
  updated_at: string;
}

export interface SocialRecoveryGuardianRecord {
  id: string;
  wallet_address: string;
  guardian_address: string;
  added_at_block: number;
  added_at_tx: string;
  removed_at_block?: number;
  removed_at_tx?: string;
  is_active: boolean;
  created_at: string;
}

export interface SocialRecoveryRecord {
  id: string;
  wallet_address: string;
  recovery_hash: string;
  new_owners: string[];
  new_threshold: number;
  initiator_address: string;
  approval_count: number;
  required_threshold: number;
  execution_time: number;
  status: 'pending' | 'executed' | 'cancelled';
  initiated_at_block: number;
  initiated_at_tx: string;
  executed_at_block?: number;
  executed_at_tx?: string;
  cancelled_at_block?: number;
  cancelled_at_tx?: string;
  created_at: string;
  updated_at: string;
}

export interface SocialRecoveryApprovalRecord {
  id: string;
  wallet_address: string;
  recovery_hash: string;
  guardian_address: string;
  approved_at_block: number;
  approved_at_tx: string;
  revoked_at_block?: number;
  revoked_at_tx?: string;
  is_active: boolean;
  created_at: string;
}

/**
 * Create a Supabase client configured for the E2E test schema
 */
export function createSupabaseClient(config: E2EConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false },
    db: { schema: config.supabaseSchema },
  });
}

/**
 * Database verification helper for E2E tests
 */
export class DatabaseVerifier {
  constructor(
    private supabase: SupabaseClient,
    private schema: string
  ) {}

  // ============================================
  // WALLET VERIFICATION
  // ============================================

  async getWallet(address: string): Promise<WalletRecord | null> {
    const { data, error } = await this.supabase
      .from('wallets')
      .select('*')
      .eq('address', address.toLowerCase())
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async getWalletOwners(walletAddress: string): Promise<WalletOwnerRecord[]> {
    const { data, error } = await this.supabase
      .from('wallet_owners')
      .select('*')
      .eq('wallet_address', walletAddress.toLowerCase())
      .order('added_at_block', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  async verifyWalletCreated(
    address: string,
    expectedOwners: string[],
    expectedThreshold: number
  ): Promise<void> {
    const wallet = await this.getWallet(address);
    expect(wallet).not.toBeNull();
    expect(wallet!.threshold).toBe(expectedThreshold);
    expect(wallet!.owner_count).toBe(expectedOwners.length);

    const owners = await this.getWalletOwners(address);
    const activeOwners = owners.filter((o) => o.is_active);
    expect(activeOwners).toHaveLength(expectedOwners.length);

    const ownerAddresses = activeOwners.map((o) => o.owner_address.toLowerCase());
    for (const expected of expectedOwners) {
      expect(ownerAddresses).toContain(expected.toLowerCase());
    }
  }

  // ============================================
  // TRANSACTION VERIFICATION
  // ============================================

  async getTransaction(walletAddress: string, txHash: string): Promise<TransactionRecord | null> {
    const { data, error } = await this.supabase
      .from('transactions')
      .select('*')
      .eq('wallet_address', walletAddress.toLowerCase())
      .eq('tx_hash', txHash.toLowerCase())
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async getConfirmations(txHash: string): Promise<ConfirmationRecord[]> {
    const { data, error } = await this.supabase
      .from('confirmations')
      .select('*')
      .eq('tx_hash', txHash.toLowerCase())
      .order('confirmed_at_block', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  async verifyTransactionProposed(
    walletAddress: string,
    txHash: string,
    expectedData: Partial<TransactionRecord>
  ): Promise<void> {
    const tx = await this.getTransaction(walletAddress, txHash);
    expect(tx).not.toBeNull();

    for (const [key, value] of Object.entries(expectedData)) {
      if (key === 'to_address' && typeof value === 'string') {
        expect(tx![key as keyof TransactionRecord]).toBe(value.toLowerCase());
      } else {
        expect(tx![key as keyof TransactionRecord]).toBe(value);
      }
    }
  }

  async verifyTransactionStatus(
    walletAddress: string,
    txHash: string,
    expectedStatus: string
  ): Promise<void> {
    const tx = await this.getTransaction(walletAddress, txHash);
    expect(tx).not.toBeNull();
    expect(tx!.status).toBe(expectedStatus);
  }

  async verifyConfirmationCount(txHash: string, expectedCount: number): Promise<void> {
    const confirmations = await this.getConfirmations(txHash);
    const activeCount = confirmations.filter((c) => c.is_active).length;
    expect(activeCount).toBe(expectedCount);
  }

  // ============================================
  // DEPOSIT VERIFICATION
  // ============================================

  async getDeposits(walletAddress: string): Promise<DepositRecord[]> {
    const { data, error } = await this.supabase
      .from('deposits')
      .select('*')
      .eq('wallet_address', walletAddress.toLowerCase())
      .order('deposited_at_block', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async verifyDepositReceived(
    walletAddress: string,
    senderAddress: string,
    amount: string
  ): Promise<void> {
    const deposits = await this.getDeposits(walletAddress);
    const matchingDeposit = deposits.find(
      (d) => d.sender_address.toLowerCase() === senderAddress.toLowerCase() && d.amount === amount
    );
    expect(matchingDeposit).not.toBeUndefined();
  }

  // ============================================
  // MODULE VERIFICATION
  // ============================================

  async getWalletModules(walletAddress: string): Promise<WalletModuleRecord[]> {
    const { data, error } = await this.supabase
      .from('wallet_modules')
      .select('*')
      .eq('wallet_address', walletAddress.toLowerCase())
      .order('enabled_at_block', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  async verifyModuleEnabled(walletAddress: string, moduleAddress: string): Promise<void> {
    const modules = await this.getWalletModules(walletAddress);
    const module = modules.find(
      (m) => m.module_address.toLowerCase() === moduleAddress.toLowerCase()
    );
    expect(module).not.toBeUndefined();
    expect(module!.is_active).toBe(true);
  }

  async verifyModuleDisabled(walletAddress: string, moduleAddress: string): Promise<void> {
    const modules = await this.getWalletModules(walletAddress);
    const module = modules.find(
      (m) => m.module_address.toLowerCase() === moduleAddress.toLowerCase()
    );
    expect(module).not.toBeUndefined();
    expect(module!.is_active).toBe(false);
  }

  // ============================================
  // MODULE EXECUTION VERIFICATION (Zodiac)
  // ============================================

  async getModuleExecutions(walletAddress: string): Promise<ModuleExecutionRecord[]> {
    const { data, error } = await this.supabase
      .from('module_executions')
      .select('*')
      .eq('wallet_address', walletAddress.toLowerCase())
      .order('executed_at_block', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async verifyModuleExecutionSuccess(
    walletAddress: string,
    moduleAddress: string
  ): Promise<void> {
    const executions = await this.getModuleExecutions(walletAddress);
    const execution = executions.find(
      (e) => e.module_address.toLowerCase() === moduleAddress.toLowerCase() && e.success === true
    );
    expect(execution).not.toBeUndefined();
  }

  async verifyModuleExecutionFailure(
    walletAddress: string,
    moduleAddress: string
  ): Promise<void> {
    const executions = await this.getModuleExecutions(walletAddress);
    const execution = executions.find(
      (e) => e.module_address.toLowerCase() === moduleAddress.toLowerCase() && e.success === false
    );
    expect(execution).not.toBeUndefined();
  }

  // ============================================
  // DAILY LIMIT VERIFICATION
  // ============================================

  async getDailyLimitState(walletAddress: string): Promise<DailyLimitStateRecord | null> {
    const { data, error } = await this.supabase
      .from('daily_limit_state')
      .select('*')
      .eq('wallet_address', walletAddress.toLowerCase())
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async verifyDailyLimitSet(walletAddress: string, expectedLimit: string): Promise<void> {
    const state = await this.getDailyLimitState(walletAddress);
    expect(state).not.toBeNull();
    expect(state!.daily_limit).toBe(expectedLimit);
  }

  // ============================================
  // WHITELIST VERIFICATION
  // ============================================

  async getWhitelistEntries(walletAddress: string): Promise<WhitelistEntryRecord[]> {
    const { data, error } = await this.supabase
      .from('whitelist_entries')
      .select('*')
      .eq('wallet_address', walletAddress.toLowerCase())
      .order('added_at_block', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  async verifyAddressWhitelisted(
    walletAddress: string,
    whitelistedAddress: string
  ): Promise<void> {
    const entries = await this.getWhitelistEntries(walletAddress);
    const entry = entries.find(
      (e) =>
        e.whitelisted_address.toLowerCase() === whitelistedAddress.toLowerCase() &&
        e.is_active === true
    );
    expect(entry).not.toBeUndefined();
  }

  async verifyAddressRemovedFromWhitelist(
    walletAddress: string,
    removedAddress: string
  ): Promise<void> {
    const entries = await this.getWhitelistEntries(walletAddress);
    const entry = entries.find(
      (e) => e.whitelisted_address.toLowerCase() === removedAddress.toLowerCase()
    );
    expect(entry).not.toBeUndefined();
    expect(entry!.is_active).toBe(false);
  }

  // ============================================
  // MODULE TRANSACTIONS
  // ============================================

  async getModuleTransactions(walletAddress: string): Promise<ModuleTransactionRecord[]> {
    const { data, error } = await this.supabase
      .from('module_transactions')
      .select('*')
      .eq('wallet_address', walletAddress.toLowerCase())
      .order('executed_at_block', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async verifyModuleTransactionExecuted(
    walletAddress: string,
    moduleType: string
  ): Promise<void> {
    const transactions = await this.getModuleTransactions(walletAddress);
    const tx = transactions.find((t) => t.module_type === moduleType);
    expect(tx).not.toBeUndefined();
  }

  // ============================================
  // SOCIAL RECOVERY VERIFICATION
  // ============================================

  async getSocialRecoveryConfig(
    walletAddress: string
  ): Promise<SocialRecoveryConfigRecord | null> {
    const { data, error } = await this.supabase
      .from('social_recovery_configs')
      .select('*')
      .eq('wallet_address', walletAddress.toLowerCase())
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async getSocialRecoveryGuardians(
    walletAddress: string
  ): Promise<SocialRecoveryGuardianRecord[]> {
    const { data, error } = await this.supabase
      .from('social_recovery_guardians')
      .select('*')
      .eq('wallet_address', walletAddress.toLowerCase())
      .order('added_at_block', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  async getSocialRecoveries(walletAddress: string): Promise<SocialRecoveryRecord[]> {
    const { data, error } = await this.supabase
      .from('social_recoveries')
      .select('*')
      .eq('wallet_address', walletAddress.toLowerCase())
      .order('initiated_at_block', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async getSocialRecoveryApprovals(
    recoveryHash: string
  ): Promise<SocialRecoveryApprovalRecord[]> {
    const { data, error } = await this.supabase
      .from('social_recovery_approvals')
      .select('*')
      .eq('recovery_hash', recoveryHash.toLowerCase())
      .order('approved_at_block', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  async verifyRecoverySetup(
    walletAddress: string,
    expectedGuardians: string[],
    expectedThreshold: number
  ): Promise<void> {
    const config = await this.getSocialRecoveryConfig(walletAddress);
    expect(config).not.toBeNull();
    expect(config!.threshold).toBe(expectedThreshold);

    const guardians = await this.getSocialRecoveryGuardians(walletAddress);
    const activeGuardians = guardians.filter((g) => g.is_active);
    expect(activeGuardians).toHaveLength(expectedGuardians.length);

    const guardianAddresses = activeGuardians.map((g) => g.guardian_address.toLowerCase());
    for (const expected of expectedGuardians) {
      expect(guardianAddresses).toContain(expected.toLowerCase());
    }
  }

  async verifyRecoveryInitiated(walletAddress: string, recoveryHash: string): Promise<void> {
    const recoveries = await this.getSocialRecoveries(walletAddress);
    const recovery = recoveries.find(
      (r) => r.recovery_hash.toLowerCase() === recoveryHash.toLowerCase()
    );
    expect(recovery).not.toBeUndefined();
    expect(recovery!.status).toBe('pending');
  }

  async verifyRecoveryApprovalCount(recoveryHash: string, expectedCount: number): Promise<void> {
    const approvals = await this.getSocialRecoveryApprovals(recoveryHash);
    const activeCount = approvals.filter((a) => a.is_active).length;
    expect(activeCount).toBe(expectedCount);
  }

  async verifyRecoveryStatus(recoveryHash: string, expectedStatus: string): Promise<void> {
    const { data, error } = await this.supabase
      .from('social_recoveries')
      .select('*')
      .eq('recovery_hash', recoveryHash.toLowerCase())
      .maybeSingle();

    if (error) throw error;
    expect(data).not.toBeNull();
    expect(data!.status).toBe(expectedStatus);
  }
}
