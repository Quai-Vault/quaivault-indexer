import { quais } from 'quais';
import type { DecodedEvent, TransactionType, DecodedParams, IndexerLog, TokenStandard } from '../types/index.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// Event signatures (keccak256 hashes)
export const EVENT_SIGNATURES = {
  // QuaiVaultFactory
  WalletCreated: quais.id('WalletCreated(address,address[],uint256,address,bytes32)'),
  WalletRegistered: quais.id('WalletRegistered(address,address)'),

  // QuaiVault
  TransactionProposed: quais.id(
    'TransactionProposed(bytes32,address,address,uint256,bytes,uint48,uint32)'
  ),
  TransactionApproved: quais.id('TransactionApproved(bytes32,address)'),
  ApprovalRevoked: quais.id('ApprovalRevoked(bytes32,address)'),
  TransactionExecuted: quais.id('TransactionExecuted(bytes32,address)'),
  TransactionCancelled: quais.id('TransactionCancelled(bytes32,address)'),
  ThresholdReached: quais.id('ThresholdReached(bytes32,uint48,uint256)'),
  TransactionFailed: quais.id('TransactionFailed(bytes32,address,bytes)'),
  TransactionExpired: quais.id('TransactionExpired(bytes32)'),
  OwnerAdded: quais.id('OwnerAdded(address)'),
  OwnerRemoved: quais.id('OwnerRemoved(address)'),
  ThresholdChanged: quais.id('ThresholdChanged(uint256)'),
  EnabledModule: quais.id('EnabledModule(address)'),
  DisabledModule: quais.id('DisabledModule(address)'),
  Received: quais.id('Received(address,uint256)'),
  MinExecutionDelayChanged: quais.id('MinExecutionDelayChanged(uint32,uint32)'),
  MessageSigned: quais.id('MessageSigned(bytes32,bytes)'),
  MessageUnsigned: quais.id('MessageUnsigned(bytes32,bytes)'),

  // Zodiac IAvatar Events
  ExecutionFromModuleSuccess: quais.id('ExecutionFromModuleSuccess(address)'),
  ExecutionFromModuleFailure: quais.id('ExecutionFromModuleFailure(address)'),

  // Social Recovery Module
  RecoverySetup: quais.id('RecoverySetup(address,address[],uint256,uint256)'),
  RecoveryInitiated: quais.id(
    'RecoveryInitiated(address,bytes32,address[],uint256,address)'
  ),
  RecoveryApproved: quais.id('RecoveryApproved(address,bytes32,address)'),
  RecoveryApprovalRevoked: quais.id(
    'RecoveryApprovalRevoked(address,bytes32,address)'
  ),
  RecoveryExecuted: quais.id('RecoveryExecuted(address,bytes32)'),
  RecoveryCancelled: quais.id('RecoveryCancelled(address,bytes32)'),
  RecoveryInvalidated: quais.id('RecoveryInvalidated(address,bytes32)'),
  RecoveryExpiredEvent: quais.id('RecoveryExpiredEvent(address,bytes32)'),

  // ERC20/ERC721 Transfer (topic only — decoded from raw topics, not via EVENT_ABIS)
  Transfer: quais.id('Transfer(address,address,uint256)'),

  // ERC1155 Transfer events (different topic0 from ERC20/ERC721 Transfer)
  TransferSingle: quais.id('TransferSingle(address,address,address,uint256,uint256)'),
  TransferBatch: quais.id('TransferBatch(address,address,address,uint256[],uint256[])'),
};

// Reverse lookup: topic0 hash → event name (O(1) instead of O(N) linear scan)
const TOPIC_TO_EVENT = new Map<string, string>(
  Object.entries(EVENT_SIGNATURES).map(([name, sig]) => [sig, name])
);

