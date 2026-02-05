import { quais, FetchRequest } from 'quais';

export interface TransactionReceipt {
  hash: string;
  blockNumber: number;
  blockHash: string;
  from: string;
  to: string | null;
  status: number;
  gasUsed: bigint;
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
  }>;
}

export interface Block {
  number: number;
  hash: string;
  timestamp: number;
  transactions: string[];
}

/**
 * Low-level blockchain utilities using quais FetchRequest
 * Note: FetchRequest needs the full URL with shard path, unlike JsonRpcProvider with usePathing
 */
export class BlockchainHelper {
  private requestId = 0;
  private fullRpcUrl: string;

  constructor(rpcUrl: string) {
    // Ensure the URL has the shard path for direct RPC calls
    // If the URL doesn't have a shard path, append /cyprus1
    if (rpcUrl.match(/\/(cyprus|paxos|hydra)\d+\/?$/i)) {
      this.fullRpcUrl = rpcUrl;
    } else {
      // Remove trailing slash if present and append shard
      this.fullRpcUrl = rpcUrl.replace(/\/$/, '') + '/cyprus1';
    }
  }

  /**
   * Make a JSON-RPC request
   */
  private async rpcRequest<T>(method: string, params: unknown[] = []): Promise<T> {
    const req = new FetchRequest(this.fullRpcUrl);
    req.body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: ++this.requestId,
    });
    req.setHeader('Content-Type', 'application/json');

    const response = await req.send();
    const json = JSON.parse(response.bodyText);

    if (json.error) {
      throw new Error(`RPC Error: ${json.error.message}`);
    }

    return json.result;
  }

  /**
   * Get current block number
   */
  async getBlockNumber(): Promise<number> {
    const result = await this.rpcRequest<string>('quai_blockNumber');
    return parseInt(result, 16);
  }

  /**
   * Get transaction receipt
   */
  async getTransactionReceipt(txHash: string): Promise<TransactionReceipt | null> {
    const result = await this.rpcRequest<{
      transactionHash: string;
      blockNumber: string;
      blockHash: string;
      from: string;
      to: string | null;
      status: string;
      gasUsed: string;
      logs: Array<{
        address: string;
        topics: string[];
        data: string;
      }>;
    } | null>('quai_getTransactionReceipt', [txHash]);

    if (!result) return null;

    return {
      hash: result.transactionHash,
      blockNumber: parseInt(result.blockNumber, 16),
      blockHash: result.blockHash,
      from: result.from,
      to: result.to,
      status: parseInt(result.status, 16),
      gasUsed: BigInt(result.gasUsed),
      logs: result.logs,
    };
  }

  /**
   * Wait for transaction to be mined with optional confirmations
   */
  async waitForTransaction(
    txHash: string,
    confirmations = 1,
    timeout = 60000
  ): Promise<TransactionReceipt> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const receipt = await this.getTransactionReceipt(txHash);

      if (receipt) {
        if (confirmations <= 1) {
          return receipt;
        }

        const currentBlock = await this.getBlockNumber();
        const confirmationCount = currentBlock - receipt.blockNumber + 1;

        if (confirmationCount >= confirmations) {
          return receipt;
        }
      }

      // Wait 2 seconds before next check
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error(`Transaction ${txHash} not confirmed within ${timeout}ms`);
  }

  /**
   * Get block by number
   */
  async getBlock(blockNumber: number): Promise<Block> {
    const result = await this.rpcRequest<{
      number: string;
      hash: string;
      timestamp: string;
      transactions: string[];
    }>('quai_getBlockByNumber', [`0x${blockNumber.toString(16)}`, false]);

    return {
      number: parseInt(result.number, 16),
      hash: result.hash,
      timestamp: parseInt(result.timestamp, 16),
      transactions: result.transactions,
    };
  }

  /**
   * Check network connectivity
   */
  async isConnected(): Promise<boolean> {
    try {
      await this.getBlockNumber();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get account balance
   */
  async getBalance(address: string): Promise<bigint> {
    const result = await this.rpcRequest<string>('quai_getBalance', [address, 'latest']);
    return BigInt(result);
  }

  /**
   * Get account nonce
   */
  async getNonce(address: string): Promise<number> {
    const result = await this.rpcRequest<string>('quai_getTransactionCount', [address, 'latest']);
    return parseInt(result, 16);
  }
}
