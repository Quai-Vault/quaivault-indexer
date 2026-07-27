-- ============================================================================
-- 000 — Backfill missing public.recovery_status enum values
-- ============================================================================
--
-- ⚠️ RUN THIS ALONE, BEFORE 001. See "Why this must run on its own" below.
--
-- THE PROBLEM
--
-- schema.sql declares the enum with five values:
--
--   CREATE TYPE public.recovery_status AS ENUM
--     ('pending', 'executed', 'cancelled', 'invalidated', 'expired');
--
-- but that CREATE is guarded by `IF NOT EXISTS`. The live type was created by an
-- earlier schema version with only ('pending', 'executed', 'cancelled') and has
-- never been updated, because — unlike `transaction_status` and
-- `transaction_type`, which both have ALTER TYPE ... ADD VALUE catch-up blocks
-- further up schema.sql — `recovery_status` never got one. Re-running schema.sql
-- does not fix it: the guarded CREATE is skipped and there is nothing else to
-- add the values.
--
-- Verified 2026-07-27 on all three live schemas (mainnet, testnet, dev):
-- `invalidated` and `expired` are both MISSING. Every other enum is complete.
--
-- WHAT IT BREAKS
--
-- This is a live indexer bug, independent of KNOWN_DATA_GAPS.md:
--
--   src/events/social-recovery.ts:212  writes status 'expired'      (RecoveryExpiredEvent)
--   src/events/social-recovery.ts:192  writes status 'invalidated'
--
-- Both fail against the live database with
--   22P02: invalid input value for enum recovery_status
-- and processBlockRange catches per-event errors and *skips* the event, so the
-- failure is silent — logged as "Failed to process event, skipping", never retried.
--
-- This makes Gap 2's recovery half worse than KNOWN_DATA_GAPS.md described. The
-- doc said an un-cleaned recovery stays `pending` because nobody calls
-- `expireRecovery`. In fact, even when somebody DOES call it, the indexer cannot
-- record the result. The row stays `pending` either way.
--
-- WHY THIS MUST RUN ON ITS OWN
--
-- A new enum value cannot be USED in the same transaction that adds it. Migration
-- 001 creates a view containing `'expired'::public.recovery_status`, so it must
-- run in a later transaction than this one. Run this file, let it commit, then
-- run 001.
--
-- Safe to re-run. Idempotent. Additive — adds labels to a type, touches no rows.
-- ============================================================================

DO $$
BEGIN
    -- Add 'invalidated' to recovery_status enum
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'invalidated'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'recovery_status')
    ) THEN
        ALTER TYPE public.recovery_status ADD VALUE 'invalidated';
        RAISE NOTICE 'added ''invalidated'' to public.recovery_status';
    ELSE
        RAISE NOTICE '''invalidated'' already present in public.recovery_status';
    END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
    -- Add 'expired' to recovery_status enum
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'expired'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'recovery_status')
    ) THEN
        ALTER TYPE public.recovery_status ADD VALUE 'expired';
        RAISE NOTICE 'added ''expired'' to public.recovery_status';
    ELSE
        RAISE NOTICE '''expired'' already present in public.recovery_status';
    END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- Post-check — run separately. Expect all five labels, in this order:
--   pending, executed, cancelled, invalidated, expired
-- ============================================================================
--
--   SELECT e.enumlabel, e.enumsortorder
--   FROM pg_enum e
--   JOIN pg_type t ON t.oid = e.enumtypid
--   WHERE t.typname = 'recovery_status'
--   ORDER BY e.enumsortorder;
