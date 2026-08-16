# DAO Ships Module Indexing Implementation Plan

**Status:** Completed and independently audited (2026-08-15)  
**Scope:** Generic Quai Vault module support required by DAO Ships and future Zodiac-compatible modules  
**Source proposal:** [`DAO_SHIPS_MODULE_INDEXING_PROPOSAL.md`](./DAO_SHIPS_MODULE_INDEXING_PROPOSAL.md)

## Outcome

The Quai Vault indexer will expose a durable, protocol-neutral inventory of every module observed on a vault. It will preserve module enable/disable history, keep the current projection correctly ordered, expose freshness and execution activity through a stable query, support replayable historical backfill, and provide an on-chain reconciliation command.

DAO Ships identity, governance, profiles, members, proposals, and decoded actions remain owned by the DAO Ships indexer. No DAO Ships address, ABI, credential, or protocol-specific table is added here.

## Workstreams

### 1. Durable lifecycle model

- Add append-only `wallet_module_events`, uniquely keyed by wallet, transaction, and log index.
- Store block number, block hash, transaction hash, log index, event type, and ingestion time.
- Extend `wallet_modules` with deterministic last-event provenance.
- Allow nullable enable provenance so an observed orphan disable is representable without inventing history.
- Add an atomic `apply_wallet_module_event` database function that:
  - deduplicates replayed logs;
  - preserves out-of-order historical events without allowing them to replace newer state;
  - clears stale disable metadata on re-enable;
  - records orphan disables as known-inactive projections;
  - updates projection timestamps;
  - returns an explicit result (`applied`, `duplicate`, `out_of_order`, or `orphan_applied`).
- Restrict the mutating function to `service_role`.

### 2. Delivery and reorg correctness

- Propagate handler/database failures to the block loop so a failed event prevents checkpoint advancement.
- Keep intentionally rejected malformed events explicit in their handlers; do not conflate them with transient write failures.
- Add atomic module rollback/reconstruction for targeted maintenance.
- Replace the incomplete general reorg rollback with a correctness-first full indexed-data rebuild from `START_BLOCK`. Deep rebuild is expensive but reorgs inside the confirmed range are exceptional, and serving silently corrupted mutable projections is unacceptable.
- Clear and reseed in-memory wallet/token tracking after a rebuild.

### 3. Consumer query contract

- Add `get_wallet_module_inventory(wallet)` returning one JSON envelope containing:
  - explicit wallet-indexed status so an unknown wallet is not confused with an empty inventory;
  - indexed-through block, timestamp, and sync state;
  - current module state and lifecycle provenance;
  - execution totals, success/failure totals, and latest execution provenance.
- Add typed service methods for inventory access.
- Preserve direct public table access and realtime subscriptions.
- Return module execution log indexes and allow filtering for either success or failure.

### 4. Backfill and reconciliation

- Add a dedicated module-lifecycle backfill command that scans only `EnabledModule` and `DisabledModule` logs.
- Scan known wallets from `START_BLOCK` so pre-registration history for imported vaults is not omitted.
- Do not modify global `indexer_state` during lifecycle backfill.
- Make the command restartable through database idempotency and ordering guards.
- Add a read-only reconciliation command comparing indexed active modules with `vault.getModules()`.
- Exit non-zero and report exact differences when mismatches exist.

### 5. Verification

- Unit-test enable, disable, block/log provenance, and error propagation.
- Add static migration verification for required tables, columns, functions, policies, grants, indexes, and realtime setup.
- Extend live E2E expectations for initial enable, enable-disable-re-enable, execution outcomes, and execution log indexes.
- Exercise duplicate replay, replay collisions, ordering, orphan repair, multiple unknown modules, rollback, inventory existence, and function privileges against PostgreSQL in CI.
- Run unit tests, typecheck, lint, build, coverage, dependency audit, and migration verification in CI.
- Run the proposal's live DAO Ships fixture as an operator smoke test when deployment credentials are available; never hardcode it into runtime configuration.

### 6. Review findings outside module behavior

- Repair the lint failure and make CI enforce lint.
- Install the missing Vitest coverage provider and make coverage runnable.
- Update vulnerable dependencies within compatible ranges and report any residual advisories.
- Align Docker, Compose, scripts, and application health-port defaults on `8080`.
- Remove or replace broken README references.
- Add a repository CI workflow.
- Document that the generic module execution event does not contain target/value/calldata details.