// ABI fragments for decoding
const EVENT_ABIS: Record<string, string[]> = {
  // QuaiVaultFactory
  WalletCreated: [
    'address indexed wallet',
    'address[] owners',
    'uint256 threshold',
    'address indexed creator',
    'bytes32 salt',
  ],
  WalletRegistered: ['address indexed wallet', 'address indexed registrar'],

  // QuaiVault
  TransactionProposed: [
    'bytes32 indexed txHash',
    'address indexed proposer',
    'address indexed to',
    'uint256 value',
    'bytes data',
    'uint48 expiration',
    'uint32 executionDelay',
  ],
  TransactionApproved: [
    'bytes32 indexed txHash',
    'address indexed approver',
  ],
  ApprovalRevoked: ['bytes32 indexed txHash', 'address indexed owner'],
  TransactionExecuted: ['bytes32 indexed txHash', 'address indexed executor'],
  TransactionCancelled: ['bytes32 indexed txHash', 'address indexed canceller'],
  ThresholdReached: ['bytes32 indexed txHash', 'uint48 approvedAt', 'uint256 executableAfter'],
  TransactionFailed: ['bytes32 indexed txHash', 'address indexed executor', 'bytes returnData'],
  TransactionExpired: ['bytes32 indexed txHash'],
  OwnerAdded: ['address indexed owner'],
  OwnerRemoved: ['address indexed owner'],
  ThresholdChanged: ['uint256 threshold'],
  EnabledModule: ['address indexed module'],
  DisabledModule: ['address indexed module'],
  Received: ['address indexed sender', 'uint256 amount'],
  MinExecutionDelayChanged: ['uint32 oldDelay', 'uint32 newDelay'],
  MessageSigned: ['bytes32 indexed msgHash', 'bytes data'],
  MessageUnsigned: ['bytes32 indexed msgHash', 'bytes data'],

  // Zodiac IAvatar Events
  ExecutionFromModuleSuccess: ['address indexed module'],
  ExecutionFromModuleFailure: ['address indexed module'],

  // Social Recovery Module
  RecoverySetup: [
    'address indexed wallet',
    'address[] guardians',
    'uint256 threshold',
    'uint256 recoveryPeriod',
  ],
  RecoveryInitiated: [
    'address indexed wallet',
    'bytes32 indexed recoveryHash',
    'address[] newOwners',
    'uint256 newThreshold',
    'address indexed initiator',
  ],
  RecoveryApproved: [
    'address indexed wallet',
    'bytes32 indexed recoveryHash',
    'address indexed guardian',
  ],
  RecoveryApprovalRevoked: [
    'address indexed wallet',
    'bytes32 indexed recoveryHash',
    'address indexed guardian',
  ],
  RecoveryExecuted: [
    'address indexed wallet',
    'bytes32 indexed recoveryHash',
  ],
  RecoveryCancelled: [
    'address indexed wallet',
    'bytes32 indexed recoveryHash',
  ],
  RecoveryInvalidated: [
    'address indexed wallet',
    'bytes32 indexed recoveryHash',
  ],
  RecoveryExpiredEvent: [
    'address indexed wallet',
    'bytes32 indexed recoveryHash',
  ],
};

// Cached Interface objects for event decoding (avoid re-creating per call)
const EVENT_INTERFACES = new Map<string, quais.Interface>(
  Object.entries(EVENT_ABIS).map(([name, abi]) => [
    name,
    new quais.Interface([`event ${name}(${abi.join(', ')})`]),
  ])
);

export function decodeEvent(log: IndexerLog): DecodedEvent | null {
  const topic0 = log.topics[0];

  // Find matching event via O(1) reverse lookup
  const eventName = TOPIC_TO_EVENT.get(topic0);

  if (!eventName) {
    logger.debug(
      { topic0, address: log.address, blockNumber: log.blockNumber },
      'Unknown event topic - no match in EVENT_SIGNATURES'
    );
    return null;
  }

  const abiFragment = EVENT_ABIS[eventName];
  if (!abiFragment) {
    logger.warn(
      { eventName, topic0 },
      'Event found in signatures but no ABI fragment defined'
    );
    return null;
  }

  try {
    const iface = EVENT_INTERFACES.get(eventName)!;

    const decoded = iface.parseLog({
      topics: log.topics as string[],
      data: log.data,
    });

    if (!decoded) {
      logger.debug(
        { eventName, topic0, address: log.address },
        'parseLog returned null'
      );
      return null;
    }

    // Convert to plain object
    const args: Record<string, unknown> = {};
    decoded.fragment.inputs.forEach((input, i) => {
      const value = decoded.args[i];
      // Handle arrays and BigInts
      if (Array.isArray(value)) {
        args[input.name] = value.map((v) =>
          typeof v === 'bigint' ? v.toString() : v
        );
      } else {
        args[input.name] = typeof value === 'bigint' ? value.toString() : value;
      }
    });

    logger.debug(
      { eventName, address: log.address, blockNumber: log.blockNumber },
      'Event decoded successfully'
    );

    return {
      name: eventName,
      args,
      address: log.address,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.index,
    };
  } catch (error) {
    logger.debug(
      { eventName, topic0, err: error },
      'Error decoding event'
    );
    return null;
  }
}

