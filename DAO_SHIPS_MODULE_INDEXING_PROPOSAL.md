# Proposal: First-Class Vault Module Indexing for DAO Ships and Other Zodiac Modules

**Status:** Proposed for discussion  
**Audience:** Quai Vault indexer, contracts, and frontend teams  
**Prepared:** 2026-08-15  
**Scope:** Indexer data foundation only; no production code changes are included in this proposal

## Executive summary

DAO Ships creates a unique `DAOShip` contract for each DAO and uses that contract as an enabled Zodiac-style module on a Quai Vault treasury. Supporting DAO Ships in the Quai Vault frontend therefore cannot be implemented by adding one static module address to a catalog. The frontend first needs a reliable, generic inventory of every module attached to a vault.

The Quai Vault indexer already captures most of the necessary raw signals:

- `EnabledModule` and `DisabledModule` update `wallet_modules`.
- `ExecutionFromModuleSuccess` and `ExecutionFromModuleFailure` populate `module_executions`.
- `indexer_state` and the health endpoint expose indexer freshness.
- Both module tables are available for public reads and realtime subscriptions.

This proposal recommends strengthening that generic foundation rather than making the Quai Vault indexer DAO Ships-aware:

1. Keep `wallet_modules` as the current-state projection.
2. Add an append-only `wallet_module_events` lifecycle table.
3. Apply lifecycle events and projection updates atomically and idempotently.
4. Correct re-enable semantics so stale disable metadata is cleared.
5. Expose a stable module-inventory query with explicit indexer freshness.
6. Continue indexing generic module execution outcomes, while documenting the limits of the current vault events.
7. Leave DAO identity, proposals, members, profiles, and decoded governance actions in the DAO Ships indexer. Consumers should federate the two sources and verify enabled status on-chain for security-critical decisions.

No DAO Ships contract addresses, ABIs, Supabase credentials, or protocol-specific tables should be added to the Quai Vault indexer as part of this work.

## Motivation

### DAO Ships is a dynamic module family

Each DAO Ships DAO is an EIP-1167 clone with its own address. The combined launcher predicts that address, creates a Quai Vault with `initialModules = [predictedDAOShip]`, whitelists MultiSendCallOnly, launches the DAOShip with the vault as its `avatar`, and verifies that the predicted and deployed DAOShip addresses match.

For a newly created vault, the relationship is atomic. There is no separate module-enablement transaction. DAO Ships also supports launching against an existing vault, in which case vault owners must separately approve and execute `enableModule(daoShip)`.

This distinction matters for indexing and identity:

- A static address registry cannot enumerate DAOShip modules.
- A DAO Ships record whose `avatar` points to a vault is not sufficient proof of owner authorization.
- The vault's actual module state is the authorization signal.
- Disabled DAOShip modules remain relevant historical relationships and should remain discoverable.
- The launcher technically permits more than one DAOShip to reference the same existing vault, so consumers must not assume a permanent one-to-one avatar-to-DAO relationship.

DAO Ships uses the enabled module to process passed proposals through `execTransactionFromModule`, using whitelisted MultiSendCallOnly delegatecall. Ragequit also requires the DAOShip to remain enabled because proportional withdrawals are executed from the vault through module calls. Disabling the module therefore stops both new governance execution and ragequit until it is re-enabled.

Public DAO Ships documentation describes the same system boundary: the Quai Vault holds the treasury, governance executes through the module interface, and vault owners retain an emergency brake.

### Generic module visibility is a security feature

Quai Vault follows the Safe/Zodiac module trust model. An enabled module can execute arbitrary calls from the vault, including calls back to the vault itself that can affect owners, threshold, execution delay, and module configuration. Delegatecall is additionally constrained by the vault's target whitelist.

Every active module should therefore be visible, even if no frontend recognizes its protocol. An unidentified enabled module must be presented as an unknown high-authority module, not omitted from the inventory.

