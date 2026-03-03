/**
 * Shared backfill batch loop used by both the standalone backfill script
 * and the indexer's inline backfill method.
 */

export interface BackfillLoopOpts {
  fromBlock: number;
  toBlock: number;
  batchSize: number;
  /** Process a single batch. Callers wrap this with retry logic as needed. */
  processBatch: (start: number, end: number) => Promise<void>;
  /** Optional progress callback invoked after each batch completes. */
  onProgress?: (start: number, end: number, pct: string) => void;
}

export async function runBackfillLoop(opts: BackfillLoopOpts): Promise<void> {
  const { fromBlock, toBlock, batchSize, processBatch, onProgress } = opts;

  for (let start = fromBlock; start <= toBlock; start += batchSize) {
    const end = Math.min(start + batchSize - 1, toBlock);
    await processBatch(start, end);

    if (onProgress) {
      const total = toBlock - fromBlock;
      const pct = total > 0
        ? (((end - fromBlock) / total) * 100).toFixed(1)
        : '100.0';
      onProgress(start, end, pct);
    }
  }
}
