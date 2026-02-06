/**
 * Address validation utilities.
 * Uses quais library for Quai Network address validation.
 */

import { isQuaiAddress } from 'quais';

/**
 * Validates that a string is a valid Quai address.
 * Uses the quais library's isQuaiAddress function with additional checks.
 *
 * @param address - The address string to validate
 * @returns true if the address is valid, false otherwise
 */
export function isValidAddress(address: unknown): address is string {
  if (typeof address !== 'string') {
    return false;
  }

  // Additional validation: must be 42 chars (0x + 40 hex chars)
  if (address.length !== 42 || !address.startsWith('0x')) {
    return false;
  }

  return isQuaiAddress(address);
}

/**
 * Validates and normalizes an address to lowercase.
 * Throws an error if the address is invalid.
 *
 * @param address - The address string to validate and normalize
 * @param fieldName - Name of the field for error messages (e.g., "walletAddress", "ownerAddress")
 * @returns The lowercase address
 * @throws Error if the address is invalid
 */
export function validateAndNormalizeAddress(address: unknown, fieldName: string): string {
  if (!isValidAddress(address)) {
    throw new Error(
      `Invalid ${fieldName}: expected valid Quai address, got "${String(address)}"`
    );
  }
  return address.toLowerCase();
}

/**
 * Validates a bytes32 hash (transaction hash, recovery hash, etc.)
 *
 * Checks:
 * - Not null/undefined/empty
 * - Starts with 0x
 * - Contains exactly 64 hex characters after 0x
 * - Total length is 66 characters
 *
 * @param hash - The hash string to validate
 * @returns true if the hash is valid, false otherwise
 */
export function isValidBytes32(hash: unknown): hash is string {
  if (typeof hash !== 'string') {
    return false;
  }

  if (hash.length !== 66) {
    return false;
  }

  return /^0x[0-9a-fA-F]{64}$/.test(hash);
}

/**
 * Validates and returns a bytes32 hash.
 * Throws an error if the hash is invalid.
 *
 * @param hash - The hash string to validate
 * @param fieldName - Name of the field for error messages (e.g., "txHash", "recoveryHash")
 * @returns The validated hash (unchanged)
 * @throws Error if the hash is invalid
 */
export function validateBytes32(hash: unknown, fieldName: string): string {
  if (!isValidBytes32(hash)) {
    throw new Error(
      `Invalid ${fieldName}: expected 0x-prefixed 64-character hex string, got "${String(hash)}"`
    );
  }
  return hash.toLowerCase();  // Normalize to lowercase for consistency
}

// ============================================
// RPC Response Validation
// ============================================

/**
 * Validates a hex string (with 0x prefix)
 */
export function isValidHexString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^0x[0-9a-fA-F]*$/.test(value);
}

/**
 * Validates a JSON-RPC 2.0 response structure
 */
export interface RpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Validates base JSON-RPC response structure
 */
export function validateRpcResponse(json: unknown): asserts json is RpcResponse {
  if (typeof json !== 'object' || json === null) {
    throw new Error('RPC response is not an object');
  }

  const response = json as Record<string, unknown>;

  if (response.jsonrpc !== '2.0') {
    throw new Error(`Invalid RPC response: expected jsonrpc "2.0", got "${response.jsonrpc}"`);
  }

  if (response.id === undefined) {
    throw new Error('Invalid RPC response: missing id field');
  }

  // Check for RPC error
  if (response.error !== undefined) {
    const error = response.error as Record<string, unknown>;
    const message = typeof error.message === 'string' ? error.message : JSON.stringify(error);
    throw new Error(`RPC error: ${message}`);
  }
}

/**
 * Validates quai_blockNumber response
 */
export function validateBlockNumberResponse(json: unknown): number {
  validateRpcResponse(json);

  const result = (json as RpcResponse).result;

  if (!isValidHexString(result)) {
    throw new Error(`Invalid block number response: expected hex string, got ${typeof result}`);
  }

  const blockNumber = parseInt(result, 16);

  if (!Number.isFinite(blockNumber) || blockNumber < 0) {
    throw new Error(`Invalid block number: ${result} parsed to ${blockNumber}`);
  }

  return blockNumber;
}

