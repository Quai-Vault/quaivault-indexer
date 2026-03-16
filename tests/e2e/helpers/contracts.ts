import * as quais from 'quais';
import { Shard } from 'quais';
import type { E2EConfig } from '../config.js';
import { BlockchainHelper } from './blockchain.js';

// Log type for parsing events from transaction receipts
interface TransactionLog {
  topics: string[];
  data: string;
}

// Import ABIs - these will be resolved at runtime
import QuaiVaultFactoryABI from '../../../abis/QuaiVaultFactory.json' with { type: 'json' };
import QuaiVaultABI from '../../../abis/QuaiVault.json' with { type: 'json' };
import SocialRecoveryModuleABI from '../../../abis/SocialRecoveryModule.json' with { type: 'json' };
import QuaiVaultProxyABI from '../../../abis/QuaiVaultProxy.json' with { type: 'json' };
import MockERC721ABI from '../../../abis/MockERC721.json' with { type: 'json' };
import MockERC1155ABI from '../../../abis/MockERC1155.json' with { type: 'json' };

// Maximum attempts to mine a valid salt for CREATE2
const MAX_SALT_MINING_ATTEMPTS = 100000;

// Retry configuration for transient RPC failures
const MAX_TX_RETRIES = 5;
const RETRY_DELAY_MS = 2000;

/**
 * Check if an error is a transient RPC error that should be retried.
 * These include access list creation failures and gas estimation failures.
 */
function isTransientRpcError(err: Error & { code?: string }): boolean {
  return (
    err.message?.includes('Access list creation failed') ||
    err.message?.includes('missing revert data') ||
    err.code === 'CALL_EXCEPTION'
  );
}

/**
 * Retry wrapper for transactions that may fail due to intermittent RPC errors
 * on Quai Network. This handles access list creation failures, gas estimation
 * failures, and other transient CALL_EXCEPTION errors.
 */
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

      // Check if this is a transient RPC error that should be retried
      if (isTransientRpcError(err)) {
        console.log(`    [${operationName}] Transient error (attempt ${attempt}/${maxRetries}): ${err.code || err.message?.substring(0, 60)}`);
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          continue;
        }
      }

      // For other errors or max retries exceeded, throw
      throw error;
    }
  }

  throw lastError || new Error(`${operationName} failed after ${maxRetries} retries`);
}

/**
 * Contract interaction helper for E2E tests
 * Handles all on-chain operations using quais SDK
 *
 * Pattern matches quaivault-contracts/scripts/create-wallet.ts exactly
 */
export class ContractHelper {
  private provider: quais.JsonRpcProvider;
  private ownerWallets: quais.Wallet[];
  private guardianWallets: quais.Wallet[];
  private blockchain: BlockchainHelper;
  private quaiVaultFactory: quais.Contract;
  private quaiVaultFactoryAddress: string;
  private quaiVaultImplementation: string;
  private socialRecoveryModule?: quais.Contract;

  constructor(rpcUrl: string, ownerPrivateKeys: string[], config: E2EConfig) {
    // Use JsonRpcProvider with usePathing: true
    // This matches the approach in quaivault-contracts/scripts/create-wallet.ts
    console.log(`    RPC URL: ${rpcUrl}`);
    this.provider = new quais.JsonRpcProvider(rpcUrl, undefined, { usePathing: true });

    // Create wallets for owners - trim() to remove any whitespace from env vars
    // This matches create-wallet-test.ts exactly: new quais.Wallet(PRIVATE_KEY.trim(), provider)
    this.ownerWallets = ownerPrivateKeys.map((pk) => new quais.Wallet(pk.trim(), this.provider));

    // Create wallets for guardians - trim() to remove any whitespace from env vars
    this.guardianWallets = config.guardianPrivateKeys.map((pk) => new quais.Wallet(pk.trim(), this.provider));

    // Initialize blockchain helper for low-level operations
    this.blockchain = new BlockchainHelper(config.rpcUrl);

    // Store addresses needed for salt mining
    this.quaiVaultFactoryAddress = config.quaiVaultFactoryAddress;
    this.quaiVaultImplementation = config.quaiVaultImplementation;

    // Initialize contract instances with first owner wallet as default signer
    // Note: ABI files are flat arrays, except MockModule which has { "abi": [...] } wrapper
    this.quaiVaultFactory = new quais.Contract(
      config.quaiVaultFactoryAddress,
      QuaiVaultFactoryABI,
      this.ownerWallets[0]
    );

    if (config.socialRecoveryModuleAddress) {
      this.socialRecoveryModule = new quais.Contract(
        config.socialRecoveryModuleAddress,
        SocialRecoveryModuleABI,
        this.ownerWallets[0]
      );
    }

  }

