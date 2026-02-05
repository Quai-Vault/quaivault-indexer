import { describe, it, expect } from 'vitest';

/**
 * Helper to decode address array from ABI-encoded response
 * This is a copy of the function from events/index.ts for testing
 */
function decodeAddressArray(hexData: string): string[] {
  // Validate input
  if (!hexData || typeof hexData !== 'string') {
    throw new Error('Invalid ABI-encoded address array: data is null or not a string');
  }

  if (!hexData.startsWith('0x')) {
    throw new Error('Invalid ABI-encoded address array: missing 0x prefix');
  }

  // Minimum length: 0x (2) + offset (64) + length (64) = 130 chars
  if (hexData.length < 130) {
    throw new Error(
      `Invalid ABI-encoded address array: data too short (${hexData.length} chars, need at least 130)`
    );
  }

  // Skip 0x prefix and first 64 chars (offset to array data)
  const data = hexData.slice(2);
  // Get array length (next 64 chars = 32 bytes)
  const lengthHex = data.slice(64, 128);
  const length = parseInt(lengthHex, 16);

  // Sanity check on length
  if (isNaN(length) || length < 0 || length > 1000) {
    throw new Error(`Invalid ABI-encoded address array: unreasonable length ${length}`);
  }

  // Handle empty array case
  if (length === 0) {
    return [];
  }

  // Validate we have enough data for all addresses
  const expectedLength = 128 + length * 64;
  if (data.length < expectedLength) {
    throw new Error(
      `Invalid ABI-encoded address array: expected ${expectedLength} chars for ${length} addresses, got ${data.length}`
    );
  }

  const addresses: string[] = [];
  for (let i = 0; i < length; i++) {
    // Each address is 32 bytes (64 chars), right-padded
    const start = 128 + i * 64;
    const addressHex = data.slice(start, start + 64);
    // Take last 40 chars (20 bytes) as the address
    const address = '0x' + addressHex.slice(-40);
    addresses.push(address);
  }
  return addresses;
}

describe('decodeAddressArray', () => {
  it('should decode a single address array', () => {
    // ABI-encoded array with one address: [0x1234...5678]
    // offset (32 bytes) + length (32 bytes) + address (32 bytes)
    const encoded =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' + // offset to array data
      '0000000000000000000000000000000000000000000000000000000000000001' + // length = 1
      '000000000000000000000000123456789012345678901234567890abcdef1234'; // address

    const result = decodeAddressArray(encoded);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('0x123456789012345678901234567890abcdef1234');
  });

  it('should decode multiple addresses', () => {
    // ABI-encoded array with three addresses
    const encoded =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' + // offset
      '0000000000000000000000000000000000000000000000000000000000000003' + // length = 3
      '000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' + // address 1
      '000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' + // address 2
      '000000000000000000000000cccccccccccccccccccccccccccccccccccccccc'; // address 3

    const result = decodeAddressArray(encoded);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(result[1]).toBe('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(result[2]).toBe('0xcccccccccccccccccccccccccccccccccccccccc');
  });

  it('should handle empty array', () => {
    // ABI-encoded empty array
    const encoded =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' + // offset
      '0000000000000000000000000000000000000000000000000000000000000000'; // length = 0

    const result = decodeAddressArray(encoded);
    expect(result).toHaveLength(0);
    expect(result).toEqual([]);
  });

  it('should throw for null input', () => {
    expect(() => decodeAddressArray(null as unknown as string)).toThrow(
      'data is null or not a string'
    );
  });

  it('should throw for undefined input', () => {
    expect(() => decodeAddressArray(undefined as unknown as string)).toThrow(
      'data is null or not a string'
    );
  });

  it('should throw for non-string input', () => {
    expect(() => decodeAddressArray(123 as unknown as string)).toThrow(
      'data is null or not a string'
    );
  });

  it('should throw for missing 0x prefix', () => {
    expect(() => decodeAddressArray('1234567890')).toThrow('missing 0x prefix');
  });

  it('should throw for data too short', () => {
    expect(() => decodeAddressArray('0x1234')).toThrow('data too short');
  });

  it('should throw for unreasonable length', () => {
    // Length field = 0xFFFF (65535, over 1000 limit)
    const encoded =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '000000000000000000000000000000000000000000000000000000000000ffff';

    expect(() => decodeAddressArray(encoded)).toThrow('unreasonable length');
  });

  it('should throw when data is truncated', () => {
    // Claims to have 2 addresses but only provides data for 1
    const encoded =
      '0x' +
      '0000000000000000000000000000000000000000000000000000000000000020' + // offset
      '0000000000000000000000000000000000000000000000000000000000000002' + // length = 2
      '000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // only 1 address

    expect(() => decodeAddressArray(encoded)).toThrow('expected');
  });
});
