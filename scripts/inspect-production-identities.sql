-- Read-only identity inspection.
-- Fill the handle placeholders, then run in the Neon SQL Editor against the
-- intended branch. Do not execute writes. Safe to run multiple times.
--
-- This script does not bypass production database safety. Local and CI runs
-- already refuse the production Neon endpoint unless ALLOW_PRODUCTION_DB=1
-- (see src/config.ts `PRODUCTION_NEON_ENDPOINT_ID` / `assertSafeDatabaseUrl`).

-- Replace these placeholders before running. Remove unused entries from each
-- IN list if inspecting a single Agent Name.
--   'AGENT_HANDLE_1'
--   'AGENT_HANDLE_2'

-- 1) One row per Agent Name — account binding + counts only
SELECT
  h.handle AS agent_handle,
  a.email,
  a.clerk_user_id,
  a.platform_role,
  (SELECT count(*)::int FROM principals p WHERE p.account_id = a.id) AS principal_count,
  (
    SELECT count(*)::int
    FROM agent_connections ac
    JOIN principals p ON p.id = ac.principal_id
    WHERE p.account_id = a.id
      AND ac.status = 'connected'
      AND ac.grant_id IS NOT NULL
      AND ac.grant_id NOT LIKE 'api:%'
  ) AS connected_ai_grants,
  (
    SELECT count(*)::int
    FROM relationships r
    JOIN principals p ON p.account_id = a.id
    WHERE r.principal_low_id = p.id OR r.principal_high_id = p.id
  ) AS relationship_rows,
  (
    SELECT count(*)::int
    FROM interactions i
    JOIN principals p ON p.account_id = a.id
    WHERE i.initiator_principal_id = p.id OR i.recipient_principal_id = p.id
  ) AS interaction_rows
FROM handles h
JOIN principals p ON p.id = h.principal_id
JOIN accounts a ON a.id = p.account_id
WHERE h.handle IN ('AGENT_HANDLE_1', 'AGENT_HANDLE_2')
ORDER BY h.handle;

-- 2) Sanity: exactly one account per handle (must return zero rows)
SELECT h.handle, count(DISTINCT a.id) AS account_count
FROM handles h
JOIN principals p ON p.id = h.principal_id
JOIN accounts a ON a.id = p.account_id
WHERE h.handle IN ('AGENT_HANDLE_1', 'AGENT_HANDLE_2')
GROUP BY h.handle
HAVING count(DISTINCT a.id) <> 1;

-- 3) Sanity: no duplicate emails among these accounts (must return zero rows)
SELECT a.email, count(*) AS account_count
FROM accounts a
WHERE a.email IS NOT NULL
  AND a.id IN (
    SELECT p.account_id
    FROM handles h
    JOIN principals p ON p.id = h.principal_id
    WHERE h.handle IN ('AGENT_HANDLE_1', 'AGENT_HANDLE_2')
  )
GROUP BY a.email
HAVING count(*) > 1;
