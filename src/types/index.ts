export interface Wallet {
  address: string;
  name?: string;
  threshold: number;
  ownerCount: number;
  createdAtBlock: number;
  createdAtTx: string;
}

export interface WalletOwner {
  walletAddress: string;
  ownerAddress: string;
  addedAtBlock: number;
  addedAtTx: string;
  removedAtBlock?: number;
  removedAtTx?: string;
  isActive: boolean;
}

export type TransactionType =
  | 'transfer'           // Native QUAI transfer (no data or empty data)
  | 'module_config'      // Module configuration (setDailyLimit, addToWhitelist, etc.)
  | 'wallet_admin'       // Wallet admin (addOwner, removeOwner, changeThreshold, enableModule, disableModule)
  | 'recovery_setup'     // Social recovery setup
  | 'module_execution'   // execTransactionFromModule (Zodiac IAvatar)
  | 'batched_call'       // MultiSend batched transactions
  | 'external_call'      // Generic contract call
  | 'unknown';           // Could not be decoded

// ============================================
// Zodiac IAvatar Types
// ============================================

export enum OperationType {
  Call = 0,
  DelegateCall = 1,
}

export interface DecodedParams {
  function: string;
  args: Record<string, string | string[]>;
}

export interface MultisigTransaction {
  walletAddress: string;
  txHash: string; // bytes32 transaction hash
  to: string;
  value: string;
  data: string;
  transactionType: TransactionType;
  decodedParams?: DecodedParams;
  status: 'pending' | 'executed' | 'cancelled';
  confirmationCount: number;
  submittedBy: string;
  submittedAtBlock: number;
  submittedAtTx: string;
  executedAtBlock?: number;
  executedAtTx?: string;
  executedBy?: string; // Address of the owner who executed the transaction
  cancelledAtBlock?: number;
  cancelledAtTx?: string;
}

export interface Confirmation {
  walletAddress: string;
  txHash: string; // bytes32 transaction hash
  ownerAddress: string;
  confirmedAtBlock: number;
  confirmedAtTx: string;
  revokedAtBlock?: number;
  revokedAtTx?: string;
  isActive: boolean;
}

export interface WalletModule {
  walletAddress: string;
  moduleAddress: string;
  enabledAtBlock: number;
  enabledAtTx: string;
  disabledAtBlock?: number;
  disabledAtTx?: string;
  isActive: boolean;
}

export interface IndexerState {
  lastIndexedBlock: number;
  lastIndexedAt: Date;
  isSyncing: boolean;
}

export interface DecodedEvent {
  name: string;
  args: Record<string, unknown>;
  address: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

// ============================================
// Social Recovery Module Types
// ============================================

export interface SocialRecoveryConfig {
  walletAddress: string;
  guardians: string[];
  threshold: number;
  recoveryPeriod: number;
  setupAtBlock: number;
  setupAtTx: string;
}

export interface SocialRecovery {
  walletAddress: string;
  recoveryHash: string;
  newOwners: string[];
  newThreshold: number;
  initiatorAddress: string;
  approvalCount: number;
  requiredThreshold: number;
  executionTime: number;
  status: 'pending' | 'executed' | 'cancelled';
  initiatedAtBlock: number;
  initiatedAtTx: string;
  executedAtBlock?: number;
  executedAtTx?: string;
  cancelledAtBlock?: number;
  cancelledAtTx?: string;
}

export interface SocialRecoveryApproval {
  walletAddress: string;
  recoveryHash: string;
  guardianAddress: string;
  approvedAtBlock: number;
  approvedAtTx: string;
  revokedAtBlock?: number;
  revokedAtTx?: string;
  isActive: boolean;
}

// ============================================
// Daily Limit Module Types
// ============================================

export interface DailyLimitState {
  walletAddress: string;
  dailyLimit: string;
  spentToday: string;
  lastResetDay: string;
}

// ============================================
// Module Transaction Types
// ============================================

export interface ModuleTransaction {
  walletAddress: string;
  moduleType: 'daily_limit' | 'whitelist' | 'social_recovery';
  moduleAddress: string;
  toAddress: string;
  value: string;
  remainingLimit?: string; // Only for daily limit
  operationType?: OperationType; // For Zodiac IAvatar module executions
  executedAtBlock: number;
  executedAtTx: string;
}

// ============================================
// Whitelist Module Types
// ============================================

export interface WhitelistEntry {
  walletAddress: string;
  whitelistedAddress: string;
  limit: string;
  addedAtBlock: number;
  addedAtTx: string;
  removedAtBlock?: number;
  removedAtTx?: string;
  isActive: boolean;
}

// ============================================
// Module Execution Types (Zodiac IAvatar)
// ============================================

export interface ModuleExecution {
  walletAddress: string;
  moduleAddress: string;
  success: boolean;
  operationType?: OperationType;
  toAddress?: string;
  value?: string;
  dataHash?: string;
  executedAtBlock: number;
  executedAtTx: string;
}
