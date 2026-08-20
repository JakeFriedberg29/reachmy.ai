-- One-time ReachMy platform-admin promotion (production).
-- Do not run until explicitly approved.
--
-- 1. Find your account UUID, e.g.:
--    SELECT id, email, clerk_user_id, platform_role
--    FROM accounts
--    WHERE email = 'you@example.com';
--    -- or: WHERE clerk_user_id = 'user_...';
--
-- 2. Replace YOUR_ACCOUNT_UUID below, then run in Neon / psql.

UPDATE accounts
SET
  platform_role = 'admin',
  updated_at = now()
WHERE id = 'YOUR_ACCOUNT_UUID'
  AND platform_role = 'user';

-- Verify:
-- SELECT id, email, clerk_user_id, platform_role FROM accounts WHERE id = 'YOUR_ACCOUNT_UUID';
