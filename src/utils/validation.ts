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

/**
 * Validates and normalizes a token transfer participant address.
 * Unlike validateAndNormalizeAddress, this does NOT call isQuaiAddress()
 * because ERC20 mint/burn events use the zero address (0x0000...0000)
 * and other non-Quai addresses (e.g., 0xdead...) can appear as Transfer participants.
 *
 * Validates: 0x-prefixed, 40 hex characters, total length 42.
 */
/** Max hex data length stored in TEXT columns (128 KB of hex = 64 KB binary). */
export const MAX_HEX_DATA_LENGTH = 131_072;

/**
 * Validates a hex data string does not exceed the maximum allowed length.
 * Returns null for null/undefined/non-string values (optional fields).
 * Throws if the string exceeds maxLength.
 */
export function validateHexData(
  data: unknown,
  fieldName: string,
  maxLength = MAX_HEX_DATA_LENGTH
): string | null {
  if (data === null || data === undefined) return null;
  if (typeof data !== 'string') return null;
  if (data.length > maxLength) {
    throw new Error(`${fieldName} exceeds max length (${data.length} > ${maxLength})`);
  }
  return data;
}

export function normalizeTokenParticipant(address: unknown, fieldName: string): string {
  if (typeof address !== 'string') {
    throw new Error(
      `Invalid ${fieldName}: expected string, got ${typeof address}`
    );
  }
  if (address.length !== 42 || !address.startsWith('0x')) {
    throw new Error(
      `Invalid ${fieldName}: expected 0x-prefixed 40-character hex string, got "${address}"`
    );
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(
      `Invalid ${fieldName}: contains non-hex characters, got "${address}"`
    );
  }
  return address.toLowerCase();
}