This requirement extends beyond DAO Ships. DAO Ships already includes a separate module-class extension, `BudgetNavigator`, whose authority comes from being enabled directly on the vault rather than from a DAOShip permission bit. Future Quai Vault integrations are likely to introduce more dynamic module families.

## Current Quai Vault indexer behavior

### Existing strengths

The indexer has a good base for this work:

- [`wallet_modules`](./supabase/migrations/schema.sql) stores the module address, latest enable/disable block and transaction, and an `is_active` projection.
- [`module_executions`](./supabase/migrations/schema.sql) stores the emitting vault, module address, success, block, transaction, and log index.
- [`handleEnabledModule` and `handleDisabledModule`](./src/events/vault-core.ts) handle the standard lifecycle events.
- [`handleExecutionFromModuleSuccess` and `handleExecutionFromModuleFailure`](./src/events/zodiac.ts) handle generic execution results.
- [`SupabaseService.getModuleExecutions`](./src/services/supabase.ts) already provides a server-side query helper.
- `wallet_modules` and `module_executions` have public read policies, useful indexes, and realtime publication setup.
- The health service reports `currentBlock`, `lastIndexedBlock`, `blocksBehind`, and sync status.

### Gaps relevant to module consumers

#### 1. The current table is a projection, not a lifecycle history

`wallet_modules` has a unique constraint on `(wallet_address, module_address)`. Repeated enable/disable cycles overwrite the same row. A consumer can learn current state and, at most, the latest enable/disable metadata, but cannot reconstruct the lifecycle.

For an emergency control such as disabling DAO governance, preserving every transition is useful for operators, audits, incident review, and frontend activity history.

#### 2. Re-enabling leaves stale disable metadata

`SupabaseService.addModule()` upserts `enabled_at_*` and `is_active = true`, but it does not set `disabled_at_block` and `disabled_at_tx` back to `NULL`. After a disable/re-enable cycle, a row can therefore be active while still carrying the prior disable metadata.

At minimum, the re-enable path should clear both fields. An append-only event table should retain the previous disable event.

#### 3. A missing current-state row is ambiguous to consumers

No row can mean any of the following:

- the module has never been enabled;
- the indexer has not reached the relevant block;
- the event was missed or is being backfilled;
- the wallet itself is not yet indexed;
- the query is pointed at the wrong network schema.

Consumers should not have to treat “no row” as authoritative `false` without also receiving indexer freshness. Security-sensitive UI should continue to verify current status through `getModules()` or `isModuleEnabled()` on-chain.

#### 4. Module execution detail columns are not populated by current events

`module_executions` has nullable columns for `operation_type`, `to_address`, `value`, and `data_hash`, and the service accepts those fields. The current Quai Vault events emit only the module address and success/failure, so the Zodiac handlers cannot populate the additional fields.

This is not an indexer bug. The originating transaction may call a protocol-specific entry point such as `DAOShip.processProposal`; the actual vault calls are embedded in protocol calldata and may contain a batch. Generic enrichment would require protocol-specific decoding or a future contract event with richer execution context.

For DAO Ships, proposal intent and decoded actions should come from the DAO Ships indexer and be correlated by transaction hash. The Quai Vault indexer should remain the source for the fact that the vault accepted or rejected a module execution.

## Goals

1. Provide complete and unambiguous current module state as a derived indexer view.
2. Preserve every observed enable and disable transition.
3. Make reprocessing and backfill idempotent.
4. Give consumers enough freshness information to distinguish “not indexed” from “not enabled.”
5. Support module activity views without requiring knowledge of DAO Ships.
6. Remain useful for arbitrary current and future Zodiac-compatible modules.
7. Preserve existing table and query compatibility where practical.

## Non-goals

- Mirroring `ds_daos`, `ds_proposals`, `ds_members`, `ds_navigators`, or DAO profiles into the Quai Vault database.
- Recognizing a DAOShip from ABI shape or bytecode alone.
- Maintaining a static catalog of DAOShip clone addresses.
- Decoding all DAO Ships proposal types in the Quai Vault indexer.
- Treating indexed state as stronger than current on-chain state.
- Changing Quai Vault or DAO Ships contracts in this phase.
- Implementing frontend UI as part of the indexer change.