  /**
   * Wait for the provider to be ready
   * Must be called before using any contract methods
   *
   * IMPORTANT: We must warm up BOTH the BlockchainHelper (FetchRequest) AND
   * the JsonRpcProvider. The JsonRpcProvider needs a getBlockNumber() call
   * before transactions will work reliably on Quai Network.
   */
  async waitForReady(): Promise<void> {
    // Poll until the provider can actually make RPC calls
    const maxWait = 30000; // 30 seconds
    const pollInterval = 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      try {
        // Warm up the BlockchainHelper (FetchRequest)
        const blockNumber = await this.blockchain.getBlockNumber();
        console.log(`    Provider connected, current block: ${blockNumber}`);

        // CRITICAL: Also warm up the JsonRpcProvider used for transactions
        // Without this call, createAccessList will fail intermittently
        await this.provider.getBlockNumber(Shard.Cyprus1);

        return;
      } catch (error) {
        console.log(`    Waiting for provider... (${Math.round((Date.now() - startTime) / 1000)}s)`);
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }

    throw new Error('Provider failed to initialize within timeout');
  }

  /**
   * Cleanup provider connections
   */
  async cleanup(): Promise<void> {
    try {
      // JsonRpcProvider doesn't require explicit cleanup like WebSocketProvider
      // but we keep this method for interface consistency
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Get owner wallet address by index
   */
  getWalletAddress(index: number): string {
    if (index < 0 || index >= this.ownerWallets.length) {
      throw new Error(`Invalid owner wallet index: ${index}`);
    }
    return this.ownerWallets[index].address;
  }

  /**
   * Get guardian wallet address by index
   */
  getGuardianAddress(index: number): string {
    if (index < 0 || index >= this.guardianWallets.length) {
      throw new Error(`Invalid guardian wallet index: ${index}`);
    }
    return this.guardianWallets[index].address;
  }

  /**
   * Get a QuaiVault contract instance for a specific wallet address
   */
  private getQuaiVault(walletAddress: string, signerIndex = 0): quais.Contract {
    return new quais.Contract(walletAddress, QuaiVaultABI, this.ownerWallets[signerIndex]);
  }

  /**
   * Get a QuaiVault contract instance using guardian signer
   */
  private getQuaiVaultAsGuardian(walletAddress: string, guardianIndex: number): quais.Contract {
    return new quais.Contract(walletAddress, QuaiVaultABI, this.guardianWallets[guardianIndex]);
  }

  // ============================================
  // FACTORY OPERATIONS
  // ============================================

  /**
   * Mine a valid salt for CREATE2 deployment on Quai Network
   * On Quai, contract addresses must have shard-specific prefixes (0x00 for cyprus1)
   * and must pass quais.isQuaiAddress() validation.
   *
   * The factory computes: fullSalt = keccak256(abi.encodePacked(msg.sender, userSalt))
   * We must find a userSalt that produces a valid Quai address starting with 0x00
   */
  private async mineSalt(
    owners: string[],
    threshold: number,
    minExecutionDelay: number = 0,
    delegatecallDisabled: boolean = true
  ): Promise<{ salt: string; expectedAddress: string }> {
    const senderAddress = this.ownerWallets[0].address;

    // Encode the initialization data for QuaiVault.initialize(owners, threshold, minExecutionDelay, delegatecallDisabled)
    const vaultIface = new quais.Interface(QuaiVaultABI);
    const initData = vaultIface.encodeFunctionData('initialize', [owners, threshold, minExecutionDelay, delegatecallDisabled]);

    // Encode constructor arguments for QuaiVaultProxy(implementation, initData)
    const encodedArgs = quais.AbiCoder.defaultAbiCoder().encode(
      ['address', 'bytes'],
      [this.quaiVaultImplementation, initData]
    );

    // ERC1967 constructor proxy creation code
    const fullBytecode = QuaiVaultProxyABI.bytecode + encodedArgs.slice(2);
    const bytecodeHash = quais.keccak256(fullBytecode);

    console.log(`    Mining salt for CREATE2 address with 0x00 prefix...`);
    console.log(`    Factory: ${this.quaiVaultFactoryAddress}`);
    console.log(`    Sender: ${senderAddress}`);
    console.log(`    Implementation: ${this.quaiVaultImplementation}`);

    for (let i = 0; i < MAX_SALT_MINING_ATTEMPTS; i++) {
      const userSalt = quais.hexlify(quais.randomBytes(32));

      // Compute the full salt as the factory does
      const fullSalt = quais.keccak256(
        quais.solidityPacked(['address', 'bytes32'], [senderAddress, userSalt])
      );

      // Compute the CREATE2 address
      const create2Address = quais.getCreate2Address(
        this.quaiVaultFactoryAddress,
        fullSalt,
        bytecodeHash
      );

      // Check if address starts with 0x00 (cyprus1 shard prefix) AND is a valid Quai address
      if (create2Address.toLowerCase().startsWith('0x00') && quais.isQuaiAddress(create2Address)) {
        console.log(`    Found valid salt after ${i + 1} attempts`);
        console.log(`    Salt: ${userSalt}`);
        console.log(`    Expected address: ${create2Address}`);
        return { salt: userSalt, expectedAddress: create2Address };
      }

      // Progress indicator every 10000 attempts
      if ((i + 1) % 10000 === 0) {
        console.log(`    Tried ${i + 1} salts...`);
      }
    }

    throw new Error(
      `Failed to mine valid salt after ${MAX_SALT_MINING_ATTEMPTS} attempts`
    );
  }

  /**
   * Deploy a new QuaiVault wallet via QuaiVaultFactory
   * Uses CREATE2 salt mining to ensure address has correct shard prefix
   * Includes retry logic for intermittent "Access list creation failed" errors
   * @returns The deployed wallet address
   */
  async deployWallet(owners: string[], threshold: number, delegatecallDisabled: boolean = true): Promise<string> {
    // Mine a salt that produces a valid address for cyprus1 shard (0x00 prefix)
    const { salt, expectedAddress } = await this.mineSalt(owners, threshold, 0, delegatecallDisabled);

    console.log(`    Calling createWallet with ${owners.length} owners, threshold ${threshold}`);
    console.log(`    Mined salt: ${salt}`);
    console.log(`    Expected address: ${expectedAddress}`);
    console.log(`    Factory address: ${this.quaiVaultFactoryAddress}`);

    // Retry logic for intermittent "Access list creation failed" errors
    // This is a known issue with Quai RPC where createAccessList sporadically fails
    const MAX_RETRIES = MAX_TX_RETRIES;
    const RETRY_DELAY = RETRY_DELAY_MS;
    let tx;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Warm up the provider before each attempt
        // This helps with intermittent createAccessList failures
        await this.provider.getBlockNumber(Shard.Cyprus1);

        // Use explicit method signature for CREATE2 deployment
        console.log(`    Sending transaction... (attempt ${attempt}/${MAX_RETRIES})`);
        if (!delegatecallDisabled) {
          // Use 5-param overload for non-default delegatecallDisabled value
          tx = await this.quaiVaultFactory['createWallet(address[],uint256,bytes32,uint32,bool)'](
            owners,
            threshold,
            salt,
            0,
            delegatecallDisabled
          );
        } else {
          tx = await this.quaiVaultFactory.createWallet(
            owners,
            threshold,
            salt
          );
        }
        console.log(`    Transaction sent: ${tx.hash}`);
        break; // Success, exit retry loop
      } catch (error: unknown) {
        const err = error as Error & { code?: string; reason?: string; data?: string };
        lastError = err;

        // Check if this is a transient RPC error that should be retried
        if (isTransientRpcError(err)) {
          console.log(`    Transient error (attempt ${attempt}/${MAX_RETRIES}): ${err.code || err.message?.substring(0, 60)}`);
          if (attempt < MAX_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
            continue;
          }
        }

        // For other errors or max retries exceeded, log and throw
        console.error(`    Error calling createWallet:`);
        console.error(`    Code: ${err.code}`);
        console.error(`    Message: ${err.message}`);
        if (err.reason) console.error(`    Reason: ${err.reason}`);
        if (err.data) console.error(`    Data: ${err.data}`);
        throw error;
      }
    }

    if (!tx) {
      throw lastError || new Error('Failed to send createWallet transaction after max retries');
    }

    // Use quais built-in wait() for reliable confirmation
    const receipt = await tx.wait();
    console.log(`    Transaction confirmed in block: ${receipt.blockNumber}`);

    // Extract wallet address from WalletCreated event
    const event = receipt.logs.find((log: TransactionLog) => {
      try {
        const parsed = this.quaiVaultFactory.interface.parseLog(log);
        return parsed?.name === 'WalletCreated';
      } catch {
        return false;
      }
    });

    if (!event) {
      throw new Error('WalletCreated event not found in transaction receipt');
    }

    const parsedEvent = this.quaiVaultFactory.interface.parseLog(event);
    const walletAddress = parsedEvent?.args.wallet;
    console.log(`    Wallet created at: ${walletAddress}`);

    // Verify the address matches our prediction
    if (walletAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
      console.warn(`    Warning: Created address differs from expected!`);
      console.warn(`    Expected: ${expectedAddress}`);
      console.warn(`    Actual: ${walletAddress}`);
    }

    return walletAddress;
  }

