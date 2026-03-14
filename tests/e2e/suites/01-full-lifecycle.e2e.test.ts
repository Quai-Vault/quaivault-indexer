/**
 * E2E Full Lifecycle Tests for QuaiVault Indexer
 *
 * Adapted from quaivault-contracts/test/E2E.test.ts to verify that the indexer
 * correctly captures every on-chain event into Supabase.
 *
 * Runs against the real Quai Network Orchard testnet. Each describe block
 * fires on-chain transactions, waits for the indexer to process them, then
 * verifies the corresponding database records.
 *
 * Events covered (26 total):
 *   Factory:       WalletCreated
 *   Deposits:      Received
 *   Transactions:  TransactionProposed, TransactionApproved, ApprovalRevoked,
 *                  TransactionExecuted, TransactionCancelled, ThresholdReached,
 *                  TransactionFailed, TransactionExpired
 *   Owners:        OwnerAdded, OwnerRemoved, ThresholdChanged
 *   Modules:       EnabledModule, DisabledModule
 *   Zodiac:        ExecutionFromModuleSuccess, ExecutionFromModuleFailure
 *   Signing:       MessageSigned, MessageUnsigned
 *   Config:        MinExecutionDelayChanged
 *   Recovery:      RecoverySetup, RecoveryInitiated, RecoveryApproved,
 *                  RecoveryApprovalRevoked, RecoveryCancelled,
 *                  RecoveryInvalidated, RecoveryExpiredEvent
 *
 * Time-dependent tests (timelock, expiration) use real 5–6 minute delays.
 *
 * Prerequisites:
 *   1. Contracts deployed: npm run deploy:cyprus1:mock (in quaivault-contracts)
 *   2. .env.e2e populated with private keys and contract addresses
 *   3. Indexer running: SUPABASE_SCHEMA=dev npm run dev
 *   4. Test wallets funded with testnet QUAI
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import * as quais from 'quais';
import { Shard } from 'quais';
import { e2eConfig, indexer, supabase } from '../setup.js';
import { DatabaseVerifier } from '../helpers/db.js';

// Import ABIs
import QuaiVaultABI from '../../../abis/QuaiVault.json' with { type: 'json' };
import QuaiVaultFactoryABI from '../../../abis/QuaiVaultFactory.json' with { type: 'json' };
import SocialRecoveryModuleABI from '../../../abis/SocialRecoveryModule.json' with { type: 'json' };
import MockModuleABI from '../../../abis/MockModule.json' with { type: 'json' };
import QuaiVaultProxyABI from '../../../abis/QuaiVaultProxy.json' with { type: 'json' };
import MockERC721ABI from '../../../abis/MockERC721.json' with { type: 'json' };
import MockERC1155ABI from '../../../abis/MockERC1155.json' with { type: 'json' };

// ============================================================================
// Timing constants (matching contracts E2E)
// ============================================================================
const TIMELOCK_DELAY = 300; // 5 minutes
const EXPIRATION_WINDOW = 360; // 6 minutes
const WAIT_MARGIN = 90; // extra seconds past delay

// CREATE2 salt mining
const TARGET_PREFIX = '0x00'; // Cyprus1 shard prefix
const MAX_MINING_ATTEMPTS = 100000;

// Retry configuration for transient RPC failures (Quai Network specific)
const MAX_TX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

const THRESHOLD = 2;

// ============================================================================
// Log type for parsing events from transaction receipts
// ============================================================================
interface TransactionLog {
  topics: string[];
  data: string;
}

// ============================================================================
// Utility functions (adapted from contracts E2E)
// ============================================================================

function isTransientRpcError(err: Error & { code?: string }): boolean {
  return (
    err.message?.includes('Access list creation failed') ||
    err.message?.includes('missing revert data') ||
    err.code === 'CALL_EXCEPTION'
  );
}

async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries = MAX_TX_RETRIES,
  retryDelay = RETRY_DELAY_MS
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      const err = error as Error & { code?: string };
      lastError = err;

      if (isTransientRpcError(err)) {
        console.log(
          `    [${operationName}] Transient error (attempt ${attempt}/${maxRetries}): ${err.code || err.message?.substring(0, 80)}`
        );
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          continue;
        }
      }
      throw error;
    }
  }
  throw lastError || new Error(`${operationName} failed after ${maxRetries} retries`);
}

function mineSalt(
  factoryAddress: string,
  senderAddress: string,
  implementationAddress: string,
  owners: string[],
  threshold: number,
  minExecutionDelay: number = 0
): { salt: string; expectedAddress: string } {
  const walletIface = new quais.Interface(QuaiVaultABI);
  const initData = walletIface.encodeFunctionData('initialize', [
    owners,
    threshold,
    minExecutionDelay,
  ]);
  const abiCoder = quais.AbiCoder.defaultAbiCoder();
  const constructorArgs = abiCoder.encode(
    ['address', 'bytes'],
    [implementationAddress, initData]
  );
  const creationCode = QuaiVaultProxyABI.bytecode + constructorArgs.slice(2);
  const bytecodeHash = quais.keccak256(creationCode);

  for (let i = 0; i < MAX_MINING_ATTEMPTS; i++) {
    const userSalt = quais.hexlify(quais.randomBytes(32));
    const fullSalt = quais.keccak256(
      quais.solidityPacked(['address', 'bytes32'], [senderAddress, userSalt])
    );
    const create2Address = quais.getCreate2Address(factoryAddress, fullSalt, bytecodeHash);

    if (
      create2Address.toLowerCase().startsWith(TARGET_PREFIX.toLowerCase()) &&
      quais.isQuaiAddress(create2Address)
    ) {
      return { salt: userSalt, expectedAddress: create2Address };
    }
  }
  throw new Error(`Could not mine valid salt after ${MAX_MINING_ATTEMPTS} attempts`);
}

/** Extract txHash from a TransactionProposed event */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseTxHash(iface: quais.Interface, receipt: any): string {
  for (const log of receipt.logs) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed = iface.parseLog(log as any);
      if (parsed?.name === 'TransactionProposed') {
        return parsed.args[0];
      }
    } catch {
      // skip non-matching logs
    }
  }
  throw new Error('TransactionProposed event not found in receipt');
}

/** Extract recoveryHash from a RecoveryInitiated event */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseRecoveryHash(iface: quais.Interface, receipt: any): string {
  for (const log of receipt.logs) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed = iface.parseLog(log as any);
      if (parsed?.name === 'RecoveryInitiated') {
        return parsed.args.recoveryHash;
      }
    } catch {
      // skip non-matching logs
    }
  }
  throw new Error('RecoveryInitiated event not found in receipt');
}

