import { quais } from 'quais';
import type { DecodedEvent, TransactionType, DecodedParams, IndexerLog } from '../types/index.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

// Mapping from internal event names to actual contract event names
// Used when internal name differs from the actual event name in the contract
// (e.g., we use 'DailyLimitTransactionExecuted' internally but the contract emits 'TransactionExecuted')
const ACTUAL_EVENT_NAMES: Record<string, string> = {
  DailyLimitTransactionExecuted: 'TransactionExecuted',
};

// Event signatures (keccak256 hashes)
export const EVENT_SIGNATURES = {
  // QuaiVaultFactory
  WalletCreated: quais.id('WalletCreated(address,address[],uint256,address,bytes32)'),
  WalletRegistered: quais.id('WalletRegistered(address,address)'),

  // QuaiVault (formerly MultisigWallet)
  TransactionProposed: quais.id(
    'TransactionProposed(bytes32,address,address,uint256,bytes)'
  ),
  TransactionApproved: quais.id('TransactionApproved(bytes32,address)'),
  ApprovalRevoked: quais.id('ApprovalRevoked(bytes32,address)'),
  TransactionExecuted: quais.id('TransactionExecuted(bytes32,address)'),
  TransactionCancelled: quais.id('TransactionCancelled(bytes32,address)'),
  OwnerAdded: quais.id('OwnerAdded(address)'),
  OwnerRemoved: quais.id('OwnerRemoved(address)'),
  ThresholdChanged: quais.id('ThresholdChanged(uint256)'),
  ModuleEnabled: quais.id('ModuleEnabled(address)'),
  ModuleDisabled: quais.id('ModuleDisabled(address)'),
  Received: quais.id('Received(address,uint256)'),

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

  // Daily Limit Module
  DailyLimitSet: quais.id('DailyLimitSet(address,uint256)'),
  DailyLimitReset: quais.id('DailyLimitReset(address)'),
  DailyLimitTransactionExecuted: quais.id(
    'TransactionExecuted(address,address,uint256,uint256)'
  ),

  // Whitelist Module
  AddressWhitelisted: quais.id('AddressWhitelisted(address,address,uint256)'),
  AddressRemovedFromWhitelist: quais.id(
    'AddressRemovedFromWhitelist(address,address)'
  ),
  WhitelistTransactionExecuted: quais.id(
    'WhitelistTransactionExecuted(address,address,uint256)'
  ),
};

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

  // QuaiVault (formerly MultisigWallet)
  TransactionProposed: [
    'bytes32 indexed txHash',
    'address indexed proposer',
    'address indexed to',
    'uint256 value',
    'bytes data',
  ],
  TransactionApproved: [
    'bytes32 indexed txHash',
    'address indexed approver',
  ],
  ApprovalRevoked: ['bytes32 indexed txHash', 'address indexed owner'],
  TransactionExecuted: ['bytes32 indexed txHash', 'address indexed executor'],
  TransactionCancelled: ['bytes32 indexed txHash', 'address indexed canceller'],
  OwnerAdded: ['address indexed owner'],
  OwnerRemoved: ['address indexed owner'],
  ThresholdChanged: ['uint256 threshold'],
  ModuleEnabled: ['address indexed module'],
  ModuleDisabled: ['address indexed module'],
  Received: ['address indexed sender', 'uint256 amount'],

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

  // Daily Limit Module
  DailyLimitSet: ['address indexed wallet', 'uint256 limit'],
  DailyLimitReset: ['address indexed wallet'],
  DailyLimitTransactionExecuted: [
    'address indexed wallet',
    'address indexed to',
    'uint256 value',
    'uint256 remainingLimit',
  ],

  // Whitelist Module
  AddressWhitelisted: [
    'address indexed wallet',
    'address indexed addr',
    'uint256 limit',
  ],
  AddressRemovedFromWhitelist: [
    'address indexed wallet',
    'address indexed addr',
  ],
  WhitelistTransactionExecuted: [
    'address indexed wallet',
    'address indexed to',
    'uint256 value',
  ],
};

export function decodeEvent(log: IndexerLog): DecodedEvent | null {
  const topic0 = log.topics[0];

  // Find matching event
  const eventName = Object.entries(EVENT_SIGNATURES).find(
    ([, sig]) => sig === topic0
  )?.[0];

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
    // Use actual event name for Interface (some internal names differ from contract event names)
    const actualEventName = ACTUAL_EVENT_NAMES[eventName] || eventName;
    const iface = new quais.Interface([
      `event ${actualEventName}(${abiFragment.join(', ')})`,
    ]);

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
      { eventName, topic0, error: (error as Error).message },
      'Error decoding event'
    );
    return null;
  }
}

export function getAllEventTopics(): string[] {
  return Object.values(EVENT_SIGNATURES);
}

export function getMultisigEventTopics(): string[] {
  return [
    EVENT_SIGNATURES.TransactionProposed,
    EVENT_SIGNATURES.TransactionApproved,
    EVENT_SIGNATURES.ApprovalRevoked,
    EVENT_SIGNATURES.TransactionExecuted,
    EVENT_SIGNATURES.TransactionCancelled,
    EVENT_SIGNATURES.OwnerAdded,
    EVENT_SIGNATURES.OwnerRemoved,
    EVENT_SIGNATURES.ThresholdChanged,
    EVENT_SIGNATURES.ModuleEnabled,
    EVENT_SIGNATURES.ModuleDisabled,
    EVENT_SIGNATURES.Received,
    // Zodiac IAvatar events
    EVENT_SIGNATURES.ExecutionFromModuleSuccess,
    EVENT_SIGNATURES.ExecutionFromModuleFailure,
  ];
}