  /**
   * Register an existing wallet with the QuaiVaultFactory
   */
  async registerWallet(walletAddress: string): Promise<void> {
    await withRetry(
      async () => {
        // Warm up provider before transaction
        await this.provider.getBlockNumber(Shard.Cyprus1);
        const tx = await this.quaiVaultFactory.registerWallet(walletAddress);
        await tx.wait();
      },
      'registerWallet'
    );
  }

  // ============================================
  // TRANSACTION OPERATIONS
  // ============================================

  /**
   * Propose a new transaction
   * @returns The transaction hash (internal multisig hash, not chain tx hash)
   */
  async proposeTransaction(
    walletAddress: string,
    to: string,
    value: bigint,
    data: string,
    signerIndex = 0
  ): Promise<string> {
    return withRetry(
      async () => {
        // Warm up provider before transaction
        await this.provider.getBlockNumber(Shard.Cyprus1);
        const vault = this.getQuaiVault(walletAddress, signerIndex);
        const tx = await vault.proposeTransaction(to, value, data);
        const receipt = await tx.wait();

        // Extract txHash from TransactionProposed event
        const proposedTopic = quais.id('TransactionProposed(bytes32,address,address,uint256,bytes,uint48,uint32)');
        const proposedLog = receipt.logs.find((log: TransactionLog) => log.topics[0] === proposedTopic);

        if (!proposedLog) {
          throw new Error('TransactionProposed event not found');
        }

        return proposedLog.topics[1]; // txHash is indexed
      },
      'proposeTransaction'
    );
  }