/**
 * Validates a single log entry from quai_getLogs
 */
export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  logIndex: string;
  removed: boolean;
}

function validateLogEntry(log: unknown, index: number): RpcLog {
  if (typeof log !== 'object' || log === null) {
    throw new Error(`Invalid log entry at index ${index}: not an object`);
  }

  const entry = log as Record<string, unknown>;

  // Validate required fields
  if (!isValidHexString(entry.address) || (entry.address as string).length !== 42) {
    throw new Error(`Invalid log entry at index ${index}: invalid address`);
  }

  if (!Array.isArray(entry.topics)) {
    throw new Error(`Invalid log entry at index ${index}: topics is not an array`);
  }

  for (let i = 0; i < entry.topics.length; i++) {
    if (!isValidHexString(entry.topics[i])) {
      throw new Error(`Invalid log entry at index ${index}: invalid topic at ${i}`);
    }
  }

  if (!isValidHexString(entry.data)) {
    throw new Error(`Invalid log entry at index ${index}: invalid data`);
  }

  if (!isValidHexString(entry.blockNumber)) {
    throw new Error(`Invalid log entry at index ${index}: invalid blockNumber`);
  }

  if (!isValidHexString(entry.transactionHash)) {
    throw new Error(`Invalid log entry at index ${index}: invalid transactionHash`);
  }

  if (!isValidHexString(entry.transactionIndex)) {
    throw new Error(`Invalid log entry at index ${index}: invalid transactionIndex`);
  }

  if (!isValidHexString(entry.blockHash)) {
    throw new Error(`Invalid log entry at index ${index}: invalid blockHash`);
  }

  if (!isValidHexString(entry.logIndex)) {
    throw new Error(`Invalid log entry at index ${index}: invalid logIndex`);
  }

  if (typeof entry.removed !== 'boolean') {
    throw new Error(`Invalid log entry at index ${index}: removed is not a boolean`);
  }

  return entry as unknown as RpcLog;
}

/**
 * Validates quai_getLogs response
 */
export function validateLogsResponse(json: unknown): RpcLog[] {
  validateRpcResponse(json);

  const result = (json as RpcResponse).result;

  // Null result means no logs found
  if (result === null) {
    return [];
  }

  if (!Array.isArray(result)) {
    throw new Error(`Invalid getLogs response: expected array, got ${typeof result}`);
  }

  // Validate each log entry
  return result.map((log, index) => validateLogEntry(log, index));
}

/**
 * Validates quai_call response
 */
export function validateCallResponse(json: unknown): string {
  validateRpcResponse(json);

  const result = (json as RpcResponse).result;

  if (!isValidHexString(result)) {
    throw new Error(`Invalid call response: expected hex string, got ${typeof result}`);
  }

  return result;
}

/**
 * Validates quai_getBlockByNumber response for timestamp extraction
 */
export function validateBlockTimestampResponse(json: unknown, blockNumber: number): number {
  validateRpcResponse(json);

  const result = (json as RpcResponse).result;

  if (result === null || result === undefined) {
    throw new Error(`Block ${blockNumber} not found`);
  }

  if (typeof result !== 'object') {
    throw new Error(`Invalid block response: expected object, got ${typeof result}`);
  }

  const block = result as Record<string, unknown>;

  // Quai blocks have timestamp in woHeader (work object header) or directly on block
  let timestamp: string | undefined;

  if (block.woHeader && typeof block.woHeader === 'object') {
    const woHeader = block.woHeader as Record<string, unknown>;
    if (isValidHexString(woHeader.timestamp)) {
      timestamp = woHeader.timestamp;
    }
  }

  if (!timestamp && isValidHexString(block.timestamp)) {
    timestamp = block.timestamp as string;
  }

  if (!timestamp) {
    throw new Error(`Block ${blockNumber} missing timestamp field`);
  }

  const parsedTimestamp = parseInt(timestamp, 16);

  if (!Number.isFinite(parsedTimestamp) || parsedTimestamp < 0) {
    throw new Error(`Invalid timestamp for block ${blockNumber}: ${timestamp}`);
  }

  return parsedTimestamp;
}