export function getAllEventTopics(): string[] {
  return Object.values(EVENT_SIGNATURES);
}

/** Transfer event names handled separately by the wildcard transfer scan. */
const TRANSFER_TOPIC_NAMES = new Set(['Transfer', 'TransferSingle', 'TransferBatch']);

/**
 * Get event topics for wallet contract queries, excluding Transfer events.
 * Transfer events are fetched separately via wildcard scans to avoid duplicate fetching.
 */
export function getWalletEventTopics(): string[] {
  return Object.entries(EVENT_SIGNATURES)
    .filter(([name]) => !TRANSFER_TOPIC_NAMES.has(name))
    .map(([, sig]) => sig);
}

export function getSocialRecoveryEventTopics(): string[] {
  return [
    EVENT_SIGNATURES.RecoverySetup,
    EVENT_SIGNATURES.RecoveryInitiated,
    EVENT_SIGNATURES.RecoveryApproved,
    EVENT_SIGNATURES.RecoveryApprovalRevoked,
    EVENT_SIGNATURES.RecoveryExecuted,
    EVENT_SIGNATURES.RecoveryCancelled,
    EVENT_SIGNATURES.RecoveryInvalidated,
    EVENT_SIGNATURES.RecoveryExpiredEvent,
  ];
}

export function getModuleEventTopics(): string[] {
  return getSocialRecoveryEventTopics();
}

export function getTokenTransferTopic(): string {
  return EVENT_SIGNATURES.Transfer;
}

export function getERC1155TransferTopics(): string[] {
  return [EVENT_SIGNATURES.TransferSingle, EVENT_SIGNATURES.TransferBatch];
}

// ============================================
// CALLDATA DECODER FOR TRANSACTION PROPOSALS
// ============================================