## Security and authority rules

- Live `getModules()` / `isModuleEnabled()` remains authoritative for security-sensitive decisions.
- Indexed state is always returned with freshness metadata.
- Unknown modules remain visible and are not assigned trusted identities heuristically.
- DAO Ships launch provenance is enrichment, not proof that vault owners enabled a module.
- Database lifecycle writes are service-only; inventory reads remain public.
- Backfill and reconciliation never synthesize lifecycle events.

## Delivery phases

1. **Correctness foundation:** migration, lifecycle RPC, ordered projection, durable failure propagation, reorg rebuild.
2. **Query and tooling:** inventory RPC/service, execution query fixes, module backfill, reconciliation.
3. **Verification and operations:** tests, CI, dependency/coverage/lint cleanup, documentation, deployment smoke test.
4. **Independent audit:** security, stability/recovery, and efficiency/succinctness reviews; resolve all material findings before declaring completion.

## Completion criteria

- Enable → disable → re-enable yields three immutable events and an active projection with cleared disable metadata.
- Replays do not duplicate history or change counts.
- Older events cannot replace newer projected state.
- Orphan disables are observable without false enable provenance.
- A failed lifecycle write cannot be checkpointed as processed.
- Module state is reconstructed correctly after targeted rollback; a general confirmed-range reorg triggers a visible full rebuild.
- Inventory includes freshness and correct execution aggregates.
- Backfill is restartable and reconciliation detects on-chain disagreement.
- DAOShip initial modules require no indexer address configuration.
- Unit, type, lint, build, coverage, audit, and migration checks complete with documented results.

## Independent audit outcome

Security, stability/recovery, and efficiency/succinctness reviewers audited the
implemented plan and repository diff independently. All blockers and material
findings within this module delivery were resolved before completion; the inherited
project-wide service credential constraint is recorded separately below:

- imported `WalletRegistered` history is awaited and tied to checkpoint success;
- module backfill covers imported vaults from `START_BLOCK`, supports explicit
  resumable block ranges, and hash-fences each batch;
- inventory explicitly distinguishes unindexed wallets from empty inventories;
- reconciliation uses the indexed block tag and rejects syncing or moving snapshots;
- startup validates persisted hashes before catch-up, range processing is fenced
  before/after, and a mismatch requires three consistent reads before reset;
- destructive rebuilds use an advisory lock and expected-checkpoint compare-and-set;
- replay identity collisions fail instead of being silently accepted as duplicates;
- orphan disable provenance is repaired when older enable history arrives;
- migration discovery requires a full QuaiVault marker set instead of a table-name match;
- inventory latest-execution lookup and rollback/query indexes avoid full ordered arrays;
- execution queries have deterministic ordering and bounded pagination;
- CI executes the schema and upgrade migration against PostgreSQL and tests behavior
  and effective privileges, in addition to static checks.

## Verification record

- TypeScript typecheck: pass.
- ESLint with zero warnings allowed: pass.
- Unit tests: 123/123 pass across 13 files.
- Coverage command and 20% regression floors: pass (26.74% statements,
  26.71% branches, 31.93% functions, 27.76% lines).
- Production build: pass.
- Static module migration verification: pass.
- PostgreSQL fresh-schema, migration, lifecycle, collision, orphan repair,
  rollback, inventory, privilege, and fenced-reset verification: pass.
- Full dependency audit, including development dependencies: 0 vulnerabilities.
- Live network E2E/DAO Ships fixture: not run locally because deployment wallet,
  RPC, and Supabase credentials were not supplied; the operator procedure remains
  documented and the existing live E2E suite was extended.

## Residual operational constraints

- The existing Supabase `service_role` credential is project-wide. Mutators are
  hidden from public/authenticated roles and resets are checkpoint-fenced, but a
  compromised service key still has the inherited broad database authority. A
  dedicated PostgREST/JWT ingestion role should precede hostile multi-tenant use.
- Confirmed-range reorg recovery intentionally trades availability for correctness
  by rebuilding from `START_BLOCK`; large deployments should plan for a maintenance
  window and monitor database/WAL pressure.
- Complete lifecycle recovery for imported vaults is RPC-intensive. Operators can
  split/restart it with `MODULE_BACKFILL_FROM` and `MODULE_BACKFILL_TO`.