## Proposed design

### 1. Retain `wallet_modules` as the current-state projection

Keep the existing public table and its unique key so current consumers do not need a breaking migration.

Recommended additions:

| Column | Type | Purpose |
| --- | --- | --- |
| `last_event_block` | `BIGINT` | Ordering guard and projection provenance |
| `last_event_tx` | `TEXT` | Transaction that last changed current state |
| `last_event_log_index` | `INTEGER` | Deterministic ordering within a transaction/block |
| `updated_at` | `TIMESTAMPTZ` | Already present; continue updating it on each transition |

Required behavior changes:

- Enable sets `is_active = TRUE`, replaces `enabled_at_*`, and clears `disabled_at_*`.
- Disable sets `is_active = FALSE` and fills `disabled_at_*`.
- A replay of the same event has no effect.
- An older event must not overwrite a projection produced by a newer event.

If the team prefers not to add ordering columns immediately, clearing stale disable fields is still a required minimal correction.

### 2. Add append-only `wallet_module_events`

Suggested schema:

```sql
CREATE TABLE <schema>.wallet_module_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address TEXT NOT NULL
        REFERENCES <schema>.wallets(address) ON DELETE CASCADE,
    module_address TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('enabled', 'disabled')),
    event_block BIGINT NOT NULL,
    event_tx TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(wallet_address, event_tx, log_index)
);

CREATE INDEX idx_wallet_module_events_wallet_block
    ON <schema>.wallet_module_events(wallet_address, event_block DESC, log_index DESC);

CREATE INDEX idx_wallet_module_events_module_block
    ON <schema>.wallet_module_events(module_address, event_block DESC, log_index DESC);
```

The event table should receive the same public-read and service-write policies as the existing module tables. It should be included in the Supabase realtime publication if consumers need a module activity feed. Current-state consumers can continue subscribing to `wallet_modules`.

If reorg handling later introduces block hashes or canonicality markers elsewhere in the indexer, the event table should adopt the same convention. That does not need to block this proposal.

### 3. Apply event and projection changes atomically

Introduce a database RPC such as:

```text
apply_wallet_module_event(
  wallet,
  module,
  event_type,
  block_number,
  transaction_hash,
  log_index
)
```

The function should:

1. Insert the append-only event using its uniqueness key.
2. Return without changing the projection if the event already exists.
3. Upsert or update `wallet_modules` using block/log ordering.
4. Clear stale disable metadata on enable.
5. Commit both writes in one database transaction.

The TypeScript handlers then validate decoded arguments and call this single operation. This prevents an event-history write from succeeding while the current-state update fails, or vice versa.

An observed `DisabledModule` with no prior projection row should not silently disappear. Recommended choices, in order of preference:

1. Preserve the disable event and emit an operational warning/metric, then repair the projection during reconciliation or backfill.
2. Permit a projection row with nullable/unknown enable provenance.
3. If schema compatibility prevents either approach initially, fail loudly enough that operators know a history gap exists.

Inventing an enable block from the disable event would produce false provenance and is not recommended.

### 4. Expose a stable module inventory query

Add a SQL view or RPC that returns, for one wallet:

- module address;
- active status;
- latest enable block and transaction;
- latest disable block and transaction;
- last state-change block, transaction, and log index;
- total execution count;
- successful and failed execution counts;
- latest execution block and transaction;
- indexer's `last_indexed_block` and `last_indexed_at`.

An RPC is preferable if attaching global `indexer_state` to each result row makes a plain view awkward. A response envelope could instead return:

```json
{
  "wallet": "0x...",
  "indexedThroughBlock": 123,
  "lastIndexedAt": "...",
  "modules": [
    {
      "moduleAddress": "0x...",
      "isActive": true,
      "enabledAtBlock": 100,
      "disabledAtBlock": null,
      "executionCount": 4,
      "failedExecutionCount": 1,
      "lastExecutionBlock": 120
    }
  ]
}
```