  /**
   * Approve a pending transaction
   */
  async approveTransaction(
    walletAddress: string,
    txHash: string,
    signerIndex: number
  ): Promise<void> {
    await withRetry(
      async () => {
        // Warm up provider before transaction
        await this.provider.getBlockNumber(Shard.Cyprus1);
        const vault = this.getQuaiVault(walletAddress, signerIndex);
        const tx = await vault.approveTransaction(txHash);
        await tx.wait();
      },
      'approveTransaction'
    );
  }

  /**
   * Revoke approval from a pending transaction
   */
  async revokeApproval(walletAddress: string, txHash: string, signerIndex: number): Promise<void> {
    await withRetry(
      async () => {
        // Warm up provider before transaction
        await this.provider.getBlockNumber(Shard.Cyprus1);
        const vault = this.getQuaiVault(walletAddress, signerIndex);
        const tx = await vault.revokeApproval(txHash);
        await tx.wait();
      },
      'revokeApproval'
    );
  }

  /**
   * Execute an approved transaction
   */
  async executeTransaction(
    walletAddress: string,
    txHash: string,
    signerIndex = 0
  ): Promise<void> {
    await withRetry(
      async () => {
        // Warm up provider before transaction
        await this.provider.getBlockNumber(Shard.Cyprus1);
        const vault = this.getQuaiVault(walletAddress, signerIndex);
        const tx = await vault.executeTransaction(txHash);
        await tx.wait();
      },
      'executeTransaction'
    );
  }

