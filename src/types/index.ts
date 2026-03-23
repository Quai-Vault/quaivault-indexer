// ============================================
// Blockchain Types
// ============================================

/**
 * Simplified log type for indexer use.
 * Contains only the fields we need, without the full quais.Log methods.
 */
export interface IndexerLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
  transactionIndex: number;
  blockHash: string;
  index: number;
  removed: boolean;
}

// ============================================
// Wallet Types
// ============================================

export interface Wallet {
  address: string;
  name?: string;
  threshold: number;
  ownerCount: number;
  createdAtBlock: number;
  createdAtTx: string;
  minExecutionDelay?: number;
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
  | 'module_config'      // Module configuration
  | 'wallet_admin'       // Wallet admin (addOwner, removeOwner, changeThreshold, enableModule, disableModule)
  | 'message_signing'    // EIP-1271 message signing (signMessage, unsignMessage)
  | 'recovery_setup'     // Social recovery setup
  | 'module_execution'   // execTransactionFromModule (Zodiac IAvatar)
  | 'batched_call'       // MultiSend batched transactions
  | 'external_call'      // Generic contract call
  | 'erc20_transfer'     // ERC20 token operations (transfer, approve, transferFrom)
  | 'erc721_transfer'    // ERC721 token operations (safeTransferFrom)
  | 'erc1155_transfer'   // ERC1155 token operations (safeTransferFrom, safeBatchTransferFrom)
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
  status: 'pending' | 'executed' | 'cancelled' | 'expired' | 'failed';
  confirmationCount: number;
  submittedBy: string;
  submittedAtBlock: number;
  submittedAtTx: string;
  executedAtBlock?: number;
  executedAtTx?: string;
  executedBy?: string;
  cancelledAtBlock?: number;
  cancelledAtTx?: string;
  expiration?: number;        // uint48, 0 = no expiry
  executionDelay?: number;    // uint32, 0 = immediate
  approvedAt?: number;        // uint48, set by ThresholdReached
  executableAfter?: number;   // approvedAt + executionDelay
  isExpired?: boolean;        // set by TransactionExpired handler
  failedReturnData?: string;  // revert data from TransactionFailed
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

export interface WalletDelegatecallTarget {
  walletAddress: string;
  targetAddress: string;
  addedAtBlock: number;
  addedAtTx: string;
  removedAtBlock?: number;
  removedAtTx?: string;
  isActive: boolean;
}

export interface IndexerState {
  lastIndexedBlock: number;
  lastBlockHash: string | null;
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
  status: 'pending' | 'executed' | 'cancelled' | 'invalidated' | 'expired';
  initiatedAtBlock: number;
  initiatedAtTx: string;
  executedAtBlock?: number;
  executedAtTx?: string;
  cancelledAtBlock?: number;
  cancelledAtTx?: string;
  expiration?: number;
  expiredAtBlock?: number;
  expiredAtTx?: string;
  invalidatedAtBlock?: number;
  invalidatedAtTx?: string;
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
  logIndex?: number;
}

// ============================================
// Token Types (ERC20 / ERC721 / ERC1155)
// ============================================

export type TokenStandard = 'ERC20' | 'ERC721' | 'ERC1155';

export interface TokenInfo {
  address: string;
  standard: TokenStandard;
  symbol: string;
  name: string;
  decimals: number;
}

export interface TokenTransfer {
  tokenAddress: string;
  walletAddress: string;
  fromAddress: string;
  toAddress: string;
  value: string;
  tokenId?: string;
  batchIndex?: number;  // 0 for single transfers, array index for ERC1155 TransferBatch fan-out
  direction: 'inflow' | 'outflow';
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

// ============================================
// Message Signing Types (EIP-1271)
// ============================================

export interface SignedMessage {
  walletAddress: string;
  msgHash: string;
  data?: string;
  signedAtBlock: number;
  signedAtTx: string;
  unsignedAtBlock?: number;
  unsignedAtTx?: string;
  isActive: boolean;
}