Supabase table queries can remain available. The stable query gives frontends one documented contract and prevents each consumer from independently deriving freshness and aggregate activity.

Indexes should be reviewed with `EXPLAIN ANALYZE` against realistic module-execution volume. The existing wallet/module execution indexes are a good starting point.

### 5. Keep module identity outside the core indexer

The inventory should intentionally return addresses and state, not a protocol label derived from untrusted heuristics.

For DAO Ships, the consuming application should:

1. Query the DAO Ships indexer for all `ds_daos` whose `avatar` equals the vault.
2. Match each DAO ID against the Quai Vault module inventory.
3. Verify `DAOShip.avatar() == vault` on-chain.
4. Use `vault.isModuleEnabled(daoShip)` or `vault.getModules()` as the final live-state check.
5. Treat an official DAO Ships launch record without module enablement as an unendorsed relationship, not an active vault integration.

The DAO Ships indexer authenticates launch records by accepting `LaunchDAOShipAndVault` only from its configured launcher. That is useful protocol provenance, but the vault's module state remains the owner-authorization signal for existing-vault launches.

Other resolvers can identify Social Recovery, BudgetNavigator, or future protocols. Anything unresolved should remain visible as an unknown module.

### 6. Preserve the generic execution boundary

Continue recording `ExecutionFromModuleSuccess` and `ExecutionFromModuleFailure` exactly as emitted by the vault.

Recommended documentation clarification:

- `success` means the immediate vault module execution call returned success or failure.
- `executed_at_tx` can be used to correlate with a protocol-specific indexer.
- `operation_type`, `to_address`, `value`, and `data_hash` are unavailable from current vault events and are expected to be `NULL` unless a separately defined, reliable enrichment path populates them.
- A single protocol action may result in one batched delegatecall and many internal calls; the generic vault event is not a complete action manifest.

If richer generic telemetry becomes a product requirement, it should be handled as a separate contract/indexer proposal. A future vault event could include operation, target, value, and a data hash, but the privacy, event-cost, batching, and backward-compatibility trade-offs should be evaluated first.

## Trust and data-authority model

| Question | Authoritative source | Indexed/enrichment source |
| --- | --- | --- |
| Which modules are enabled right now? | Quai Vault `getModules()` / `isModuleEnabled()` | Quai Vault `wallet_modules` projection |
| When was a module enabled or disabled? | Vault event logs | `wallet_module_events` |
| Did a vault module execution succeed? | Vault execution event | `module_executions` |
| Is a module an officially launched DAOShip? | Official launcher provenance plus DAOShip contract | DAO Ships `ds_daos` |
| Did vault owners endorse an existing-vault DAOShip? | Vault module enablement | Joined module state |
| What proposal/action caused execution? | DAOShip events and calldata | DAO Ships proposals/indexer |
| What is the DAO name/profile? | DAO Ships metadata/Poster provenance | DAO Ships indexer |

Indexer data should always be presented with an indexed-through block. Clients making security-sensitive decisions should compare that position with the current chain head or perform a live contract read.

## Alternatives considered

### Add DAO Ships tables and handlers to the Quai Vault indexer

**Not recommended.** This would couple the Vault indexer to DAO Ships deployments, launcher upgrades, schemas, proposal types, metadata rules, and network-specific configuration. It would duplicate an existing maintained indexer and create disagreement risk between two projections of the same DAO protocol.

### Add a static DAO Ships module address

**Not viable.** Every DAOShip is a distinct clone address.

### Identify DAOShip contracts from ABI selectors or clone bytecode

**Insufficient as a trust signal.** Interface compatibility or an implementation fingerprint can help diagnostics, but it does not prove official launch provenance, the expected avatar relationship, or vault-owner endorsement.

### Use only direct RPC and skip indexer changes

