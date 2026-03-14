/**
 * Shared validation helpers for event handlers.
 */

/**
 * Validates that required fields exist in event args.
 * Throws a descriptive error if any field is missing or null.
 */
export function validateEventArgs<T extends Record<string, unknown>>(
  args: Record<string, unknown>,
  requiredFields: (keyof T)[],
  eventName: string
): T {
  for (const field of requiredFields) {
    if (args[field as string] === undefined || args[field as string] === null) {
      throw new Error(`Missing required field "${String(field)}" in ${eventName} event`);
    }
  }
  return args as T;
}

/**
 * Safely parse a string to an integer, throwing on NaN or non-finite values.
 */
export function safeParseInt(value: string, fieldName: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.trunc(n) !== n) {
    throw new Error(`Invalid numeric value for ${fieldName}: "${value}"`);
  }
  return n;
}

/**
 * Safely parse a 0x-prefixed hex string to a non-negative safe integer.
 * Used for RPC contract call responses (e.g., threshold, minExecutionDelay).
 */
export function safeParseHex(value: string, fieldName: string): number {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new Error(`Invalid hex value for ${fieldName}: "${value}"`);
  }
  const n = parseInt(value, 16);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`Out of range hex value for ${fieldName}: "${value}"`);
  }
  return n;
}