  /**
   * Cancel a pending transaction (only proposer can cancel)
   */
  async cancelTransaction(
    walletAddress: string,
    txHash: string,
    signerIndex = 0
  ): Promise<void> {
    await withRetry(
      async () => {
        // Warm up provider before transaction
        await this.provider.getBlockNumber(Shard.Cyprus1);
        const vault = this.getQuaiVault(walletAddress, signerIndex);
        const tx = await vault.cancelTransaction(txHash);
        await tx.wait();
      },
      'cancelTransaction'
    );
  }

  // ============================================
  // OWNER MANAGEMENT
  // ============================================

  /**
   * Add a new owner (requires multisig approval)
   * This proposes, approves, and executes the addOwner transaction
   */
  async addOwner(walletAddress: string, newOwner: string): Promise<void> {
    const vault = this.getQuaiVault(walletAddress);
    const data = vault.interface.encodeFunctionData('addOwner', [newOwner]);

    // Propose the transaction (proposing does NOT auto-approve)
    const txHash = await this.proposeTransaction(walletAddress, walletAddress, 0n, data, 0);

    // Proposer (owner 0) must explicitly approve
    await this.approveTransaction(walletAddress, txHash, 0);

    // Second owner approves to meet threshold of 2
    await this.approveTransaction(walletAddress, txHash, 1);

    // Execute
    await this.executeTransaction(walletAddress, txHash);
  }

  /**
   * Remove an owner (requires multisig approval)
   */
  async removeOwner(walletAddress: string, ownerToRemove: string): Promise<void> {
    const vault = this.getQuaiVault(walletAddress);
    const data = vault.interface.encodeFunctionData('removeOwner', [ownerToRemove]);

    // Propose, approve with both owners, then execute
    const txHash = await this.proposeTransaction(walletAddress, walletAddress, 0n, data, 0);
    await this.approveTransaction(walletAddress, txHash, 0); // Proposer approves
    await this.approveTransaction(walletAddress, txHash, 1); // Second owner approves
    await this.executeTransaction(walletAddress, txHash);
  }

  /**
   * Change the approval threshold (requires multisig approval)
   */
  async changeThreshold(walletAddress: string, newThreshold: number): Promise<void> {
    const vault = this.getQuaiVault(walletAddress);
    const data = vault.interface.encodeFunctionData('changeThreshold', [newThreshold]);

    // Propose, approve with both owners, then execute
    const txHash = await this.proposeTransaction(walletAddress, walletAddress, 0n, data, 0);
    await this.approveTransaction(walletAddress, txHash, 0); // Proposer approves
    await this.approveTransaction(walletAddress, txHash, 1); // Second owner approves
    await this.executeTransaction(walletAddress, txHash);
  }