// Function selectors (first 4 bytes of keccak256 hash)
const FUNCTION_SELECTORS: Record<string, { name: string; abi: string; type: TransactionType }> = {
  // Wallet Admin Functions
  [quais.id('addOwner(address)').slice(0, 10)]: {
    name: 'addOwner',
    abi: 'function addOwner(address owner)',
    type: 'wallet_admin',
  },
  [quais.id('removeOwner(address)').slice(0, 10)]: {
    name: 'removeOwner',
    abi: 'function removeOwner(address owner)',
    type: 'wallet_admin',
  },
  [quais.id('changeThreshold(uint256)').slice(0, 10)]: {
    name: 'changeThreshold',
    abi: 'function changeThreshold(uint256 _threshold)',
    type: 'wallet_admin',
  },
  [quais.id('enableModule(address)').slice(0, 10)]: {
    name: 'enableModule',
    abi: 'function enableModule(address module)',
    type: 'wallet_admin',
  },
  // Zodiac 2-param disableModule (linked list)
  [quais.id('disableModule(address,address)').slice(0, 10)]: {
    name: 'disableModule',
    abi: 'function disableModule(address prevModule, address module)',
    type: 'wallet_admin',
  },

  // Message signing self-calls
  [quais.id('signMessage(bytes)').slice(0, 10)]: {
    name: 'signMessage',
    abi: 'function signMessage(bytes data)',
    type: 'message_signing',
  },
  [quais.id('unsignMessage(bytes)').slice(0, 10)]: {
    name: 'unsignMessage',
    abi: 'function unsignMessage(bytes data)',
    type: 'message_signing',
  },

  // Consensus cancellation self-call
  [quais.id('cancelByConsensus(bytes32)').slice(0, 10)]: {
    name: 'cancelByConsensus',
    abi: 'function cancelByConsensus(bytes32 txHash)',
    type: 'wallet_admin',
  },

  // Execution delay management self-call
  [quais.id('setMinExecutionDelay(uint32)').slice(0, 10)]: {
    name: 'setMinExecutionDelay',
    abi: 'function setMinExecutionDelay(uint32 delay)',
    type: 'wallet_admin',
  },

  // Zodiac Module Execution Functions
  // 4-param execTransactionFromModule (Enum.Operation encoded as uint8)
  [quais.id('execTransactionFromModule(address,uint256,bytes,uint8)').slice(0, 10)]: {
    name: 'execTransactionFromModule',
    abi: 'function execTransactionFromModule(address to, uint256 value, bytes data, uint8 operation)',
    type: 'module_execution',
  },
  // 3-param execTransactionFromModule (legacy, defaults to Call)
  [quais.id('execTransactionFromModule(address,uint256,bytes)').slice(0, 10)]: {
    name: 'execTransactionFromModule',
    abi: 'function execTransactionFromModule(address to, uint256 value, bytes data)',
    type: 'module_execution',
  },
  // execTransactionFromModuleReturnData
  [quais.id('execTransactionFromModuleReturnData(address,uint256,bytes,uint8)').slice(0, 10)]: {
    name: 'execTransactionFromModuleReturnData',
    abi: 'function execTransactionFromModuleReturnData(address to, uint256 value, bytes data, uint8 operation)',
    type: 'module_execution',
  },

  // MultiSend batched transactions
  [quais.id('multiSend(bytes)').slice(0, 10)]: {
    name: 'multiSend',
    abi: 'function multiSend(bytes transactions)',
    type: 'batched_call',
  },

  // Social Recovery Module Functions
  [quais.id('setupRecovery(address,address[],uint256,uint256)').slice(0, 10)]: {
    name: 'setupRecovery',
    abi: 'function setupRecovery(address wallet, address[] guardians, uint256 threshold, uint256 recoveryPeriod)',
    type: 'recovery_setup',
  },

  // ERC20 Token Functions
  [quais.id('transfer(address,uint256)').slice(0, 10)]: {
    name: 'transfer',
    abi: 'function transfer(address to, uint256 amount)',
    type: 'erc20_transfer',
  },
  [quais.id('approve(address,uint256)').slice(0, 10)]: {
    name: 'approve',
    abi: 'function approve(address spender, uint256 amount)',
    type: 'erc20_transfer',
  },
  [quais.id('transferFrom(address,address,uint256)').slice(0, 10)]: {
    name: 'transferFrom',
    abi: 'function transferFrom(address from, address to, uint256 amount)',
    type: 'erc20_transfer',
  },

  // ERC721 Token Functions
  [quais.id('safeTransferFrom(address,address,uint256)').slice(0, 10)]: {
    name: 'safeTransferFrom',
    abi: 'function safeTransferFrom(address from, address to, uint256 tokenId)',
    type: 'erc721_transfer',
  },
  [quais.id('safeTransferFrom(address,address,uint256,bytes)').slice(0, 10)]: {
    name: 'safeTransferFrom',
    abi: 'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
    type: 'erc721_transfer',
  },

  // ERC1155 Token Functions
  [quais.id('safeTransferFrom(address,address,uint256,uint256,bytes)').slice(0, 10)]: {
    name: 'safeTransferFrom',
    abi: 'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
    type: 'erc1155_transfer',
  },
  [quais.id('safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)').slice(0, 10)]: {
    name: 'safeBatchTransferFrom',
    abi: 'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)',
    type: 'erc1155_transfer',
  },
};

// Cached Interface objects for calldata decoding (avoid re-creating per call)
const FUNCTION_INTERFACES = new Map<string, quais.Interface>(
  Object.entries(FUNCTION_SELECTORS).map(([selector, info]) => [
    selector,
    new quais.Interface([info.abi]),
  ])
);

/** Set of function selectors that target token contracts (ERC20/721/1155) */
const TOKEN_SELECTORS = new Set(
  Object.entries(FUNCTION_SELECTORS)
    .filter(([, info]) =>
      info.type === 'erc20_transfer' ||
      info.type === 'erc721_transfer' ||
      info.type === 'erc1155_transfer'
    )
    .map(([selector]) => selector)
);

/**
 * Check if calldata targets a token function (transfer, approve, etc.).
 * Used to decide whether to probe an unknown contract for token metadata.
 */
export function isTokenSelector(data: string): boolean {
  if (!data || data.length < 10) return false;
  return TOKEN_SELECTORS.has(data.slice(0, 10).toLowerCase());
}

export interface DecodedCalldata {
  transactionType: TransactionType;
  decodedParams?: DecodedParams;
}