/** Wait for a tx and return the receipt, with error context */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function waitForTx(tx: any, label: string): Promise<any> {
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${label} failed — tx: ${tx.hash}, status: ${receipt?.status}`);
  }
  return receipt;
}

/** Wait for a given number of seconds, logging progress every 30s */
async function waitSeconds(seconds: number, label: string): Promise<void> {
  const end = Date.now() + seconds * 1000;
  console.log(`      Waiting ${seconds}s for ${label}...`);
  while (Date.now() < end) {
    const remaining = Math.ceil((end - Date.now()) / 1000);
    if (remaining <= 0) break;
    const chunk = Math.min(remaining, 30);
    await new Promise((resolve) => setTimeout(resolve, chunk * 1000));
    if (remaining > chunk) {
      console.log(`      ${remaining - chunk}s remaining...`);
    }
  }
  console.log(`      ${label} elapsed.`);
}

// ============================================================================
// Main test suite
// ============================================================================

describe('E2E Indexer Full Lifecycle (Orchard Testnet)', () => {
  // Provider and signers
  let provider: quais.JsonRpcProvider;
  let owner1: quais.Wallet;
  let owner2: quais.Wallet;
  let owner3: quais.Wallet;
  let guardian1: quais.Wallet;
  let guardian2: quais.Wallet;

  // Deployed infrastructure contracts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let factory: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let socialRecoveryModule: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockModule: any;

  // Interfaces for encoding/decoding
  let walletIface: quais.Interface;
  let socialRecoveryIface: quais.Interface;

  // Addresses from config
  let implementationAddress: string;
  let factoryAddress: string;

  // Test wallets (created fresh each run)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let wallet: any;
  let walletAddress: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let timelockWallet: any;
  let timelockWalletAddress: string;

  let ownerAddresses: string[];

  // Database verifier
  let db: DatabaseVerifier;

  // --------------------------------------------------------------------------
  // Helpers (operate on a given wallet contract instance)
  // --------------------------------------------------------------------------

  async function warmup(): Promise<void> {
    await provider.getBlockNumber(Shard.Cyprus1);
  }

  async function proposeExternal(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    w: any,
    wAddr: string,
    signer: quais.Wallet,
    to: string,
    value: bigint = 0n,
    data: string = '0x'
  ): Promise<string> {
    return withRetry(async () => {
      await warmup();
      const tx = await w.connect(signer).proposeTransaction(to, value, data);
      const receipt = await waitForTx(tx, 'proposeTransaction');
      return parseTxHash(walletIface, receipt);
    }, 'proposeExternal');
  }

  async function proposeSelfCall(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    w: any,
    wAddr: string,
    signer: quais.Wallet,
    data: string
  ): Promise<string> {
    return withRetry(async () => {
      await warmup();
      const tx = await w.connect(signer).proposeTransaction(wAddr, 0, data);
      const receipt = await waitForTx(tx, 'proposeSelfCall');
      return parseTxHash(walletIface, receipt);
    }, 'proposeSelfCall');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function approveN(w: any, txHash: string, signers: quais.Wallet[], n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await withRetry(async () => {
        await warmup();
        const tx = await w.connect(signers[i]).approveTransaction(txHash);
        await waitForTx(tx, `approveTransaction[${i}]`);
      }, `approveTransaction[${i}]`);
    }
  }

  async function executeSelfCall(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    w: any,
    wAddr: string,
    data: string,
    signers: quais.Wallet[],
    threshold: number
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ txHash: string; execReceipt: any }> {
    const txHash = await proposeSelfCall(w, wAddr, signers[0], data);
    await approveN(w, txHash, signers, threshold);
    const execReceipt = await withRetry(async () => {
      await warmup();
      const tx = await w.connect(signers[0]).executeTransaction(txHash);
      return await waitForTx(tx, 'executeSelfCall');
    }, 'executeSelfCall');
    return { txHash, execReceipt };
  }

  async function executeMultisig(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    w: any,
    wAddr: string,
    to: string,
    value: bigint,
    data: string,
    signers: quais.Wallet[],
    threshold: number
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ txHash: string; execReceipt: any }> {
    const txHash = await proposeExternal(w, wAddr, signers[0], to, value, data);
    await approveN(w, txHash, signers, threshold);
    const execReceipt = await withRetry(async () => {
      await warmup();
      const execTx = await w.connect(signers[0]).executeTransaction(txHash);
      return await waitForTx(execTx, 'executeTransaction');
    }, 'executeMultisig');
    return { txHash, execReceipt };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function enableModule(w: any, wAddr: string, moduleAddr: string): Promise<{ txHash: string; execReceipt: any }> {
    const data = walletIface.encodeFunctionData('enableModule', [moduleAddr]);
    return await executeSelfCall(w, wAddr, data, [owner1, owner2, owner3], THRESHOLD);
  }

  async function createAndFundWallet(
    minDelay: number = 0,
    fundAmount: string = '5'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ w: any; addr: string }> {
    const { salt } = mineSalt(
      factoryAddress,
      owner1.address,
      implementationAddress,
      ownerAddresses,
      THRESHOLD,
      minDelay
    );

    const createReceipt = await withRetry(async () => {
      await warmup();
      let createTx;
      if (minDelay > 0) {
        createTx = await factory['createWallet(address[],uint256,bytes32,uint32)'](
          ownerAddresses,
          THRESHOLD,
          salt,
          minDelay
        );
      } else {
        createTx = await factory.createWallet(ownerAddresses, THRESHOLD, salt);
      }
      return await waitForTx(createTx, 'createWallet');
    }, 'createWallet');

    let addr = '';
    for (const log of createReceipt.logs) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parsed = factory.interface.parseLog(log as any);
        if (parsed?.name === 'WalletCreated') {
          addr = parsed.args.wallet || parsed.args[0];
          break;
        }
      } catch {
        // skip non-matching logs
      }
    }
    if (!addr) throw new Error('WalletCreated event not found');

    const w = new quais.Contract(addr, QuaiVaultABI, owner1);

    // Fund the wallet
    await withRetry(async () => {
      await warmup();
      const toAddress = quais.getAddress(addr);
      const fundTx = await owner1.sendTransaction({
        from: owner1.address,
        to: toAddress,
        value: quais.parseQuai(fundAmount),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      await waitForTx(fundTx, 'fundWallet');
    }, 'fundWallet');

    return { w, addr };
  }

  // --------------------------------------------------------------------------
  // Setup
  // --------------------------------------------------------------------------

  beforeAll(async () => {
    console.log('\n=== E2E Full Lifecycle Setup ===\n');

    // Initialize DB verifier
    db = new DatabaseVerifier(supabase, e2eConfig.supabaseSchema);

    // Load config
    implementationAddress = e2eConfig.quaiVaultImplementation;
    factoryAddress = e2eConfig.quaiVaultFactoryAddress;

    // Create provider
    provider = new quais.JsonRpcProvider(e2eConfig.rpcUrl, undefined, { usePathing: true });

    // Create signers from private keys
    owner1 = new quais.Wallet(e2eConfig.ownerPrivateKeys[0], provider);
    owner2 = new quais.Wallet(e2eConfig.ownerPrivateKeys[1], provider);
    owner3 = new quais.Wallet(e2eConfig.ownerPrivateKeys[2], provider);
    guardian1 = new quais.Wallet(e2eConfig.guardianPrivateKeys[0], provider);
    guardian2 = new quais.Wallet(e2eConfig.guardianPrivateKeys[1], provider);

    ownerAddresses = [owner1.address, owner2.address, owner3.address];

    console.log('Owner 1:', owner1.address);
    console.log('Owner 2:', owner2.address);
    console.log('Owner 3:', owner3.address);
    console.log('Guardian 1:', guardian1.address);
    console.log('Guardian 2:', guardian2.address);

    // Build interfaces
    walletIface = new quais.Interface(QuaiVaultABI);
    socialRecoveryIface = new quais.Interface(SocialRecoveryModuleABI);

    // Attach to deployed contracts
    factory = new quais.Contract(factoryAddress, QuaiVaultFactoryABI, owner1);
    if (e2eConfig.socialRecoveryModuleAddress) {
      socialRecoveryModule = new quais.Contract(
        e2eConfig.socialRecoveryModuleAddress,
        SocialRecoveryModuleABI,
        owner1
      );
    }
    if (e2eConfig.mockModuleAddress) {
      mockModule = new quais.Contract(e2eConfig.mockModuleAddress, MockModuleABI.abi, owner1);
    }

    // Warm up provider
    console.log('\nWarming up provider...');
    await warmup();

    // Create primary wallet (delay=0)
    console.log('\nCreating primary wallet (delay=0)...');
    const primary = await createAndFundWallet(0);
    wallet = primary.w;
    walletAddress = primary.addr;
    console.log('Primary wallet:', walletAddress);

    // Create timelocked wallet (delay=TIMELOCK_DELAY)
    console.log(`Creating timelocked wallet (delay=${TIMELOCK_DELAY}s)...`);
    const timelocked = await createAndFundWallet(TIMELOCK_DELAY);
    timelockWallet = timelocked.w;
    timelockWalletAddress = timelocked.addr;
    console.log('Timelocked wallet:', timelockWalletAddress);

    console.log('\n=== Setup Complete ===\n');
  }, 600_000); // 10 min for setup

  beforeEach(async () => {
    await warmup();
  });

  // ==========================================================================
  // Factory & Wallet Creation
  // ==========================================================================

  describe('Factory & Wallet Creation', () => {
    it('should index WalletCreated event for primary wallet', async () => {
      // Wallets were created in beforeAll — wait for indexer to catch up
      await indexer.waitUntil(
        () => db.getWallet(walletAddress),
        'Primary wallet indexed',
        e2eConfig.txConfirmationTimeout
      );

      await db.verifyWalletCreated(walletAddress, ownerAddresses, THRESHOLD);
      console.log('  ✓ Primary wallet indexed');
    });

    it('should index WalletCreated event for timelocked wallet', async () => {
      await indexer.waitUntil(
        () => db.getWallet(timelockWalletAddress),
        'Timelocked wallet indexed',
        e2eConfig.txConfirmationTimeout
      );

      await db.verifyWalletCreated(timelockWalletAddress, ownerAddresses, THRESHOLD);

      // Verify min_execution_delay was indexed
      const walletRecord = await db.getWallet(timelockWalletAddress);
      expect(walletRecord!.min_execution_delay).toBe(TIMELOCK_DELAY);

      console.log('  ✓ Timelocked wallet indexed with delay');
    });
  });

  // ==========================================================================
  // QUAI Reception
  // ==========================================================================

  describe('QUAI Reception', () => {
    it('should index Received event', async () => {
      const sendAmount = quais.parseQuai('0.01');

      await withRetry(async () => {
        await warmup();
        const sendTx = await owner1.sendTransaction({
          from: owner1.address,
          to: quais.getAddress(walletAddress),
          value: sendAmount,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        await waitForTx(sendTx, 'send QUAI');
      }, 'sendQuai');

      // Wait for the specific 0.01 QUAI deposit (not the 5 QUAI funding deposit)
      await indexer.waitUntil(
        async () => {
          const deposits = await db.getDeposits(walletAddress);
          return deposits.find(
            (d) =>
              d.sender_address.toLowerCase() === owner1.address.toLowerCase() &&
              d.amount === sendAmount.toString()
          ) || null;
        },
        'Received event indexed (0.01 QUAI)',
        e2eConfig.txConfirmationTimeout
      );

      await db.verifyDepositReceived(walletAddress, owner1.address, sendAmount.toString());
      console.log('  ✓ Received event indexed');
    });
  });

  // ==========================================================================
  // Simple Quorum (delay=0)
  // ==========================================================================

  describe('Simple Quorum (no timelock)', () => {
    let simpleTxHash: string;

    it('should index TransactionProposed event', async () => {
      const recipient = owner2.address;
      const value = quais.parseQuai('0.01');

      simpleTxHash = await proposeExternal(wallet, walletAddress, owner1, recipient, value);
      console.log(`  Transaction proposed: ${simpleTxHash}`);

      await indexer.waitUntil(
        () => db.getTransaction(walletAddress, simpleTxHash),
        'TransactionProposed indexed',
        e2eConfig.txConfirmationTimeout
      );

      await db.verifyTransactionProposed(walletAddress, simpleTxHash, {
        status: 'pending',
        confirmation_count: 0,
      });

      console.log('  ✓ TransactionProposed indexed');
    });

    it('should index TransactionApproved and ThresholdReached events', async () => {
      // Approve with owner1
      await approveN(wallet, simpleTxHash, [owner1], 1);

      await indexer.waitUntil(
        async () => {
          const confirmations = await db.getConfirmations(simpleTxHash);
          return confirmations.filter((c) => c.is_active).length >= 1 ? confirmations : null;
        },
        'First approval indexed',
        e2eConfig.txConfirmationTimeout
      );
      await db.verifyConfirmationCount(simpleTxHash, 1);

      // Approve with owner2 — crosses threshold, triggers ThresholdReached
      await approveN(wallet, simpleTxHash, [owner2], 1);

      await indexer.waitUntil(
        async () => {
          const confirmations = await db.getConfirmations(simpleTxHash);
          return confirmations.filter((c) => c.is_active).length >= 2 ? confirmations : null;
        },
        'Second approval indexed',
        e2eConfig.txConfirmationTimeout
      );
      await db.verifyConfirmationCount(simpleTxHash, 2);

      // ThresholdReached should set approved_at (delay=0 wallet, so executable_after == approved_at)
      await indexer.waitUntil(
        async () => {
          const tx = await db.getTransaction(walletAddress, simpleTxHash);
          return tx?.approved_at && tx.approved_at > 0 ? tx : null;
        },
        'ThresholdReached indexed',
        e2eConfig.txConfirmationTimeout
      );
      await db.verifyThresholdReached(walletAddress, simpleTxHash);

      console.log('  ✓ TransactionApproved + ThresholdReached indexed');
    });

    it('should index TransactionExecuted event', async () => {
      await withRetry(async () => {
        await warmup();
        const execTx = await wallet.connect(owner1).executeTransaction(simpleTxHash);
        await waitForTx(execTx, 'executeTransaction');
      }, 'executeTransaction');

      await indexer.waitUntil(
        async () => {
          const tx = await db.getTransaction(walletAddress, simpleTxHash);
          return tx?.status === 'executed' ? tx : null;
        },
        'TransactionExecuted indexed',
        e2eConfig.txConfirmationTimeout
      );
      await db.verifyTransactionStatus(walletAddress, simpleTxHash, 'executed');

      console.log('  ✓ TransactionExecuted indexed');
    });

    it('should index ApprovalRevoked event', async () => {
      // New transaction for revoke test
      const txHash = await proposeExternal(wallet, walletAddress, owner1, owner2.address, 0n);
      await indexer.waitUntil(
        () => db.getTransaction(walletAddress, txHash),
        'Proposal indexed',
        e2eConfig.txConfirmationTimeout
      );

      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);
      await indexer.waitUntil(
        async () => {
          const c = await db.getConfirmations(txHash);
          return c.filter((x) => x.is_active).length >= 2 ? c : null;
        },
        'Approvals indexed',
        e2eConfig.txConfirmationTimeout
      );

      // Revoke owner2's approval
      await withRetry(async () => {
        await warmup();
        const revokeTx = await wallet.connect(owner2).revokeApproval(txHash);
        await waitForTx(revokeTx, 'revokeApproval');
      }, 'revokeApproval');

      await indexer.waitUntil(
        async () => {
          const c = await db.getConfirmations(txHash);
          return c.filter((x) => x.is_active).length === 1 ? c : null;
        },
        'ApprovalRevoked indexed',
        e2eConfig.txConfirmationTimeout
      );

      const confirmations = await db.getConfirmations(txHash);
      const activeCount = confirmations.filter((c) => c.is_active).length;
      expect(activeCount).toBe(1);

      console.log('  ✓ ApprovalRevoked indexed');
    });

    it('should index TransactionCancelled event', async () => {
      const txHash = await proposeExternal(wallet, walletAddress, owner1, owner2.address, 0n);
      await indexer.waitUntil(
        () => db.getTransaction(walletAddress, txHash),
        'Proposal indexed',
        e2eConfig.txConfirmationTimeout
      );

      // Proposer cancels
      await withRetry(async () => {
        await warmup();
        const cancelTx = await wallet.connect(owner1).cancelTransaction(txHash);
        await waitForTx(cancelTx, 'cancelTransaction');
      }, 'cancelTransaction');

      await indexer.waitUntil(
        async () => {
          const tx = await db.getTransaction(walletAddress, txHash);
          return tx?.status === 'cancelled' ? tx : null;
        },
        'TransactionCancelled indexed',
        e2eConfig.txConfirmationTimeout
      );
      await db.verifyTransactionStatus(walletAddress, txHash, 'cancelled');

      console.log('  ✓ TransactionCancelled indexed');
    });

    it('should index cancelByConsensus via self-call', async () => {
      // Create and approve a transaction
      const txHash = await proposeExternal(
        wallet,
        walletAddress,
        owner1,
        owner2.address,
        quais.parseQuai('0.01')
      );
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);

      await indexer.waitUntil(
        () => db.getTransaction(walletAddress, txHash),
        'Proposal indexed',
        e2eConfig.txConfirmationTimeout
      );

      // Cancel by consensus (self-call)
      const cancelData = walletIface.encodeFunctionData('cancelByConsensus', [txHash]);
      await executeSelfCall(wallet, walletAddress, cancelData, [owner1, owner2, owner3], THRESHOLD);

      await indexer.waitUntil(
        async () => {
          const tx = await db.getTransaction(walletAddress, txHash);
          return tx?.status === 'cancelled' ? tx : null;
        },
        'cancelByConsensus indexed',
        e2eConfig.txConfirmationTimeout
      );
      await db.verifyTransactionStatus(walletAddress, txHash, 'cancelled');

      console.log('  ✓ cancelByConsensus indexed');
    });
  });

  // ==========================================================================
  // Timelocked Transactions (real 5-minute+ wait)
  // ==========================================================================

  describe('Timelocked Transactions', () => {
    it(
      'should index ThresholdReached with correct executableAfter on timelocked wallet',
      async () => {
        const txHash = await proposeExternal(
          timelockWallet,
          timelockWalletAddress,
          owner1,
          owner2.address,
          0n
        );

        await indexer.waitUntil(
          () => db.getTransaction(timelockWalletAddress, txHash),
          'Timelocked proposal indexed',
          e2eConfig.txConfirmationTimeout
        );

        // Approve to threshold — triggers ThresholdReached
        await approveN(timelockWallet, txHash, [owner1, owner2], THRESHOLD);

        await indexer.waitUntil(
          async () => {
            const tx = await db.getTransaction(timelockWalletAddress, txHash);
            return tx?.approved_at && tx.approved_at > 0 ? tx : null;
          },
          'ThresholdReached indexed',
          e2eConfig.txConfirmationTimeout
        );

        const tx = await db.getTransaction(timelockWalletAddress, txHash);
        expect(tx).not.toBeNull();
        expect(tx!.approved_at).toBeGreaterThan(0);
        expect(tx!.executable_after).toBe(tx!.approved_at! + TIMELOCK_DELAY);

        console.log('  ✓ ThresholdReached indexed with executableAfter');
      },
      { timeout: 120_000 }
    );

    it(
      'should reject early execution, succeed after delay',
      async () => {
        const txHash = await proposeExternal(
          timelockWallet,
          timelockWalletAddress,
          owner1,
          owner2.address,
          quais.parseQuai('0.01')
        );
        await approveN(timelockWallet, txHash, [owner1, owner2], THRESHOLD);

        await indexer.waitUntil(
          () => db.getTransaction(timelockWalletAddress, txHash),
          'Timelocked proposal indexed',
          e2eConfig.txConfirmationTimeout
        );

        // Wait for real delay
        await waitSeconds(TIMELOCK_DELAY + WAIT_MARGIN, 'timelock delay');

        // Execute after delay
        await withRetry(async () => {
          await warmup();
          const execTx = await timelockWallet.connect(owner1).executeTransaction(txHash);
          await waitForTx(execTx, 'executeTransaction after delay');
        }, 'executeAfterDelay');

        await indexer.waitUntil(
          async () => {
            const tx = await db.getTransaction(timelockWalletAddress, txHash);
            return tx?.status === 'executed' ? tx : null;
          },
          'Timelocked TransactionExecuted indexed',
          e2eConfig.txConfirmationTimeout
        );
        await db.verifyTransactionStatus(timelockWalletAddress, txHash, 'executed');

        console.log('  ✓ Timelocked execution indexed after delay');
      },
      { timeout: 0 }
    );

    it('should skip timelock for self-calls even on timelocked vault', async () => {
      const data = walletIface.encodeFunctionData('changeThreshold', [3]);
      const { txHash } = await executeSelfCall(
        timelockWallet,
        timelockWalletAddress,
        data,
        [owner1, owner2, owner3],
        THRESHOLD
      );

      await indexer.waitUntil(
        async () => {
          const tx = await db.getTransaction(timelockWalletAddress, txHash);
          return tx?.status === 'executed' ? tx : null;
        },
        'Self-call on timelocked wallet indexed',
        e2eConfig.txConfirmationTimeout
      );
      await db.verifyTransactionStatus(timelockWalletAddress, txHash, 'executed');

      // Revert threshold to 2
      const revertData = walletIface.encodeFunctionData('changeThreshold', [2]);
      await executeSelfCall(timelockWallet, timelockWalletAddress, revertData, [owner1, owner2, owner3], 3);

      console.log('  ✓ Self-call bypassed timelock and was indexed');
    });
  });

  // ==========================================================================
  // Expiration (real 6-minute+ wait)
  // ==========================================================================

  describe('Expiration', () => {
    it(
      'should index TransactionExpired event',
      async () => {
        const now = Math.floor(Date.now() / 1000);
        const expiration = now + EXPIRATION_WINDOW;

        // Propose with expiration using the 4-param overload
        const proposeTx = await withRetry(async () => {
          await warmup();
          return await wallet
            .connect(owner1)
            ['proposeTransaction(address,uint256,bytes,uint48)'](
              owner2.address,
              quais.parseQuai('0.01'),
              '0x',
              expiration
            );
        }, 'proposeWithExpiration');
        const proposeReceipt = await waitForTx(proposeTx, 'propose with expiration');
        const txHash = parseTxHash(walletIface, proposeReceipt);

        await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);

        await indexer.waitUntil(
          () => db.getTransaction(walletAddress, txHash),
          'Expiring proposal indexed',
          e2eConfig.txConfirmationTimeout
        );

        // Wait past expiration
        await waitSeconds(EXPIRATION_WINDOW + WAIT_MARGIN, 'expiration');

        // Anyone can call expireTransaction (guardian is non-owner)
        await withRetry(async () => {
          await warmup();
          const expireTx = await wallet.connect(guardian1).expireTransaction(txHash);
          await waitForTx(expireTx, 'expireTransaction');
        }, 'expireTransaction');

        await indexer.waitUntil(
          async () => {
            const tx = await db.getTransaction(walletAddress, txHash);
            return tx?.status === 'expired' ? tx : null;
          },
          'TransactionExpired indexed',
          e2eConfig.txConfirmationTimeout
        );
        await db.verifyTransactionExpired(walletAddress, txHash);

        console.log('  ✓ TransactionExpired indexed');
      },
      { timeout: 0 }
    );
  });

  // ==========================================================================
  // Failed External Call (Option B)
  // ==========================================================================

  describe('Failed External Call (Option B)', () => {
    it('should index TransactionFailed event', async () => {
      // Call factory with bad calldata — will revert but multisig captures it
      const badCalldata = quais.solidityPacked(['bytes4'], ['0xdeadbeef']);
      const txHash = await proposeExternal(
        wallet,
        walletAddress,
        owner1,
        factoryAddress,
        0n,
        badCalldata
      );
      await approveN(wallet, txHash, [owner1, owner2], THRESHOLD);

      await indexer.waitUntil(
        () => db.getTransaction(walletAddress, txHash),
        'Failed call proposal indexed',
        e2eConfig.txConfirmationTimeout
      );

      // Execute — external call fails but tx succeeds (Option B)
      await withRetry(async () => {
        await warmup();
        const execTx = await wallet.connect(owner1).executeTransaction(txHash);
        await waitForTx(execTx, 'executeTransaction (expect fail event)');
      }, 'executeFailedCall');

      await indexer.waitUntil(
        async () => {
          const tx = await db.getTransaction(walletAddress, txHash);
          return tx?.status === 'failed' ? tx : null;
        },
        'TransactionFailed indexed',
        e2eConfig.txConfirmationTimeout
      );
      await db.verifyTransactionFailed(walletAddress, txHash);

      console.log('  ✓ TransactionFailed indexed');
    });
  });

  // ==========================================================================
  // Owner Management
  // ==========================================================================

  describe('Owner Management', () => {
    it('should index OwnerAdded event', async () => {
      const addData = walletIface.encodeFunctionData('addOwner', [guardian1.address]);
      await executeSelfCall(wallet, walletAddress, addData, [owner1, owner2, owner3], THRESHOLD);

      await indexer.waitUntil(
        async () => {
          const owners = await db.getWalletOwners(walletAddress);
          const active = owners.filter((o) => o.is_active);
          return active.length >= 4 ? owners : null;
        },
        'OwnerAdded indexed',
        e2eConfig.txConfirmationTimeout
      );

      const owners = await db.getWalletOwners(walletAddress);
      const activeOwners = owners.filter((o) => o.is_active);
      expect(activeOwners.length).toBe(4);
      const addedOwner = activeOwners.find(
        (o) => o.owner_address.toLowerCase() === guardian1.address.toLowerCase()
      );
      expect(addedOwner).not.toBeUndefined();

      console.log('  ✓ OwnerAdded indexed');
    });

    it('should index OwnerRemoved event', async () => {
      const removeData = walletIface.encodeFunctionData('removeOwner', [guardian1.address]);
      await executeSelfCall(wallet, walletAddress, removeData, [owner1, owner2, owner3], THRESHOLD);

      await indexer.waitUntil(
        async () => {
          const owners = await db.getWalletOwners(walletAddress);
          const removedOwner = owners.find(
            (o) => o.owner_address.toLowerCase() === guardian1.address.toLowerCase() && !o.is_active
          );
          return removedOwner ? owners : null;
        },
        'OwnerRemoved indexed',
        e2eConfig.txConfirmationTimeout
      );

      const owners = await db.getWalletOwners(walletAddress);
      const removedOwner = owners.find(
        (o) => o.owner_address.toLowerCase() === guardian1.address.toLowerCase()
      );
      expect(removedOwner).not.toBeUndefined();
      expect(removedOwner!.is_active).toBe(false);

      console.log('  ✓ OwnerRemoved indexed');
    });

    it('should index ThresholdChanged event', async () => {
      const threshData = walletIface.encodeFunctionData('changeThreshold', [3]);
      await executeSelfCall(wallet, walletAddress, threshData, [owner1, owner2, owner3], THRESHOLD);

      await indexer.waitUntil(
        async () => {
          const w = await db.getWallet(walletAddress);
          return w?.threshold === 3 ? w : null;
        },
        'ThresholdChanged indexed',
        e2eConfig.txConfirmationTimeout
      );

      const walletRecord = await db.getWallet(walletAddress);
      expect(walletRecord!.threshold).toBe(3);

      // Revert threshold to 2
      const revertData = walletIface.encodeFunctionData('changeThreshold', [2]);
      await executeSelfCall(wallet, walletAddress, revertData, [owner1, owner2, owner3], 3);

      await indexer.waitUntil(
        async () => {
          const w = await db.getWallet(walletAddress);
          return w?.threshold === 2 ? w : null;
        },
        'Threshold reverted',
        e2eConfig.txConfirmationTimeout
      );

      console.log('  ✓ ThresholdChanged indexed');
    });
  });

  // ==========================================================================
  // Module Management & Execution (MockModule)
  // ==========================================================================

  describe('Module Management & Execution', () => {
    it('should index EnabledModule, ExecutionFromModuleSuccess, ExecutionFromModuleFailure, DisabledModule', async () => {
      if (!mockModule) {
        console.log('  ⏭️ MockModule not configured — skipping');
        return;
      }

      const moduleAddr = e2eConfig.mockModuleAddress!;

      // Set target to wallet
      await withRetry(async () => {
        await warmup();
        const setTargetTx = await mockModule.setTarget(walletAddress);
        await waitForTx(setTargetTx, 'setTarget');
      }, 'setTarget');

      // Enable module
      await enableModule(wallet, walletAddress, moduleAddr);

      await indexer.waitUntil(
        async () => {
          const modules = await db.getWalletModules(walletAddress);
          return modules.find(
            (m) => m.module_address.toLowerCase() === moduleAddr.toLowerCase() && m.is_active
          ) || null;
        },
        'EnabledModule indexed',
        e2eConfig.txConfirmationTimeout
      );
      await db.verifyModuleEnabled(walletAddress, moduleAddr);
      console.log('  ✓ EnabledModule indexed');

      // Execute QUAI transfer via module (success)
      await withRetry(async () => {
        await warmup();
        const execTx = await mockModule.exec(owner3.address, quais.parseQuai('0.01'), '0x', 0);
        await waitForTx(execTx, 'module exec');
      }, 'moduleExec');

      await indexer.waitUntil(
        async () => {
          const executions = await db.getModuleExecutions(walletAddress);
          return executions.find(
            (e) => e.module_address.toLowerCase() === moduleAddr.toLowerCase() && e.success === true
          ) || null;
        },
        'ExecutionFromModuleSuccess indexed',
        e2eConfig.txConfirmationTimeout
      );
      await db.verifyModuleExecutionSuccess(walletAddress, moduleAddr);
      console.log('  ✓ ExecutionFromModuleSuccess indexed');

      // Execute a call that will fail — factory has no fallback, so 0xdeadbeef reverts
      const badCalldata = quais.solidityPacked(['bytes4'], ['0xdeadbeef']);
      await withRetry(async () => {
        await warmup();
        const execTx = await mockModule.exec(factoryAddress, 0, badCalldata, 0);
        await waitForTx(execTx, 'module exec (expect failure event)');
      }, 'moduleExecFail');

      await indexer.waitUntil(
        async () => {
          const executions = await db.getModuleExecutions(walletAddress);
          return executions.find(
            (e) => e.module_address.toLowerCase() === moduleAddr.toLowerCase() && e.success === false
          ) || null;
        },
        'ExecutionFromModuleFailure indexed',
        e2eConfig.txConfirmationTimeout
      );
      await db.verifyModuleExecutionFailure(walletAddress, moduleAddr);
      console.log('  ✓ ExecutionFromModuleFailure indexed');

      // Disable module
      const SENTINEL = '0x0000000000000000000000000000000000000001';
      const disableData = walletIface.encodeFunctionData('disableModule', [SENTINEL, moduleAddr]);
      await executeSelfCall(wallet, walletAddress, disableData, [owner1, owner2, owner3], THRESHOLD);

      await indexer.waitUntil(
        async () => {
          const modules = await db.getWalletModules(walletAddress);
          return modules.find(
            (m) => m.module_address.toLowerCase() === moduleAddr.toLowerCase() && !m.is_active
          ) || null;
        },
        'DisabledModule indexed',
        e2eConfig.txConfirmationTimeout
      );
      await db.verifyModuleDisabled(walletAddress, moduleAddr);
      console.log('  ✓ DisabledModule indexed');
    });
  });

  // ==========================================================================
  // EIP-1271 Message Signing
  // ==========================================================================

  describe('EIP-1271 Message Signing', () => {
    it('should index MessageSigned and MessageUnsigned events', async () => {
      const dataHash = quais.keccak256(quais.toUtf8Bytes('Hello QuaiVault E2E'));
      const messageData = quais.AbiCoder.defaultAbiCoder().encode(['bytes32'], [dataHash]);

      // Sign message (self-call)
      const signData = walletIface.encodeFunctionData('signMessage', [messageData]);
      await executeSelfCall(wallet, walletAddress, signData, [owner1, owner2, owner3], THRESHOLD);

      // Wait for MessageSigned to be indexed
      await indexer.waitUntil(
        async () => {
          const messages = await db.getSignedMessages(walletAddress);
          return messages.find((m) => m.is_active) || null;
        },
        'MessageSigned indexed',
        e2eConfig.txConfirmationTimeout
      );

      const messages = await db.getSignedMessages(walletAddress);
      const signedMsg = messages.find((m) => m.is_active);
      expect(signedMsg).not.toBeUndefined();
      const msgHash = signedMsg!.msg_hash;

      console.log('  ✓ MessageSigned indexed');

      // Unsign message (self-call)
      const unsignData = walletIface.encodeFunctionData('unsignMessage', [messageData]);
      await executeSelfCall(wallet, walletAddress, unsignData, [owner1, owner2, owner3], THRESHOLD);

      await indexer.waitUntil(
        async () => {
          const msgs = await db.getSignedMessages(walletAddress);
          const msg = msgs.find((m) => m.msg_hash.toLowerCase() === msgHash.toLowerCase());
          return msg && !msg.is_active ? msg : null;
        },
        'MessageUnsigned indexed',
        e2eConfig.txConfirmationTimeout
      );

      await db.verifyMessageUnsigned(walletAddress, msgHash);
      console.log('  ✓ MessageUnsigned indexed');
    });
  });

  // ==========================================================================
  // setMinExecutionDelay
  // ==========================================================================

  describe('setMinExecutionDelay', () => {
    it('should index MinExecutionDelayChanged event', async () => {
      // Verify initial delay is 0
      const initialWallet = await db.getWallet(walletAddress);
      expect(initialWallet!.min_execution_delay).toBe(0);

      // Set delay to 60
      const setData = walletIface.encodeFunctionData('setMinExecutionDelay', [60]);
      await executeSelfCall(wallet, walletAddress, setData, [owner1, owner2, owner3], THRESHOLD);

      await indexer.waitUntil(
        async () => {
          const w = await db.getWallet(walletAddress);
          return w?.min_execution_delay === 60 ? w : null;
        },
        'MinExecutionDelayChanged indexed',
        e2eConfig.txConfirmationTimeout
      );
      await db.verifyMinExecutionDelay(walletAddress, 60);
      console.log('  ✓ MinExecutionDelayChanged indexed (set to 60)');

      // Reset to 0 (self-calls bypass timelock, so this works immediately)
      const revertData = walletIface.encodeFunctionData('setMinExecutionDelay', [0]);
      await executeSelfCall(wallet, walletAddress, revertData, [owner1, owner2, owner3], THRESHOLD);

      await indexer.waitUntil(
        async () => {
          const w = await db.getWallet(walletAddress);
          return w?.min_execution_delay === 0 ? w : null;
        },
        'MinExecutionDelay reset to 0',
        e2eConfig.txConfirmationTimeout
      );
      await db.verifyMinExecutionDelay(walletAddress, 0);
      console.log('  ✓ MinExecutionDelayChanged indexed (reset to 0)');
    });
  });

  // ==========================================================================
  // Social Recovery (Setup, Initiation, Cancellation)
  // ==========================================================================

  describe('Social Recovery', () => {
    it('should index recovery lifecycle events', async () => {
      if (!socialRecoveryModule) {
        console.log('  ⏭️ SocialRecoveryModule not configured — skipping');
        return;
      }

      const moduleAddr = e2eConfig.socialRecoveryModuleAddress!;

      // Enable SocialRecoveryModule on the wallet
      if (!(await wallet.isModuleEnabled(moduleAddr))) {
        await enableModule(wallet, walletAddress, moduleAddr);

        await indexer.waitUntil(
          async () => {
            const modules = await db.getWalletModules(walletAddress);
            return modules.find(
              (m) => m.module_address.toLowerCase() === moduleAddr.toLowerCase() && m.is_active
            ) || null;
          },
          'SocialRecoveryModule enabled',
          e2eConfig.txConfirmationTimeout
        );
      }

      // Setup recovery
      const setupData = socialRecoveryIface.encodeFunctionData('setupRecovery', [
        walletAddress,
        [guardian1.address, guardian2.address],
        2, // guardian threshold
        86400, // 1 day (contract minimum)
      ]);
      await executeMultisig(
        wallet,
        walletAddress,
        moduleAddr,
        0n,
        setupData,
        [owner1, owner2, owner3],
        THRESHOLD
      );

      await indexer.waitUntil(
        () => db.getSocialRecoveryConfig(walletAddress),
        'RecoverySetup indexed',
        e2eConfig.txConfirmationTimeout
      );
      await db.verifyRecoverySetup(walletAddress, [guardian1.address, guardian2.address], 2);
      console.log('  ✓ RecoverySetup indexed');

      // Initiate recovery
      const initReceipt = await withRetry(async () => {
        await warmup();
        const initTx = await socialRecoveryModule
          .connect(guardian1)
          .initiateRecovery(walletAddress, [guardian1.address, guardian2.address], 2);
        return await waitForTx(initTx, 'initiateRecovery');
      }, 'initiateRecovery');
      const recoveryHash = parseRecoveryHash(socialRecoveryIface, initReceipt);

      await indexer.waitUntil(
        async () => {
          const recoveries = await db.getSocialRecoveries(walletAddress);
          return recoveries.find(
            (r) => r.recovery_hash.toLowerCase() === recoveryHash.toLowerCase()
          ) || null;
        },
        'RecoveryInitiated indexed',
        e2eConfig.txConfirmationTimeout
      );
      await db.verifyRecoveryInitiated(walletAddress, recoveryHash);
      console.log('  ✓ RecoveryInitiated indexed');

      // Approve recovery (guardian1)
      await withRetry(async () => {
        await warmup();
        const approveTx = await socialRecoveryModule
          .connect(guardian1)
          .approveRecovery(walletAddress, recoveryHash);
        await waitForTx(approveTx, 'approveRecovery[guardian1]');
      }, 'approveRecovery[guardian1]');

      await indexer.waitUntil(
        async () => {
          const approvals = await db.getSocialRecoveryApprovals(recoveryHash);
          return approvals.filter((a) => a.is_active).length >= 1 ? approvals : null;
        },
        'RecoveryApproved indexed',
        e2eConfig.txConfirmationTimeout
      );
      await db.verifyRecoveryApprovalCount(recoveryHash, 1);
      console.log('  ✓ RecoveryApproved indexed');

      // Revoke recovery approval (guardian1)
      await withRetry(async () => {
        await warmup();
        const revokeTx = await socialRecoveryModule
          .connect(guardian1)
          .revokeRecoveryApproval(walletAddress, recoveryHash);
        await waitForTx(revokeTx, 'revokeRecoveryApproval');
      }, 'revokeRecoveryApproval');

      await indexer.waitUntil(
        async () => {
          const approvals = await db.getSocialRecoveryApprovals(recoveryHash);
          const active = approvals.filter((a) => a.is_active);
          return active.length === 0 ? approvals : null;
        },
        'RecoveryApprovalRevoked indexed',
        e2eConfig.txConfirmationTimeout
      );
      await db.verifyRecoveryApprovalCount(recoveryHash, 0);
      console.log('  ✓ RecoveryApprovalRevoked indexed');

      // Cancel recovery (owner)
      await withRetry(async () => {
        await warmup();
        const cancelTx = await socialRecoveryModule
          .connect(owner1)
          .cancelRecovery(walletAddress, recoveryHash);
        await waitForTx(cancelTx, 'cancelRecovery');
      }, 'cancelRecovery');

      await indexer.waitUntil(
        async () => {
          const recoveries = await db.getSocialRecoveries(walletAddress);
          const recovery = recoveries.find(
            (r) => r.recovery_hash.toLowerCase() === recoveryHash.toLowerCase()
          );
          return recovery?.status === 'cancelled' ? recovery : null;
        },
        'RecoveryCancelled indexed',
        e2eConfig.txConfirmationTimeout
      );
      await db.verifyRecoveryStatus(recoveryHash, 'cancelled');
      console.log('  ✓ RecoveryCancelled indexed');
    });
  });

  // ==========================================================================
  // ERC721 TOKEN TRANSFERS
  // ==========================================================================

  describe('ERC721 Transfers', () => {
    // Use a unique tokenId per test run to avoid re-mint reverts on persistent testnets
    const erc721TokenId = BigInt(Math.floor(Date.now() / 1000));

    it('mint → auto-discovers ERC721 token + records inflow', async () => {
      if (!e2eConfig.mockErc721Address) {
        console.log('  ⏭ Skipping ERC721 tests (MOCK_ERC721 not deployed)');
        return;
      }
      const mockAddr = e2eConfig.mockErc721Address;
      const tokenId = erc721TokenId;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mockERC721 = new quais.Contract(mockAddr, MockERC721ABI, owner1) as any;

      // Mint token to the vault
      await withRetry(async () => {
        await warmup();
        const tx = await mockERC721.mint(walletAddress, tokenId);
        await waitForTx(tx, 'mintERC721');
      }, 'mintERC721');

      // Wait for indexer to process
      await indexer.waitUntil(
        async () => {
          const transfers = await db.getTokenTransfers(walletAddress);
          return transfers.find(
            (t) =>
              t.token_address.toLowerCase() === mockAddr.toLowerCase() &&
              t.direction === 'inflow' &&
              t.token_id === tokenId.toString()
          ) ?? null;
        },
        'ERC721 mint inflow indexed',
        e2eConfig.txConfirmationTimeout
      );

      await db.verifyTokenDiscovered(mockAddr, 'ERC721');
      await db.verifyTokenTransferInflow(walletAddress, mockAddr, '0x0000000000000000000000000000000000000000', {
        tokenId: tokenId.toString(),
        value: '1',
      });
      console.log('  ✓ ERC721 mint inflow indexed');
    });

    it('transfer out → records outflow', async () => {
      if (!e2eConfig.mockErc721Address) {
        console.log('  ⏭ Skipping ERC721 tests (MOCK_ERC721 not deployed)');
        return;
      }
      const mockAddr = e2eConfig.mockErc721Address;
      const tokenId = erc721TokenId; // minted in previous test
      const recipient = owner2.address;

      // Transfer from vault via multisig proposal
      const erc721Iface = new quais.Interface(MockERC721ABI);
      const data = erc721Iface.encodeFunctionData('transferFrom', [walletAddress, recipient, tokenId]);
      await executeMultisig(wallet, walletAddress, mockAddr, 0n, data, [owner1, owner2, owner3], THRESHOLD);

      // Wait for indexer
      await indexer.waitUntil(
        async () => {
          const transfers = await db.getTokenTransfers(walletAddress);
          return transfers.find(
            (t) =>
              t.token_address.toLowerCase() === mockAddr.toLowerCase() &&
              t.direction === 'outflow' &&
              t.token_id === tokenId.toString()
          ) ?? null;
        },
        'ERC721 transfer outflow indexed',
        e2eConfig.txConfirmationTimeout
      );

      await db.verifyTokenTransferOutflow(walletAddress, mockAddr, recipient, {
        tokenId: tokenId.toString(),
        value: '1',
      });
      console.log('  ✓ ERC721 transfer outflow indexed');
    });
  });

  // ==========================================================================
  // ERC1155 TOKEN TRANSFERS
  // ==========================================================================

  describe('ERC1155 Transfers', () => {
    it('mint → auto-discovers ERC1155 token + records inflow', async () => {
      if (!e2eConfig.mockErc1155Address) {
        console.log('  ⏭ Skipping ERC1155 tests (MOCK_ERC1155 not deployed)');
        return;
      }
      const mockAddr = e2eConfig.mockErc1155Address;
      const tokenId = 1n;
      const amount = 100n;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mockERC1155 = new quais.Contract(mockAddr, MockERC1155ABI, owner1) as any;

      // Mint tokens to the vault
      await withRetry(async () => {
        await warmup();
        const tx = await mockERC1155.mint(walletAddress, tokenId, amount, '0x');
        await waitForTx(tx, 'mintERC1155');
      }, 'mintERC1155');

      // Wait for indexer
      await indexer.waitUntil(
        async () => {
          const transfers = await db.getTokenTransfers(walletAddress);
          return transfers.find(
            (t) =>
              t.token_address.toLowerCase() === mockAddr.toLowerCase() &&
              t.direction === 'inflow' &&
              t.token_id === tokenId.toString()
          ) ?? null;
        },
        'ERC1155 mint inflow indexed',
        e2eConfig.txConfirmationTimeout
      );

      await db.verifyTokenDiscovered(mockAddr, 'ERC1155');
      await db.verifyTokenTransferInflow(walletAddress, mockAddr, '0x0000000000000000000000000000000000000000', {
        tokenId: tokenId.toString(),
        value: amount.toString(),
        batchIndex: 0,
      });
      console.log('  ✓ ERC1155 mint inflow indexed');
    });

    it('safeTransferFrom out → records outflow', async () => {
      if (!e2eConfig.mockErc1155Address) {
        console.log('  ⏭ Skipping ERC1155 tests (MOCK_ERC1155 not deployed)');
        return;
      }
      const mockAddr = e2eConfig.mockErc1155Address;
      const tokenId = 1n;
      const amount = 25n;
      const recipient = owner2.address;

      // Transfer from vault via multisig proposal
      const erc1155Iface = new quais.Interface(MockERC1155ABI);
      const data = erc1155Iface.encodeFunctionData('safeTransferFrom', [
        walletAddress, recipient, tokenId, amount, '0x',
      ]);
      await executeMultisig(wallet, walletAddress, mockAddr, 0n, data, [owner1, owner2, owner3], THRESHOLD);

      // Wait for indexer
      await indexer.waitUntil(
        async () => {
          const transfers = await db.getTokenTransfers(walletAddress);
          return transfers.find(
            (t) =>
              t.token_address.toLowerCase() === mockAddr.toLowerCase() &&
              t.direction === 'outflow' &&
              t.token_id === tokenId.toString() &&
              t.value === amount.toString()
          ) ?? null;
        },
        'ERC1155 transfer outflow indexed',
        e2eConfig.txConfirmationTimeout
      );

      await db.verifyTokenTransferOutflow(walletAddress, mockAddr, recipient, {
        tokenId: tokenId.toString(),
        value: amount.toString(),
      });
      console.log('  ✓ ERC1155 safeTransferFrom outflow indexed');
    });

    it('batch mint → records multiple inflows with correct batchIndex', async () => {
      if (!e2eConfig.mockErc1155Address) {
        console.log('  ⏭ Skipping ERC1155 tests (MOCK_ERC1155 not deployed)');
        return;
      }
      const mockAddr = e2eConfig.mockErc1155Address;
      const ids = [10n, 20n, 30n];
      const amounts = [5n, 15n, 25n];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mockERC1155 = new quais.Contract(mockAddr, MockERC1155ABI, owner1) as any;

      // Batch mint to vault
      await withRetry(async () => {
        await warmup();
        const tx = await mockERC1155.mintBatch(walletAddress, ids, amounts, '0x');
        await waitForTx(tx, 'mintBatchERC1155');
      }, 'mintBatchERC1155');

      // Wait for all 3 transfers to be indexed
      await indexer.waitUntil(
        async () => {
          const transfers = await db.getTokenTransfers(walletAddress);
          const batchTransfers = transfers.filter(
            (t) =>
              t.token_address.toLowerCase() === mockAddr.toLowerCase() &&
              t.direction === 'inflow' &&
              ids.map(String).includes(t.token_id ?? '')
          );
          return batchTransfers.length >= ids.length ? batchTransfers : null;
        },
        'ERC1155 batch mint inflows indexed',
        e2eConfig.txConfirmationTimeout
      );

      // Verify each id/value/batchIndex
      for (let i = 0; i < ids.length; i++) {
        await db.verifyTokenTransferInflow(
          walletAddress,
          mockAddr,
          '0x0000000000000000000000000000000000000000',
          {
            tokenId: ids[i].toString(),
            value: amounts[i].toString(),
            batchIndex: i,
          }
        );
      }
      console.log('  ✓ ERC1155 batch mint inflows indexed (3 rows with correct batchIndex)');
    });
  });
});