  // ============================================
  // MODULE OPERATIONS
  // ============================================

  /**
   * Enable a module on the wallet (requires multisig approval)
   */
  async enableModule(walletAddress: string, moduleAddress: string): Promise<void> {
    const vault = this.getQuaiVault(walletAddress);
    const data = vault.interface.encodeFunctionData('enableModule', [moduleAddress]);

    // Propose, approve with both owners, then execute
    const txHash = await this.proposeTransaction(walletAddress, walletAddress, 0n, data, 0);
    await this.approveTransaction(walletAddress, txHash, 0); // Proposer approves
    await this.approveTransaction(walletAddress, txHash, 1); // Second owner approves
    await this.executeTransaction(walletAddress, txHash);
  }

  /**
   * Disable a module on the wallet (requires multisig approval)
   * Uses the Zodiac 2-param signature: disableModule(prevModule, module)
   */
  async disableModule(
    walletAddress: string,
    prevModule: string,
    moduleAddress: string
  ): Promise<void> {
    const vault = this.getQuaiVault(walletAddress);
    const data = vault.interface.encodeFunctionData('disableModule', [prevModule, moduleAddress]);

    // Propose, approve with both owners, then execute
    const txHash = await this.proposeTransaction(walletAddress, walletAddress, 0n, data, 0);
    await this.approveTransaction(walletAddress, txHash, 0); // Proposer approves
    await this.approveTransaction(walletAddress, txHash, 1); // Second owner approves
    await this.executeTransaction(walletAddress, txHash);
  }

  // ============================================
  // DEPOSITS
  // ============================================

  /**
   * Send QUAI to a wallet to trigger Received event
   */
  async sendQuaiToWallet(walletAddress: string, amount: bigint, signerIndex = 0): Promise<void> {
    const wallet = this.ownerWallets[signerIndex];

    await withRetry(
      async () => {
        // Warm up provider before transaction
        await this.provider.getBlockNumber(Shard.Cyprus1);

        // Use quais.getAddress to ensure proper address format
        const toAddress = quais.getAddress(walletAddress);

        // quais SDK requires explicit from address for proper zone/shard routing
        const tx = await wallet.sendTransaction({
          from: wallet.address,
          to: toAddress,
          value: amount,
        });
        await tx.wait();
      },
      'sendQuaiToWallet'
    );
  }

  // ============================================
  // SOCIAL RECOVERY MODULE
  // ============================================

  /**
   * Setup recovery configuration for a wallet
   */
  async setupRecovery(
    walletAddress: string,
    guardians: string[],
    threshold: number,
    recoveryPeriod: number
  ): Promise<void> {
    if (!this.socialRecoveryModule) {
      throw new Error('SocialRecoveryModule not configured');
    }

    const data = this.socialRecoveryModule.interface.encodeFunctionData('setupRecovery', [
      walletAddress,
      guardians,
      threshold,
      recoveryPeriod,
    ]);

    // Propose, approve with both owners, then execute
    const txHash = await this.proposeTransaction(
      walletAddress,
      await this.socialRecoveryModule.getAddress(),
      0n,
      data,
      0
    );
    await this.approveTransaction(walletAddress, txHash, 0); // Proposer approves
    await this.approveTransaction(walletAddress, txHash, 1); // Second owner approves
    await this.executeTransaction(walletAddress, txHash);
  }

