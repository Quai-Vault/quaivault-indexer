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
  min_execution_delay?: number;
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
  status: 'pending' | 'executed' | 'cancelled' | 'expired' | 'failed';
  confirmation_count: number;
  submitted_by: string;
  submitted_at_block: number;
  submitted_at_tx: string;
  executed_at_block?: number;
  executed_at_tx?: string;
  executed_by?: string;
  cancelled_at_block?: number;
  cancelled_at_tx?: string;
  expiration?: number;
  execution_delay?: number;
  approved_at?: number;
  executable_after?: number;
  is_expired?: boolean;
  failed_return_data?: string;
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

export interface SocialRecoveryConfigRecord {
  id: string;
  wallet_address: string;
  threshold: number;
  recovery_period: number;
  setup_at_block: number;
  setup_at_tx: string;
  is_active: boolean;
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

export interface TokenRecord {
  id: string;
  address: string;
  standard: 'ERC20' | 'ERC721' | 'ERC1155';
  name: string;
  symbol: string;
  decimals: number;
  discovered_at_block: number;
  discovered_via: string;
  created_at: string;
  updated_at: string;
}

export interface TokenTransferRecord {
  id: string;
  token_address: string;
  wallet_address: string;
  from_address: string;
  to_address: string;
  value: string;
  token_id?: string;
  batch_index: number;
  direction: 'inflow' | 'outflow';
  block_number: number;
  transaction_hash: string;
  log_index: number;
  created_at: string;
}

export interface DelegatecallTargetRecord {
  id: string;
  wallet_address: string;
  target_address: string;
  added_at_block: number;
  added_at_tx: string;
  removed_at_block: number | null;
  removed_at_tx: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SignedMessageRecord {
  id: string;
  wallet_address: string;
  msg_hash: string;
  data?: string;
  signed_at_block: number;
  signed_at_tx: string;
  unsigned_at_block?: number;
  unsigned_at_tx?: string;
  is_active: boolean;
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSupabaseClient(config: E2EConfig): SupabaseClient<any, any, any> {
  return createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false },
    db: { schema: config.supabaseSchema },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as SupabaseClient<any, any, any>;
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

  // ============================================
  // SIGNED MESSAGE VERIFICATION (EIP-1271)
  // ============================================

  async getSignedMessages(walletAddress: string): Promise<SignedMessageRecord[]> {
    const { data, error } = await this.supabase
      .from('signed_messages')
      .select('*')
      .eq('wallet_address', walletAddress.toLowerCase())
      .order('signed_at_block', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async verifyMessageSigned(walletAddress: string, msgHash: string): Promise<void> {
    const messages = await this.getSignedMessages(walletAddress);
    const msg = messages.find((m) => m.msg_hash.toLowerCase() === msgHash.toLowerCase());
    expect(msg).not.toBeUndefined();
    expect(msg!.is_active).toBe(true);
    expect(msg!.signed_at_block).toBeGreaterThan(0);
  }

  async verifyMessageUnsigned(walletAddress: string, msgHash: string): Promise<void> {
    const messages = await this.getSignedMessages(walletAddress);
    const msg = messages.find((m) => m.msg_hash.toLowerCase() === msgHash.toLowerCase());
    expect(msg).not.toBeUndefined();
    expect(msg!.is_active).toBe(false);
    expect(msg!.unsigned_at_block).not.toBeNull();
    expect(msg!.unsigned_at_tx).not.toBeNull();
  }

  // ============================================
  // THRESHOLD REACHED VERIFICATION
  // ============================================

  async verifyThresholdReached(walletAddress: string, txHash: string): Promise<void> {
    const tx = await this.getTransaction(walletAddress, txHash);
    expect(tx).not.toBeNull();
    expect(tx!.approved_at).not.toBeNull();
    expect(tx!.approved_at).toBeGreaterThan(0);
    expect(tx!.executable_after).not.toBeNull();
  }

  // ============================================
  // TRANSACTION FAILED VERIFICATION
  // ============================================

  async verifyTransactionFailed(walletAddress: string, txHash: string): Promise<void> {
    const tx = await this.getTransaction(walletAddress, txHash);
    expect(tx).not.toBeNull();
    expect(tx!.status).toBe('failed');
  }

  // ============================================
  // TRANSACTION EXPIRED VERIFICATION
  // ============================================

  async verifyTransactionExpired(walletAddress: string, txHash: string): Promise<void> {
    const tx = await this.getTransaction(walletAddress, txHash);
    expect(tx).not.toBeNull();
    expect(tx!.status).toBe('expired');
    expect(tx!.is_expired).toBe(true);
  }

  // ============================================
  // MIN EXECUTION DELAY VERIFICATION
  // ============================================

  async verifyMinExecutionDelay(walletAddress: string, expectedDelay: number): Promise<void> {
    const wallet = await this.getWallet(walletAddress);
    expect(wallet).not.toBeNull();
    expect(wallet!.min_execution_delay).toBe(expectedDelay);
  }

  // ============================================
  // DELEGATECALL TARGET VERIFICATION
  // ============================================

  async getDelegatecallTargets(walletAddress: string): Promise<DelegatecallTargetRecord[]> {
    const { data, error } = await this.supabase
      .from('wallet_delegatecall_targets')
      .select('*')
      .eq('wallet_address', walletAddress.toLowerCase())
      .order('added_at_block', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  async verifyDelegatecallTarget(
    walletAddress: string,
    targetAddress: string,
    isActive: boolean
  ): Promise<void> {
    const targets = await this.getDelegatecallTargets(walletAddress);
    const target = targets.find(
      (t) => t.target_address.toLowerCase() === targetAddress.toLowerCase()
    );
    expect(target).not.toBeUndefined();
    expect(target!.is_active).toBe(isActive);
  }

  async verifyRecoveryConfigDeactivated(walletAddress: string): Promise<void> {
    const { data: config, error: configError } = await this.supabase
      .from('social_recovery_configs')
      .select('is_active')
      .eq('wallet_address', walletAddress.toLowerCase())
      .maybeSingle();

    if (configError) throw configError;
    if (config) {
      expect(config.is_active).toBe(false);
    }

    const guardians = await this.getSocialRecoveryGuardians(walletAddress);
    const activeGuardians = guardians.filter((g) => g.is_active);
    expect(activeGuardians).toHaveLength(0);
  }

  // ============================================
  // TOKEN VERIFICATION
  // ============================================

  async getToken(tokenAddress: string): Promise<TokenRecord | null> {
    const { data, error } = await this.supabase
      .from('tokens')
      .select('*')
      .eq('address', tokenAddress.toLowerCase())
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async getTokenTransfers(walletAddress: string): Promise<TokenTransferRecord[]> {
    const { data, error } = await this.supabase
      .from('token_transfers')
      .select('*')
      .eq('wallet_address', walletAddress.toLowerCase())
      .order('block_number', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async verifyTokenDiscovered(
    tokenAddress: string,
    expectedStandard: 'ERC20' | 'ERC721' | 'ERC1155'
  ): Promise<void> {
    const token = await this.getToken(tokenAddress);
    expect(token).not.toBeNull();
    expect(token!.standard).toBe(expectedStandard);
  }

  async verifyTokenTransferInflow(
    walletAddress: string,
    tokenAddress: string,
    fromAddress: string,
    opts: { value?: string; tokenId?: string; batchIndex?: number } = {}
  ): Promise<void> {
    const transfers = await this.getTokenTransfers(walletAddress);
    const match = transfers.find(
      (t) =>
        t.token_address.toLowerCase() === tokenAddress.toLowerCase() &&
        t.from_address.toLowerCase() === fromAddress.toLowerCase() &&
        t.direction === 'inflow' &&
        (opts.value === undefined || t.value === opts.value) &&
        (opts.tokenId === undefined || t.token_id === opts.tokenId) &&
        (opts.batchIndex === undefined || t.batch_index === opts.batchIndex)
    );
    expect(match).not.toBeUndefined();
  }

  async verifyTokenTransferOutflow(
    walletAddress: string,
    tokenAddress: string,
    toAddress: string,
    opts: { value?: string; tokenId?: string; batchIndex?: number } = {}
  ): Promise<void> {
    const transfers = await this.getTokenTransfers(walletAddress);
    const match = transfers.find(
      (t) =>
        t.token_address.toLowerCase() === tokenAddress.toLowerCase() &&
        t.to_address.toLowerCase() === toAddress.toLowerCase() &&
        t.direction === 'outflow' &&
        (opts.value === undefined || t.value === opts.value) &&
        (opts.tokenId === undefined || t.token_id === opts.tokenId) &&
        (opts.batchIndex === undefined || t.batch_index === opts.batchIndex)
    );
    expect(match).not.toBeUndefined();
  }
}