/**
 * Decode transaction calldata and determine the transaction type.
 * When tokenStandard is provided, disambiguates shared selectors
 * (e.g. transferFrom, approve) between ERC20 and ERC721.
 */
export function decodeCalldata(
  toAddress: string,
  data: string,
  value: string,
  tokenStandard?: TokenStandard
): DecodedCalldata {
  // Check for empty data (pure transfer)
  if (!data || data === '0x' || data === '') {
    return {
      transactionType: 'transfer',
      decodedParams: undefined,
    };
  }

  // Get the function selector (first 4 bytes)
  const selector = data.slice(0, 10).toLowerCase();
  const functionInfo = FUNCTION_SELECTORS[selector];

  if (!functionInfo) {
    // Check if this is a call to a known module address
    const toLower = toAddress.toLowerCase();
    const isModuleCall =
      (config.contracts.socialRecoveryModule?.toLowerCase() === toLower);

    // If it's a call to a module but unknown function, it's still module_config
    if (isModuleCall) {
      return {
        transactionType: 'module_config',
        decodedParams: {
          function: 'unknown',
          args: { rawData: data },
        },
      };
    }

    // Unknown selector with data — external contract call
    return {
      transactionType: 'external_call',
      decodedParams: {
        function: 'unknown',
        args: { rawData: data },
      },
    };
  }

  // Disambiguate ERC20/ERC721 shared selectors when token standard is known.
  // transferFrom(address,address,uint256) and approve(address,uint256) have
  // identical selectors for both standards.
  let resolvedType = functionInfo.type;
  if (
    tokenStandard === 'ERC721' &&
    resolvedType === 'erc20_transfer' &&
    (functionInfo.name === 'transferFrom' || functionInfo.name === 'approve')
  ) {
    resolvedType = 'erc721_transfer';
  }

  // Decode the function arguments
  try {
    const iface = FUNCTION_INTERFACES.get(selector)!;
    const decoded = iface.parseTransaction({ data, value });

    if (!decoded) {
      return {
        transactionType: resolvedType,
        decodedParams: {
          function: functionInfo.name,
          args: { rawData: data },
        },
      };
    }

    // Convert decoded args to plain object
    const args: Record<string, string | string[]> = {};
    decoded.fragment.inputs.forEach((input, i) => {
      const val = decoded.args[i];
      if (Array.isArray(val)) {
        args[input.name] = val.map((v) =>
          typeof v === 'bigint' ? v.toString() : String(v)
        );
      } else {
        args[input.name] = typeof val === 'bigint' ? val.toString() : String(val);
      }
    });

    return {
      transactionType: resolvedType,
      decodedParams: {
        function: functionInfo.name,
        args,
      },
    };
  } catch {
    return {
      transactionType: resolvedType,
      decodedParams: {
        function: functionInfo.name,
        args: { rawData: data },
      },
    };
  }
}

/**
 * Get human-readable description of a decoded transaction
 */
