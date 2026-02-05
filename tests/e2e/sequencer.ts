/**
 * Custom test sequencer that sorts test files by their numeric prefix.
 * This ensures tests run in order: 01-factory, 02-deposits, etc.
 */
import { BaseSequencer } from 'vitest/node';
import type { WorkspaceSpec } from 'vitest/node';

export default class NumericSequencer extends BaseSequencer {
  async sort(files: WorkspaceSpec[]): Promise<WorkspaceSpec[]> {
    return files.sort((a, b) => {
      // WorkspaceSpec is [project, filepath, options]
      const fileA = a[1].split('/').pop() || '';
      const fileB = b[1].split('/').pop() || '';

      // Extract numeric prefix (e.g., "01" from "01-factory.e2e.test.ts")
      const numA = parseInt(fileA.match(/^(\d+)/)?.[1] || '99', 10);
      const numB = parseInt(fileB.match(/^(\d+)/)?.[1] || '99', 10);

      return numA - numB;
    });
  }
}