**Viable for current state, insufficient for the desired product.** `getModules()` is the correct live authority, but RPC alone does not provide inexpensive historical transitions, execution activity, realtime database subscriptions, or a stable indexed-through position.

### Keep only the mutable `wallet_modules` row

**Lowest effort, but loses important audit information.** It can support a basic enabled list after the re-enable bug is corrected. The event table is recommended because module removal is an emergency/security action and repeated lifecycle transitions are operationally meaningful.

## Implementation sequence

### Phase A: correctness

1. Add a migration for `wallet_module_events` and projection ordering fields.
2. Add the atomic lifecycle RPC.
3. Update enable/disable handlers to use it.
4. Clear `disabled_at_*` during re-enable.
5. Add unit tests for idempotency, ordering, and re-enable behavior.

This is the minimum phase recommended before frontend module history depends on the indexer.

### Phase B: query contract and activity

1. Add the inventory view/RPC with freshness metadata.
2. Document module-execution field limitations.
3. Add service methods and tests for inventory and lifecycle queries.
4. Add realtime publication for the append-only event table if required by consumers.

### Phase C: backfill and reconciliation

1. Backfill `wallet_module_events` by replaying `EnabledModule` and `DisabledModule` logs from each indexed wallet's creation block.
2. Do not synthesize historical cycles from the mutable `wallet_modules` projection.
3. Compare active projections against on-chain `getModules()` for a sampled or complete wallet set.
4. Report mismatches before enabling frontend reliance on the projection.
5. Decide whether periodic reconciliation is warranted or whether deployment/backfill verification is sufficient.

The existing backfill machinery should be reused where possible. Inserts must be safe to replay.

### Phase D: consumer adoption

After the indexer contract is stable, the frontend can:

1. Render the live on-chain module list for all vault viewers.
2. Enrich it with indexed lifecycle and execution activity.
3. Resolve DAO Ships metadata from the DAO Ships indexer.
4. Show owner-only disable/re-enable controls with DAO-specific consequences.

## Acceptance criteria

### Lifecycle correctness

- An initially enabled launch module appears active.
- Enable → disable produces two immutable lifecycle events and an inactive projection.
- Enable → disable → re-enable produces three lifecycle events and an active projection with `disabled_at_* = NULL`.
- Replaying any event does not duplicate history or change counts.
- A delayed older event cannot overwrite newer projected state.
- More than one active module on a vault is returned without protocol assumptions.
- An unknown module is indexed exactly like a recognized module.

### Execution activity

- Success and failure events are independently preserved.
- Multiple module executions in one transaction are distinguished by log index.
- Queries can filter by wallet, module, and success.
- The inventory returns accurate execution aggregates.
- Unavailable execution fields remain explicitly `NULL`, not invented or inferred unsafely.

### Freshness and recovery

- Inventory consumers receive `last_indexed_block` and `last_indexed_at`.
- An orphan disable event is observable operationally and is not silently discarded.
- Backfill can be stopped and replayed without duplicates.
- A reconciliation check detects disagreement with `getModules()`.

### DAO Ships integration scenario

- A DAOShip created as an initial module appears in the generic inventory without configuring its address in the Quai Vault indexer.
- A DAO Ships row pointing at an existing vault is not shown as an active module unless the vault actually enabled that DAOShip address.
- Disabling and re-enabling DAOShip is represented correctly and retains both transitions.
- The DAO Ships indexer can be joined by transaction hash to explain a DAOShip module execution without duplicating DAO proposal data in the Vault indexer.

## Validation fixtures

At the time this proposal was prepared, a live mainnet DAO provided a useful integration fixture:

- DAOShip: `0x001117dd3c8574bc34227074472fb64349d2c3e9`
- Quai Vault/avatar: `0x005f2629a632962f4944d23686efda5c160d535b`
- Network: Quai mainnet, chain ID `9`

Direct RPC checks confirmed that `DAOShip.avatar()` matched the vault, `vault.getModules()` contained the DAOShip address, `vault.isModuleEnabled(DAOShip)` returned true, and the DAOShip's MultiSendCallOnly target was whitelisted. This fixture may change over time and should not become hardcoded application configuration; it is suitable for a documented smoke test while it remains deployed.

