/**
 * Shared validation helpers for event handlers.
 */

/**
 * Validates that required fields exist in event args.
 * Throws a descriptive error if any field is missing.
 */
export function validateEventArgs<T extends Record<string, unknown>>(
  args: Record<string, unknown>,
  requiredFields: (keyof T)[],
  eventName: string
): T {
  for (const field of requiredFields) {
    if (args[field as string] === undefined) {
      throw new Error(`Missing required field "${String(field)}" in ${eventName} event`);
    }
  }
  return args as T;
}
