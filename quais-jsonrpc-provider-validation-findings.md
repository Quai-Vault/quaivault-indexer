# quais.js JsonRpcProvider Validation Findings

**Date:** 2026-02-23
**quais version:** 1.0.0-alpha.53
**Audience:** quaivault-indexer developers

## Summary

During a comparative security audit between `qdl-indexer` and `quaivault-indexer`, we investigated what validation the quais.js `JsonRpcProvider` performs internally on RPC responses. The findings suggest that `JsonRpcProvider` already handles the majority of response validation that `quaivault-indexer` implements manually via raw `FetchRequest` + custom validators.

This document details the overlap so the quaivault-indexer team can evaluate whether the manual FetchRequest approach is still justified or could be simplified.

## What JsonRpcProvider Already Validates

### 1. JSON-RPC Error Responses — COVERED

**File:** `node_modules/quais/lib/esm/providers/provider-jsonrpc.js` (lines 428-446)

When the RPC returns `{"error": {...}}`, the provider detects the `error` field and calls `getRpcError()` (lines 952-1041) which converts it to a typed quais error and rejects the promise. Error responses are **never silently swallowed**.

### 2. Malformed JSON — COVERED

**File:** `node_modules/quais/lib/esm/providers/provider-jsonrpc.js` (lines 1298-1320)

`response.bodyJson` throws during JSON.parse if the RPC returns non-JSON. This propagates as a rejection from `_send()`.

### 3. getLogs() — Individual Log Fields Validated

**File:** `node_modules/quais/lib/esm/providers/format.js` (lines 93-108)

The `formatLog()` function validates every field:

| Field | Validator | What It Checks |
|-------|-----------|----------------|
| `address` | `getAddress` | EIP-55 checksum validation |
| `blockHash` | `formatHash` | 32-byte hex string |
| `blockNumber` | `getNumber` | Valid integer conversion |
| `data` | `formatData` | Valid hex string |
| `index` | `getNumber` | Valid integer |
| `removed` | `allowNull(formatBoolean, false)` | Boolean with default |
| `topics` | `arrayOf(formatHash)` | Array of 32-byte hex strings |
| `transactionHash` | `formatHash` | 32-byte hex string |
| `transactionIndex` | `getNumber` | Valid integer |

If any validation fails, `assertArgument()` throws with context. Null RPC results (no logs found) return an empty array.

**Overlap with quaivault-indexer:** This covers everything that `validateLogEntry()` in `validation.ts` (lines 176-227) does.

### 4. getBlock() — Extensive Block Validation

**File:** `node_modules/quais/lib/esm/providers/format.js` (lines 161-202)

`_formatBlock()` and `_formatHeader()` validate:
- All hash fields via `formatHash` (must be valid 32-byte hex)
- `timestamp` via `getNumber` (must be valid integer; **no null allowed**)
- All BigInt fields via `getBigInt`
- Transactions array validated individually

Null result (block not found) returns `null`.

**Overlap:** Covers `validateBlockTimestampResponse()` (validation.ts lines 268-308), though quais uses `getNumber` on the parsed block object rather than the raw hex from woHeader.

### 5. getBlockNumber() — Hex Parsing Validated

**File:** `node_modules/quais/lib/esm/providers/abstract-provider.js` (lines 808-814)

Result is passed to `getNumber()` which validates integer conversion. Malformed hex strings cause `getNumber()` to throw.

**Overlap:** Covers `validateBlockNumberResponse()` (validation.ts lines 143-159).

### 6. getTransaction() — Full Struct Validation

**File:** `node_modules/quais/lib/esm/providers/format.js` (lines 265-278)

`formatTransactionResponse()` detects transaction type and validates all fields through formatters. Hash, address, and numeric fields are all individually validated.

### 7. Contract Method Calls — ABI-Based Type Validation

**File:** `node_modules/quais/lib/esm/contract/contract.js` (lines 372-392)

When calling `contract.someMethod()`:
1. `provider.call(tx)` executes the RPC call
2. Result passed to `interface.decodeFunctionResult(fragment, result)`
3. ABI decoder validates return types against the contract ABI
4. Type mismatches or decoding failures throw errors

**Overlap:** Covers `validateCallResponse()` (validation.ts lines 253-263) and goes further with ABI-level type checking.

## What JsonRpcProvider Does NOT Validate

### 1. `jsonrpc: "2.0"` Response Field — NOT CHECKED

The provider constructs outgoing requests with `jsonrpc: "2.0"` but never validates that responses include this field. A non-conformant RPC server that omits `jsonrpc` would not be detected.

**Risk level:** Very low. All major RPC implementations include this field.

### 2. Custom Error Context — NOT PROVIDED

quais validation errors use generic `assertArgument()` messages. They don't include context like "block number 12345" or "log entry at index 3". The quaivault-indexer's custom validators provide more actionable error messages for debugging.

### 3. Response ID Matching — CHECKED BUT DIFFERENTLY

The provider does check that response IDs match request IDs (provider-jsonrpc.js line 428: `r.id === payload.id`), but logs missing matches as `BAD_DATA` rather than providing detailed diagnostics.

## Recommendation

Given that ~90% of the validation in quaivault-indexer's `validation.ts` is already handled by `JsonRpcProvider`, the quaivault-indexer team could consider:

1. **Option A (Recommended): Switch to JsonRpcProvider** — Replace `FetchRequest` with `JsonRpcProvider`. Add a thin wrapper only for the gaps (custom error context, contract call result validation). This eliminates ~200 lines of manual validation code and 5-6x boilerplate per RPC method.

2. **Option B: Keep FetchRequest** — If the team values the explicit, auditor-visible validation over code conciseness, the current approach remains valid. Document that the manual validation is intentionally redundant for audit transparency.

Note that quaivault-indexer already uses `WebSocketProvider` (standard quais provider) for WebSocket subscriptions, so the codebase already trusts quais' provider layer for that path.

## Source Files Referenced

- `node_modules/quais/lib/esm/providers/provider-jsonrpc.js` — RPC request/response handling
- `node_modules/quais/lib/esm/providers/abstract-provider.js` — High-level provider methods
- `node_modules/quais/lib/esm/providers/format.js` — Response formatters/validators
- `node_modules/quais/lib/esm/contract/contract.js` — Contract call handling
- `quaivault-indexer/src/utils/validation.ts` — Custom RPC validation (309 lines)
- `quaivault-indexer/src/services/quai.ts` — Raw FetchRequest RPC client (289 lines)