  /**
   * Initiate a recovery as a guardian
   * @returns The recovery hash
   */
  async initiateRecovery(
    walletAddress: string,
    newOwners: string[],
    newThreshold: number,
    guardianIndex: number
  ): Promise<string> {
    if (!this.socialRecoveryModule) {
      throw new Error('SocialRecoveryModule not configured');
    }

    // Warm up provider before transaction
    await this.provider.getBlockNumber(Shard.Cyprus1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const moduleWithGuardian = this.socialRecoveryModule.connect(
      this.guardianWallets[guardianIndex]
    ) as any;
    const tx = await moduleWithGuardian.initiateRecovery(walletAddress, newOwners, newThreshold);
    const receipt = await tx.wait();

    // Extract recovery hash from RecoveryInitiated event
    const initiatedTopic = quais.id(
      'RecoveryInitiated(address,bytes32,address[],uint256,address)'
    );
    const initiatedLog = receipt.logs.find((log: TransactionLog) => log.topics[0] === initiatedTopic);

    if (!initiatedLog) {
      throw new Error('RecoveryInitiated event not found');
    }

    return initiatedLog.topics[2]; // recoveryHash is second indexed param
  }

  /**
   * Approve a recovery as a guardian
   */
  async approveRecovery(
    walletAddress: string,
    recoveryHash: string,
    guardianIndex: number
  ): Promise<void> {
    if (!this.socialRecoveryModule) {
      throw new Error('SocialRecoveryModule not configured');
    }

    // Warm up provider before transaction
    await this.provider.getBlockNumber(Shard.Cyprus1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const moduleWithGuardian = this.socialRecoveryModule.connect(
      this.guardianWallets[guardianIndex]
    ) as any;
    const tx = await moduleWithGuardian.approveRecovery(walletAddress, recoveryHash);
    await tx.wait();
  }

  /**
   * Revoke recovery approval as a guardian
   */
  async revokeRecoveryApproval(
    walletAddress: string,
    recoveryHash: string,
    guardianIndex: number
  ): Promise<void> {
    if (!this.socialRecoveryModule) {
      throw new Error('SocialRecoveryModule not configured');
    }

    // Warm up provider before transaction
    await this.provider.getBlockNumber(Shard.Cyprus1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const moduleWithGuardian = this.socialRecoveryModule.connect(
      this.guardianWallets[guardianIndex]
    ) as any;
    // Contract function is revokeRecoveryApproval (not revokeApproval)
    const tx = await moduleWithGuardian.revokeRecoveryApproval(walletAddress, recoveryHash);
    await tx.wait();
  }

  /**
   * Execute a recovery (after recovery period has elapsed)
   */
  async executeRecovery(walletAddress: string, recoveryHash: string): Promise<void> {
    if (!this.socialRecoveryModule) {
      throw new Error('SocialRecoveryModule not configured');
    }

    // Warm up provider before transaction
    await this.provider.getBlockNumber(Shard.Cyprus1);
    const tx = await this.socialRecoveryModule.executeRecovery(walletAddress, recoveryHash);
    await tx.wait();
  }

  /**
   * Cancel a recovery as wallet owner
   */
  async cancelRecovery(
    walletAddress: string,
    recoveryHash: string,
    signerIndex = 0
  ): Promise<void> {
    if (!this.socialRecoveryModule) {
      throw new Error('SocialRecoveryModule not configured');
    }

    // Warm up provider before transaction
    await this.provider.getBlockNumber(Shard.Cyprus1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const moduleWithOwner = this.socialRecoveryModule.connect(this.ownerWallets[signerIndex]) as any;
    const tx = await moduleWithOwner.cancelRecovery(walletAddress, recoveryHash);
    await tx.wait();
  }

  // ============================================
  // ERC721 TOKEN OPERATIONS
  // ============================================

  /**
   * Mint an ERC721 token to an address
   */
  async mintERC721(
    mockAddress: string,
    to: string,
    tokenId: bigint,
    signerIndex = 0
  ): Promise<void> {
    await withRetry(
      async () => {
        await this.provider.getBlockNumber(Shard.Cyprus1);
        const mock = new quais.Contract(mockAddress, MockERC721ABI, this.ownerWallets[signerIndex]);
        const tx = await mock.mint(to, tokenId);
        await tx.wait();
      },
      'mintERC721'
    );
  }

  /**
   * Transfer an ERC721 token between addresses.
   * Calls transferFrom on the mock contract.
   */
  async transferERC721(
    mockAddress: string,
    from: string,
    to: string,
    tokenId: bigint,
    signerIndex = 0
  ): Promise<void> {
    await withRetry(
      async () => {
        await this.provider.getBlockNumber(Shard.Cyprus1);
        const mock = new quais.Contract(mockAddress, MockERC721ABI, this.ownerWallets[signerIndex]);
        const tx = await mock.transferFrom(from, to, tokenId);
        await tx.wait();
      },
      'transferERC721'
    );
  }

  // ============================================
  // ERC1155 TOKEN OPERATIONS
  // ============================================

  /**
   * Mint ERC1155 tokens to an address
   */
  async mintERC1155(
    mockAddress: string,
    to: string,
    id: bigint,
    amount: bigint,
    signerIndex = 0
  ): Promise<void> {
    await withRetry(
      async () => {
        await this.provider.getBlockNumber(Shard.Cyprus1);
        const mock = new quais.Contract(mockAddress, MockERC1155ABI, this.ownerWallets[signerIndex]);
        const tx = await mock.mint(to, id, amount, '0x');
        await tx.wait();
      },
      'mintERC1155'
    );
  }

  /**
   * Batch mint ERC1155 tokens to an address
   */
  async mintBatchERC1155(
    mockAddress: string,
    to: string,
    ids: bigint[],
    amounts: bigint[],
    signerIndex = 0
  ): Promise<void> {
    await withRetry(
      async () => {
        await this.provider.getBlockNumber(Shard.Cyprus1);
        const mock = new quais.Contract(mockAddress, MockERC1155ABI, this.ownerWallets[signerIndex]);
        const tx = await mock.mintBatch(to, ids, amounts, '0x');
        await tx.wait();
      },
      'mintBatchERC1155'
    );
  }

  /**
   * Transfer ERC1155 token via safeTransferFrom.
   * Requires the signer to be approved or the token owner.
   */
  async transferERC1155(
    mockAddress: string,
    from: string,
    to: string,
    id: bigint,
    amount: bigint,
    signerIndex = 0
  ): Promise<void> {
    await withRetry(
      async () => {
        await this.provider.getBlockNumber(Shard.Cyprus1);
        const mock = new quais.Contract(mockAddress, MockERC1155ABI, this.ownerWallets[signerIndex]);
        const tx = await mock.safeTransferFrom(from, to, id, amount, '0x');
        await tx.wait();
      },
      'transferERC1155'
    );
  }

  /**
   * Batch transfer ERC1155 tokens via safeBatchTransferFrom.
   */
  async batchTransferERC1155(
    mockAddress: string,
    from: string,
    to: string,
    ids: bigint[],
    amounts: bigint[],
    signerIndex = 0
  ): Promise<void> {
    await withRetry(
      async () => {
        await this.provider.getBlockNumber(Shard.Cyprus1);
        const mock = new quais.Contract(mockAddress, MockERC1155ABI, this.ownerWallets[signerIndex]);
        const tx = await mock.safeBatchTransferFrom(from, to, ids, amounts, '0x');
        await tx.wait();
      },
      'batchTransferERC1155'
    );
  }

  // ============================================
  // UTILITIES
  // ============================================

  /**
   * Get account nonce
   */
  async getNonce(address: string): Promise<number> {
    return this.blockchain.getNonce(address);
  }

  /**
   * Get account balance
   */
  async getBalance(address: string): Promise<bigint> {
    return this.blockchain.getBalance(address);
  }

  /**
   * Wait for a transaction to be confirmed
   */
  async waitForConfirmation(txHash: string, confirmations = 1): Promise<void> {
    await this.blockchain.waitForTransaction(txHash, confirmations);
  }
}