The maintained DAO Ships deployment table supports:

- Quai mainnet: chain ID `9`, DAO app `https://app.daoships.org`
- Orchard testnet: chain ID `15000`, DAO app `https://testnet.daoships.org`

Deployment addresses should come from maintained per-chain configuration or on-chain derivation, not older README examples.

## Operational considerations

Suggested logs and metrics:

- module lifecycle events processed by type;
- lifecycle duplicate count;
- out-of-order event count;
- disable-without-projection count;
- module projection/on-chain mismatch count;
- module execution success/failure count by module address;
- inventory query latency;
- backfill progress and indexed-through block.

Suggested alerts:

- projection/on-chain mismatches after the confirmation window;
- any persistent orphan disable event;
- a growing indexer block lag;
- repeated database failures in the atomic lifecycle RPC.

## Open questions for the indexer team

1. Should the append-only lifecycle table be included in the first delivery, or should the team first ship only the re-enable correctness fix and inventory query?
2. Does the indexer's existing ordering/reorg strategy define a preferred canonical-event pattern that this table should follow?
3. Should `enabled_at_*` become nullable so reconciliation can represent known current state with unknown historical provenance?
4. Should freshness be part of a database RPC response, or is a separately queried `indexer_state` contract sufficient?
5. Is periodic on-chain `getModules()` reconciliation desirable, or should it remain an operator/backfill verification command?
6. Should module execution aggregates be calculated in a view/RPC or left to consumers until volume justifies a maintained aggregate?
7. Are block timestamps needed in lifecycle and execution tables for UI use, or should clients resolve timestamps through existing block data?

## Sources

### Quai Vault

- [Quai Vault `QuaiVault.sol`](https://github.com/Quai-Vault/quaivault-contracts/blob/main/contracts/QuaiVault.sol) — module lifecycle, `getModules`, unrestricted module-call trust model, and delegatecall whitelist enforcement.
- [Quai Vault indexer](https://github.com/Quai-Vault/quaivault-indexer) — current event handlers, Supabase schema, module execution service, and health/freshness implementation.
- Local implementation references: [`src/events/vault-core.ts`](./src/events/vault-core.ts), [`src/events/zodiac.ts`](./src/events/zodiac.ts), [`src/services/supabase.ts`](./src/services/supabase.ts), and [`supabase/migrations/schema.sql`](./supabase/migrations/schema.sql).

### DAO Ships

- [DAO Ships features](https://daoships.org/features) — Quai Vault treasury, module execution, owner emergency brake, proposal types, and indexed transparency.
- [DAO Ships FAQ](https://daoships.org/docs/faq) — production/testnet networks, treasury model, ragequit, proposal types, and Navigator overview.
- [DAO Ships contracts](https://github.com/DAO-Ships/daoships-contracts) — protocol overview and atomic module enablement.
- [`DAOShipAndVaultLauncher.sol`](https://github.com/DAO-Ships/daoships-contracts/blob/main/contracts/core/DAOShipAndVaultLauncher.sol) — predicted clone address, initial module installation, existing-vault launch path, and MultiSendCallOnly whitelist setup.
- [`DAOShip.sol`](https://github.com/DAO-Ships/daoships-contracts/blob/main/contracts/core/DAOShip.sol) — avatar relationship, proposal execution, module-status guards, self-removal protection, and ragequit.
- [DAO Ships indexer](https://github.com/DAO-Ships/daoships-indexer) — DAO/proposal/member metadata and authenticated launch-event indexing.
- [DAO Ships app](https://github.com/DAO-Ships/daoships-app) — maintained per-chain deployments, DAO routes, bigint-safe Supabase access, and frontend data contracts.
- [EIP-1167: Minimal Proxy Contract](https://eips.ethereum.org/EIPS/eip-1167) — clone pattern used for per-DAO module instances.

