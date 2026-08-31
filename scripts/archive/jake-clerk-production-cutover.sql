-- HISTORICAL ARCHIVE — DO NOT RUN.
--
-- This file is a sanitized copy of the Jake-only Clerk Development → Production
-- identity remap that was executed on production Neon on 2026-08-28.
--
-- STATUS: Already executed. Railway Production Clerk keys were switched to
-- pk_live_ / sk_live_ after COMMIT. Remap + orphan cleanup were validated —
-- see docs/phase3-validation.md.
--
-- DO NOT re-run any section. The live UPDATE / COMMIT path is retained only
-- so the operation remains understandable. Production-specific Clerk user IDs
-- and email addresses have been replaced with placeholders. A second named
-- Agent Name was recorded as out of scope and was not modified.
--
-- If another Clerk cutover is needed later, write a new generic parameterized
-- runbook. Do not fill these placeholders and execute this file.
--
-- Coordinated cutover (already done) required immediately after COMMIT:
--   Railway CLERK_PUBLISHABLE_KEY → pk_live_...
--   Railway CLERK_SECRET_KEY      → sk_live_...
--   Redeploy same ReachMy service

-- =============================================================================
-- A. READ-ONLY PREFLIGHT (historical — already satisfied)
-- =============================================================================

-- A1) Cutover account binding — capture baseline (save this output)
SELECT
  h.handle AS agent_handle,
  a.id AS account_id,
  a.clerk_user_id,
  a.email,
  a.platform_role,
  p.id AS principal_id,
  p.display_name,
  (
    SELECT count(*)::int
    FROM agent_connections ac
    WHERE ac.principal_id = p.id
      AND ac.status = 'connected'
      AND ac.grant_id IS NOT NULL
      AND ac.grant_id NOT LIKE 'api:%'
  ) AS connected_ai_grants,
  (
    SELECT count(*)::int
    FROM relationships r
    WHERE r.principal_low_id = p.id OR r.principal_high_id = p.id
  ) AS relationship_rows,
  (
    SELECT count(*)::int
    FROM interactions i
    WHERE i.initiator_principal_id = p.id OR i.recipient_principal_id = p.id
  ) AS interaction_rows
FROM handles h
JOIN principals p ON p.id = h.principal_id
JOIN accounts a ON a.id = p.account_id
WHERE h.handle = 'CUTOVER_AGENT_HANDLE';

-- A2) Must return exactly one row for the cutover handle
SELECT h.handle, count(DISTINCT a.id) AS account_count
FROM handles h
JOIN principals p ON p.id = h.principal_id
JOIN accounts a ON a.id = p.account_id
WHERE h.handle = 'CUTOVER_AGENT_HANDLE'
GROUP BY h.handle
HAVING count(DISTINCT a.id) <> 1;
-- Expected: 0 rows

-- A3) Must return exactly one principal for the cutover account
SELECT a.id AS account_id, count(p.id) AS principal_count
FROM accounts a
JOIN principals p ON p.account_id = a.id
JOIN handles h ON h.principal_id = p.id
WHERE h.handle = 'CUTOVER_AGENT_HANDLE'
GROUP BY a.id
HAVING count(p.id) <> 1;
-- Expected: 0 rows

-- A4) Dev clerk_user_id must match the recorded Development ID
SELECT h.handle, a.clerk_user_id
FROM handles h
JOIN principals p ON p.id = h.principal_id
JOIN accounts a ON a.id = p.account_id
WHERE h.handle = 'CUTOVER_AGENT_HANDLE'
  AND a.clerk_user_id <> 'DEV_CLERK_USER_ID';
-- Expected: 0 rows (if non-zero, STOP — use exact value from A1)

-- A5) Out-of-scope account baseline — save for post-cutover unchanged check (DO NOT MODIFY)
SELECT
  h.handle AS agent_handle,
  a.id AS account_id,
  a.clerk_user_id,
  a.email,
  a.platform_role
FROM handles h
JOIN principals p ON p.id = h.principal_id
JOIN accounts a ON a.id = p.account_id
WHERE h.handle = 'UNCHANGED_AGENT_HANDLE';

-- A6) Prod clerk_user_id must not already exist on another account
SELECT id, clerk_user_id, email
FROM accounts
WHERE clerk_user_id = 'PROD_CLERK_USER_ID';
-- Expected: 0 rows

-- =============================================================================
-- B. CUTOVER REMAP (historical — already committed 2026-08-28)
-- =============================================================================

BEGIN;

UPDATE accounts
SET
  clerk_user_id = 'PROD_CLERK_USER_ID',
  updated_at = now()
WHERE id = (
  SELECT a.id
  FROM accounts a
  JOIN principals p ON p.account_id = a.id
  JOIN handles h ON h.principal_id = p.id
  WHERE h.handle = 'CUTOVER_AGENT_HANDLE'
)
  AND clerk_user_id = 'DEV_CLERK_USER_ID';

-- Must affect exactly 1 row. If 0 rows: ROLLBACK and stop.
-- GET DIAGNOSTICS: in psql use \echo or check ROW_COUNT

-- B-verify (inside transaction, before COMMIT):
SELECT h.handle, a.id AS account_id, a.clerk_user_id, a.email
FROM handles h
JOIN principals p ON p.id = h.principal_id
JOIN accounts a ON a.id = p.account_id
WHERE h.handle = 'CUTOVER_AGENT_HANDLE';
-- Expected: clerk_user_id = PROD_CLERK_USER_ID

-- Out-of-scope account unchanged (inside transaction):
SELECT h.handle, a.clerk_user_id
FROM handles h
JOIN principals p ON p.id = h.principal_id
JOIN accounts a ON a.id = p.account_id
WHERE h.handle = 'UNCHANGED_AGENT_HANDLE';
-- Expected: same Development clerk_user_id as A5 baseline

-- If anything wrong:
-- ROLLBACK;

COMMIT;

-- Immediately switch Railway to pk_live_/sk_live_ and redeploy (human step).

-- =============================================================================
-- C. ROLLBACK (historical template only — not a live runbook)
-- =============================================================================

-- BEGIN;
-- UPDATE accounts
-- SET clerk_user_id = 'DEV_CLERK_USER_ID', updated_at = now()
-- WHERE id = (
--   SELECT a.id FROM accounts a
--   JOIN principals p ON p.account_id = a.id
--   JOIN handles h ON h.principal_id = p.id
--   WHERE h.handle = 'CUTOVER_AGENT_HANDLE'
-- )
--   AND clerk_user_id = 'PROD_CLERK_USER_ID';
-- COMMIT;
-- Then restore Railway pk_test_/sk_test_ and redeploy.
