import { describe, it, expect } from 'vitest';
import { quais } from 'quais';
import {
  getERC1155TransferTopics,
  decodeCalldata,
  getTransactionDescription,
  EVENT_SIGNATURES,
} from '../src/services/decoder.js';

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

describe('ERC1155 decoder support', () => {
  it('getERC1155TransferTopics returns TransferSingle and TransferBatch hashes', () => {
    const topics = getERC1155TransferTopics();
    expect(topics).toHaveLength(2);
    expect(topics[0]).toBe(EVENT_SIGNATURES.TransferSingle);
    expect(topics[1]).toBe(EVENT_SIGNATURES.TransferBatch);
    // Verify they are valid keccak256 hashes (66 chars: 0x + 64 hex)
    for (const t of topics) {
      expect(t).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it('EVENT_SIGNATURES.TransferSingle matches expected keccak hash', () => {
    const expected = quais.id('TransferSingle(address,address,address,uint256,uint256)');
    expect(EVENT_SIGNATURES.TransferSingle).toBe(expected);
  });

  it('EVENT_SIGNATURES.TransferBatch matches expected keccak hash', () => {
    const expected = quais.id('TransferBatch(address,address,address,uint256[],uint256[])');
    expect(EVENT_SIGNATURES.TransferBatch).toBe(expected);
  });

  it('decodeCalldata identifies ERC1155 safeTransferFrom as erc1155_transfer', () => {
    // Encode: safeTransferFrom(address,address,uint256,uint256,bytes)
    const iface = new quais.Interface([
      'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
    ]);
    const calldata = iface.encodeFunctionData('safeTransferFrom', [
      '0x1234567890abcdef1234567890abcdef12345678',
      '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      42n,
      100n,
      '0x',
    ]);

    const result = decodeCalldata(
      '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      calldata,
      '0'
    );
    expect(result.transactionType).toBe('erc1155_transfer');
  });

  it('decodeCalldata identifies safeBatchTransferFrom as erc1155_transfer', () => {
    const iface = new quais.Interface([
      'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)',
    ]);
    const calldata = iface.encodeFunctionData('safeBatchTransferFrom', [
      '0x1234567890abcdef1234567890abcdef12345678',
      '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      [1n, 2n, 3n],
      [10n, 20n, 30n],
      '0x',
    ]);

    const result = decodeCalldata(
      '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      calldata,
      '0'
    );
    expect(result.transactionType).toBe('erc1155_transfer');
  });
});

describe('ERC20/ERC721 shared selector disambiguation', () => {
  const FROM = '0x1234567890abcdef1234567890abcdef12345678';
  const TO = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const TOKEN_CONTRACT = '0x003f87efd6b0ced7aa0549662b1559b3fe861fde';

  function encodeTransferFrom(): string {
    const iface = new quais.Interface([
      'function transferFrom(address from, address to, uint256 amount)',
    ]);
    return iface.encodeFunctionData('transferFrom', [FROM, TO, 42n]);
  }

  function encodeApprove(): string {
    const iface = new quais.Interface([
      'function approve(address spender, uint256 amount)',
    ]);
    return iface.encodeFunctionData('approve', [TO, 1000n]);
  }

  it('transferFrom defaults to erc20_transfer without token standard hint', () => {
    const result = decodeCalldata(TOKEN_CONTRACT, encodeTransferFrom(), '0');
    expect(result.transactionType).toBe('erc20_transfer');
    expect(result.decodedParams?.function).toBe('transferFrom');
  });

  it('transferFrom reclassifies to erc721_transfer when tokenStandard is ERC721', () => {
    const result = decodeCalldata(TOKEN_CONTRACT, encodeTransferFrom(), '0', 'ERC721');
    expect(result.transactionType).toBe('erc721_transfer');
    expect(result.decodedParams?.function).toBe('transferFrom');
  });

  it('transferFrom stays erc20_transfer when tokenStandard is ERC20', () => {
    const result = decodeCalldata(TOKEN_CONTRACT, encodeTransferFrom(), '0', 'ERC20');
    expect(result.transactionType).toBe('erc20_transfer');
  });

  it('approve defaults to erc20_transfer without token standard hint', () => {
    const result = decodeCalldata(TOKEN_CONTRACT, encodeApprove(), '0');
    expect(result.transactionType).toBe('erc20_transfer');
  });

  it('approve reclassifies to erc721_transfer when tokenStandard is ERC721', () => {
    const result = decodeCalldata(TOKEN_CONTRACT, encodeApprove(), '0', 'ERC721');
    expect(result.transactionType).toBe('erc721_transfer');
    expect(result.decodedParams?.function).toBe('approve');
  });

  it('description says ERC721 transferFrom with token # for ERC721', () => {
    const result = decodeCalldata(TOKEN_CONTRACT, encodeTransferFrom(), '0', 'ERC721');
    const desc = getTransactionDescription(result);
    expect(desc).toContain('ERC721 transferFrom');
    expect(desc).toContain('token #42');
  });

  it('description says ERC20 transferFrom with amount for ERC20', () => {
    const result = decodeCalldata(TOKEN_CONTRACT, encodeTransferFrom(), '0');
    const desc = getTransactionDescription(result);
    expect(desc).toContain('ERC20 transferFrom');
    expect(desc).toContain('42');
  });

  it('description says ERC721 approve with token # for ERC721', () => {
    const result = decodeCalldata(TOKEN_CONTRACT, encodeApprove(), '0', 'ERC721');
    const desc = getTransactionDescription(result);
    expect(desc).toContain('ERC721 approve');
    expect(desc).toContain('token #1000');
  });

  it('ERC1155 token standard does not affect transferFrom classification', () => {
    const result = decodeCalldata(TOKEN_CONTRACT, encodeTransferFrom(), '0', 'ERC1155');
    expect(result.transactionType).toBe('erc20_transfer');
  });

  it('safeTransferFrom (3-arg) stays erc721_transfer regardless of hint', () => {
    const iface = new quais.Interface([
      'function safeTransferFrom(address from, address to, uint256 tokenId)',
    ]);
    const calldata = iface.encodeFunctionData('safeTransferFrom', [FROM, TO, 99n]);
    const result = decodeCalldata(TOKEN_CONTRACT, calldata, '0');
    expect(result.transactionType).toBe('erc721_transfer');
  });
});

describe('delegatecall target calldata decoding', () => {
  const WALLET = '0x' + 'aa'.repeat(20);
  const TARGET = '0x' + 'bb'.repeat(20);

  it('decodes addDelegatecallTarget as wallet_admin', () => {
    const iface = new quais.Interface(['function addDelegatecallTarget(address target)']);
    const calldata = iface.encodeFunctionData('addDelegatecallTarget', [TARGET]);
    const result = decodeCalldata(WALLET, calldata, '0');
    expect(result.transactionType).toBe('wallet_admin');
    expect(result.decodedParams?.function).toBe('addDelegatecallTarget');
    expect(result.decodedParams?.args.target?.toString().toLowerCase()).toBe(TARGET.toLowerCase());
  });

  it('decodes removeDelegatecallTarget as wallet_admin', () => {
    const iface = new quais.Interface(['function removeDelegatecallTarget(address target)']);
    const calldata = iface.encodeFunctionData('removeDelegatecallTarget', [TARGET]);
    const result = decodeCalldata(WALLET, calldata, '0');
    expect(result.transactionType).toBe('wallet_admin');
    expect(result.decodedParams?.function).toBe('removeDelegatecallTarget');
    expect(result.decodedParams?.args.target?.toString().toLowerCase()).toBe(TARGET.toLowerCase());
  });

  it('generates correct description for adding target', () => {
    const iface = new quais.Interface(['function addDelegatecallTarget(address target)']);
    const calldata = iface.encodeFunctionData('addDelegatecallTarget', [TARGET]);
    const result = decodeCalldata(WALLET, calldata, '0');
    const description = getTransactionDescription(result);
    expect(description.toLowerCase()).toContain('add delegatecall target:');
  });

  it('generates correct description for removing target', () => {
    const iface = new quais.Interface(['function removeDelegatecallTarget(address target)']);
    const calldata = iface.encodeFunctionData('removeDelegatecallTarget', [TARGET]);
    const result = decodeCalldata(WALLET, calldata, '0');
    const description = getTransactionDescription(result);
    expect(description.toLowerCase()).toContain('remove delegatecall target:');
  });
});