export function getSocialRecoveryEventTopics(): string[] {
  return [
    EVENT_SIGNATURES.RecoverySetup,
    EVENT_SIGNATURES.RecoveryInitiated,
    EVENT_SIGNATURES.RecoveryApproved,
    EVENT_SIGNATURES.RecoveryApprovalRevoked,
    EVENT_SIGNATURES.RecoveryExecuted,
    EVENT_SIGNATURES.RecoveryCancelled,
  ];
}

export function getDailyLimitEventTopics(): string[] {
  return [
    EVENT_SIGNATURES.DailyLimitSet,
    EVENT_SIGNATURES.DailyLimitReset,
    EVENT_SIGNATURES.DailyLimitTransactionExecuted,
  ];
}

export function getWhitelistEventTopics(): string[] {
  return [
    EVENT_SIGNATURES.AddressWhitelisted,
    EVENT_SIGNATURES.AddressRemovedFromWhitelist,
    EVENT_SIGNATURES.WhitelistTransactionExecuted,
  ];
}

export function getModuleEventTopics(): string[] {
  return [
    ...getSocialRecoveryEventTopics(),
    ...getDailyLimitEventTopics(),
    ...getWhitelistEventTopics(),
  ];
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
  // Legacy 1-param disableModule (for decoding older transactions)
  [quais.id('disableModule(address)').slice(0, 10)]: {
    name: 'disableModule',
    abi: 'function disableModule(address module)',
    type: 'wallet_admin',
  },
  // New Zodiac 2-param disableModule
  [quais.id('disableModule(address,address)').slice(0, 10)]: {
    name: 'disableModule',
    abi: 'function disableModule(address prevModule, address module)',
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

  // Daily Limit Module Functions
  [quais.id('setDailyLimit(address,uint256)').slice(0, 10)]: {
    name: 'setDailyLimit',
    abi: 'function setDailyLimit(address wallet, uint256 limit)',
    type: 'module_config',
  },
  [quais.id('resetDailyLimit(address)').slice(0, 10)]: {
    name: 'resetDailyLimit',
    abi: 'function resetDailyLimit(address wallet)',
    type: 'module_config',
  },

  // Whitelist Module Functions
  [quais.id('addToWhitelist(address,address,uint256)').slice(0, 10)]: {
    name: 'addToWhitelist',
    abi: 'function addToWhitelist(address wallet, address addr, uint256 limit)',
    type: 'module_config',
  },
  [quais.id('removeFromWhitelist(address,address)').slice(0, 10)]: {
    name: 'removeFromWhitelist',
    abi: 'function removeFromWhitelist(address wallet, address addr)',
    type: 'module_config',
  },
  [quais.id('batchAddToWhitelist(address,address[],uint256[])').slice(0, 10)]: {
    name: 'batchAddToWhitelist',
    abi: 'function batchAddToWhitelist(address wallet, address[] addresses, uint256[] limits)',
    type: 'module_config',
  },

  // Social Recovery Module Functions
  [quais.id('setupRecovery(address,address[],uint256,uint256)').slice(0, 10)]: {
    name: 'setupRecovery',
    abi: 'function setupRecovery(address wallet, address[] guardians, uint256 threshold, uint256 recoveryPeriod)',
    type: 'recovery_setup',
  },
};

export interface DecodedCalldata {
  transactionType: TransactionType;
  decodedParams?: DecodedParams;
}

/**
 * Decode transaction calldata and determine the transaction type
 */
export function decodeCalldata(
  toAddress: string,
  data: string,
  value: string
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
      (config.contracts.dailyLimitModule?.toLowerCase() === toLower) ||
      (config.contracts.whitelistModule?.toLowerCase() === toLower) ||
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

    // If there's data but no value, it's an external contract call
    if (BigInt(value) === 0n) {
      return {
        transactionType: 'external_call',
        decodedParams: {
          function: 'unknown',
          args: { rawData: data },
        },
      };
    }

    // Has both value and data - external call with value
    return {
      transactionType: 'external_call',
      decodedParams: {
        function: 'unknown',
        args: { rawData: data },
      },
    };
  }

  // Decode the function arguments
  try {
    const iface = new quais.Interface([functionInfo.abi]);
    const decoded = iface.parseTransaction({ data, value });

    if (!decoded) {
      return {
        transactionType: functionInfo.type,
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
      transactionType: functionInfo.type,
      decodedParams: {
        function: functionInfo.name,
        args,
      },
    };
  } catch {
    return {
      transactionType: functionInfo.type,
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
      // Handle both 1-param (legacy) and 2-param (Zodiac) versions
      return args.prevModule
        ? `Disable module: ${args.module} (prev: ${args.prevModule})`
        : `Disable module: ${args.module}`;
    case 'setDailyLimit':
      return `Set daily limit to ${args.limit} for wallet ${args.wallet}`;
    case 'resetDailyLimit':
      return `Reset daily limit for wallet ${args.wallet}`;
    case 'addToWhitelist':
      return `Add ${args.addr} to whitelist with limit ${args.limit}`;
    case 'removeFromWhitelist':
      return `Remove ${args.addr} from whitelist`;
    case 'batchAddToWhitelist':
      return `Batch add ${(args.addresses as string[]).length} addresses to whitelist`;
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
      // operation: 1 byte (2 hex chars)
      const operation = parseInt(data.slice(offset, offset + 2), 16);
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
