-- Jake-only Clerk Development → Production identity remap (production Neon).
-- STATUS: Executed successfully 2026-08-28. Railway Production Clerk keys live.
-- Remap + orphan cleanup validated — see docs/phase3-validation.md.
-- DO NOT re-run Section B unless performing a controlled rollback (Section C).
--
-- Margot (@margot_botberg) is OUT OF SCOPE — do not modify her rows.
--
-- Coordinated cutover requires IMMEDIATELY after COMMIT:
--   Railway CLERK_PUBLISHABLE_KEY → pk_live_...
--   Railway CLERK_SECRET_KEY      → sk_live_...
--   Redeploy same ReachMy service
--
-- IDs (confirm exact Dev string in preflight — Clerk subs are usually user_…):
--   Dev:  user_3I4GEMsFuxECI5ZDo0o7dAgvbuV   (verify in Neon preflight)
--   Prod: user_3IWJr7h5jpvnmAs8DA3BJmnjAF1

-- =============================================================================
-- A. READ-ONLY PREFLIGHT (run first; all must pass before remap)
-- =============================================================================

-- A1) Jake account binding — capture baseline (save this output)
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
WHERE h.handle = 'jakebotberg';

-- A2) Must return exactly one row for jakebotberg
SELECT h.handle, count(DISTINCT a.id) AS account_count
FROM handles h
JOIN principals p ON p.id = h.principal_id
JOIN accounts a ON a.id = p.account_id
WHERE h.handle = 'jakebotberg'
GROUP BY h.handle
HAVING count(DISTINCT a.id) <> 1;
-- Expected: 0 rows

-- A3) Must return exactly one principal for Jake's account
SELECT a.id AS account_id, count(p.id) AS principal_count
FROM accounts a
JOIN principals p ON p.account_id = a.id
JOIN handles h ON h.principal_id = p.id
WHERE h.handle = 'jakebotberg'
GROUP BY a.id
HAVING count(p.id) <> 1;
-- Expected: 0 rows

-- A4) Dev clerk_user_id must match expected (replace if preflight shows different prefix)
SELECT h.handle, a.clerk_user_id
FROM handles h
JOIN principals p ON p.id = h.principal_id
JOIN accounts a ON a.id = p.account_id
WHERE h.handle = 'jakebotberg'
  AND a.clerk_user_id <> 'user_3I4GEMsFuxECI5ZDo0o7dAgvbuV';
-- Expected: 0 rows (if non-zero, STOP — use exact value from A1)

-- A5) Margot baseline — save for post-cutover unchanged check (DO NOT MODIFY)
SELECT
  h.handle AS agent_handle,
  a.id AS account_id,
  a.clerk_user_id,
  a.email,
  a.platform_role
FROM handles h
JOIN principals p ON p.id = h.principal_id
JOIN accounts a ON a.id = p.account_id
WHERE h.handle = 'margot_botberg';

-- A6) Prod clerk_user_id must not already exist on another account
SELECT id, clerk_user_id, email
FROM accounts
WHERE clerk_user_id = 'user_3IWJr7h5jpvnmAs8DA3BJmnjAF1';
-- Expected: 0 rows

-- =============================================================================
-- B. JAKE REMAP (execute only during approved cutover window)
-- =============================================================================

BEGIN;

UPDATE accounts
SET
  clerk_user_id = 'user_3IWJr7h5jpvnmAs8DA3BJmnjAF1',
  updated_at = now()
WHERE id = (
  SELECT a.id
  FROM accounts a
  JOIN principals p ON p.account_id = a.id
  JOIN handles h ON h.principal_id = p.id
  WHERE h.handle = 'jakebotberg'
)
  AND clerk_user_id = 'user_3I4GEMsFuxECI5ZDo0o7dAgvbuV';

-- Must affect exactly 1 row. If 0 rows: ROLLBACK and stop.
-- GET DIAGNOSTICS: in psql use \echo or check ROW_COUNT

-- B-verify (inside transaction, before COMMIT):
SELECT h.handle, a.id AS account_id, a.clerk_user_id, a.email
FROM handles h
JOIN principals p ON p.id = h.principal_id
JOIN accounts a ON a.id = p.account_id
WHERE h.handle = 'jakebotberg';
-- Expected: clerk_user_id = user_3IWJr7h5jpvnmAs8DA3BJmnjAF1

-- Margot unchanged (inside transaction):
SELECT h.handle, a.clerk_user_id
FROM handles h
JOIN principals p ON p.id = h.principal_id
JOIN accounts a ON a.id = p.account_id
WHERE h.handle = 'margot_botberg';
-- Expected: same dev clerk_user_id as A5 baseline

-- If anything wrong:
-- ROLLBACK;

COMMIT;

-- Immediately switch Railway to pk_live_/sk_live_ and redeploy (human step).

-- =============================================================================
-- C. ROLLBACK (only if cutover fails before stable Prod sign-in; requires Dev keys on Railway)
-- =============================================================================

-- BEGIN;
-- UPDATE accounts
-- SET clerk_user_id = 'user_3I4GEMsFuxECI5ZDo0o7dAgvbuV', updated_at = now()
-- WHERE id = (
--   SELECT a.id FROM accounts a
--   JOIN principals p ON p.account_id = a.id
--   JOIN handles h ON h.principal_id = p.id
--   WHERE h.handle = 'jakebotberg'
-- )
--   AND clerk_user_id = 'user_3IWJr7h5jpvnmAs8DA3BJmnjAF1';
-- COMMIT;
-- Then restore Railway pk_test_/sk_test_ and redeploy.
