import { describe, it, expect } from 'vitest';
import {
  isValidAddress,
  validateAndNormalizeAddress,
  isValidBytes32,
  validateBytes32,
} from '../src/utils/validation.js';

describe('Address Validation', () => {
  describe('isValidAddress', () => {
    it('should return true for valid Quai addresses', () => {
      // Valid Quai address (Cyprus1 zone)
      expect(isValidAddress('0x004EDAC18Fa80b58c05bFf9B65eBB4d65A7e01d8')).toBe(true);
      expect(isValidAddress('0x004edac18fa80b58c05bff9b65ebb4d65a7e01d8')).toBe(true);
    });

    it('should return false for invalid addresses', () => {
      expect(isValidAddress('')).toBe(false);
      expect(isValidAddress(null)).toBe(false);
      expect(isValidAddress(undefined)).toBe(false);
      expect(isValidAddress(123)).toBe(false);
      expect(isValidAddress('0x')).toBe(false);
      expect(isValidAddress('not-an-address')).toBe(false);
      // Wrong length
      expect(isValidAddress('0x1234567890')).toBe(false);
    });

    it('should return false for non-string inputs', () => {
      expect(isValidAddress({})).toBe(false);
      expect(isValidAddress([])).toBe(false);
      expect(isValidAddress(() => {})).toBe(false);
    });
  });

  describe('validateAndNormalizeAddress', () => {
    it('should normalize valid addresses to lowercase', () => {
      const address = '0x004EDAC18Fa80b58c05bFf9B65eBB4d65A7e01d8';
      const result = validateAndNormalizeAddress(address, 'testAddress');
      expect(result).toBe(address.toLowerCase());
    });

    it('should throw for invalid addresses with descriptive error', () => {
      expect(() => validateAndNormalizeAddress('invalid', 'walletAddress')).toThrow(
        'Invalid walletAddress'
      );
      expect(() => validateAndNormalizeAddress(null, 'ownerAddress')).toThrow(
        'Invalid ownerAddress'
      );
    });
  });
});

describe('Bytes32 Validation', () => {
  describe('isValidBytes32', () => {
    it('should return true for valid bytes32 hashes', () => {
      const validHash =
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      expect(isValidBytes32(validHash)).toBe(true);
    });

    it('should return true for uppercase hex', () => {
      const validHash =
        '0x1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF';
      expect(isValidBytes32(validHash)).toBe(true);
    });

    it('should return false for invalid hashes', () => {
      expect(isValidBytes32('')).toBe(false);
      expect(isValidBytes32('0x')).toBe(false);
      expect(isValidBytes32('0x1234')).toBe(false);
      // 63 chars (missing one)
      expect(
        isValidBytes32('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcde')
      ).toBe(false);
      // 65 chars (one extra)
      expect(
        isValidBytes32('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdeff')
      ).toBe(false);
      // Invalid hex character
      expect(
        isValidBytes32('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdeg')
      ).toBe(false);
    });

    it('should return false for non-string inputs', () => {
      expect(isValidBytes32(null)).toBe(false);
      expect(isValidBytes32(undefined)).toBe(false);
      expect(isValidBytes32(123)).toBe(false);
      expect(isValidBytes32({})).toBe(false);
    });
  });

  describe('validateBytes32', () => {
    it('should return the hash unchanged for valid input', () => {
      const validHash =
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      expect(validateBytes32(validHash, 'txHash')).toBe(validHash);
    });

    it('should throw for invalid hashes with descriptive error', () => {
      expect(() => validateBytes32('invalid', 'txHash')).toThrow('Invalid txHash');
      expect(() => validateBytes32('0x1234', 'recoveryHash')).toThrow(
        'Invalid recoveryHash'
      );
    });
  });
});