export function getTransactionDescription(decoded: DecodedCalldata): string {
  if (!decoded.decodedParams) {
    return decoded.transactionType === 'transfer' ? 'QUAI transfer' : 'Unknown transaction';
  }

  const { function: fn, args } = decoded.decodedParams;

  switch (fn) {
    case 'addOwner':
      return `Add owner: ${args.owner}`;
    case 'removeOwner':
      return `Remove owner: ${args.owner}`;
    case 'changeThreshold':
      return `Change threshold to ${args._threshold}`;
    case 'enableModule':
      return `Enable module: ${args.module}`;
    case 'disableModule':
      return args.prevModule
        ? `Disable module: ${args.module} (prev: ${args.prevModule})`
        : `Disable module: ${args.module}`;
    case 'signMessage':
      return `Sign message (EIP-1271)`;
    case 'unsignMessage':
      return `Unsign message (EIP-1271)`;
    case 'cancelByConsensus':
      return `Cancel transaction by consensus: ${args.txHash}`;
    case 'setMinExecutionDelay':
      return `Set minimum execution delay to ${args.delay}`;
    case 'setupRecovery':
      return `Setup recovery with ${(args.guardians as string[]).length} guardians`;
    // Zodiac module execution functions
    case 'execTransactionFromModule':
      return args.operation !== undefined
        ? `Module execution to ${args.to} (${args.operation === '0' ? 'Call' : 'DelegateCall'})`
        : `Module execution to ${args.to}`;
    case 'execTransactionFromModuleReturnData':
      return `Module execution with return data to ${args.to} (${args.operation === '0' ? 'Call' : 'DelegateCall'})`;
    case 'multiSend':
      return 'Batched transactions via MultiSend';
    // ERC20 token functions
    case 'transfer':
      return `ERC20 transfer: ${args.amount} to ${args.to}`;
    case 'approve':
      return decoded.transactionType === 'erc721_transfer'
        ? `ERC721 approve: token #${args.amount} to ${args.spender}`
        : `ERC20 approve: ${args.spender} for ${args.amount}`;
    case 'transferFrom':
      return decoded.transactionType === 'erc721_transfer'
        ? `ERC721 transferFrom: token #${args.amount} from ${args.from} to ${args.to}`
        : `ERC20 transferFrom: ${args.amount} from ${args.from} to ${args.to}`;
    // ERC721 / ERC1155 token functions
    case 'safeTransferFrom':
      if (args.amount !== undefined) {
        return `ERC1155 safeTransferFrom: ${args.amount}x token #${args.id} from ${args.from} to ${args.to}`;
      }
      return args.data !== undefined
        ? `ERC721 safeTransferFrom: token #${args.tokenId} from ${args.from} to ${args.to} (with data)`
        : `ERC721 safeTransferFrom: token #${args.tokenId} from ${args.from} to ${args.to}`;
    case 'safeBatchTransferFrom':
      return `ERC1155 safeBatchTransferFrom: from ${args.from} to ${args.to}`;
    default:
      return `${decoded.transactionType}: ${fn}`;
  }
}

// ============================================
// MULTISEND TRANSACTION DECODER
// ============================================

export interface MultiSendTransaction {
  operation: number; // 0 = Call, 1 = DelegateCall
  to: string;
  value: string;
  data: string;
}

/**
 * Decode MultiSend packed transactions payload
 *
 * Each transaction in the payload is encoded as:
 * - operation (uint8): 1 byte - 0 for call, 1 for delegatecall
 * - to (address): 20 bytes - target address
 * - value (uint256): 32 bytes - ETH value
 * - dataLength (uint256): 32 bytes - length of data
 * - data (bytes): variable length - calldata
 */
export function decodeMultiSendTransactions(encodedTransactions: string): MultiSendTransaction[] {
  const transactions: MultiSendTransaction[] = [];

  // Remove 0x prefix if present
  const data = encodedTransactions.startsWith('0x')
    ? encodedTransactions.slice(2)
    : encodedTransactions;

  let offset = 0;

  while (offset < data.length) {
    try {
      // Ensure enough data for the fixed-size header (1 + 20 + 32 + 32 = 85 bytes = 170 hex chars)
      if (offset + 170 > data.length) break;

      // operation: 1 byte (2 hex chars)
      const operation = parseInt(data.slice(offset, offset + 2), 16);
      if (operation !== 0 && operation !== 1) {
        logger.warn({ operation, offset }, 'MultiSend: invalid operation type, stopping decode');
        break;
      }
      offset += 2;

      // to: 20 bytes (40 hex chars)
      const to = '0x' + data.slice(offset, offset + 40);
      offset += 40;

      // value: 32 bytes (64 hex chars)
      const value = BigInt('0x' + data.slice(offset, offset + 64)).toString();
      offset += 64;

      // dataLength: 32 bytes (64 hex chars)
      const dataLength = parseInt(data.slice(offset, offset + 64), 16);
      offset += 64;

      // Bounds check on dataLength
      if (dataLength < 0 || dataLength > 1_000_000) {
        logger.warn({ dataLength, offset }, 'MultiSend: unreasonable data length, stopping decode');
        break;
      }
      if (offset + dataLength * 2 > data.length) {
        logger.warn({ dataLength, offset, dataLen: data.length }, 'MultiSend: data extends past end of buffer, stopping decode');
        break;
      }

      // data: variable length
      const txData = '0x' + data.slice(offset, offset + dataLength * 2);
      offset += dataLength * 2;

      transactions.push({
        operation,
        to,
        value,
        data: txData,
      });
    } catch {
      // If we can't parse, break out of loop
      break;
    }
  }

  return transactions;
}
