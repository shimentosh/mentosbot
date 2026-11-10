-- These system policies were written with the plain app.rls_bypass check after
-- 20261114120100_rls_bypass_key_required, so a tenant session could turn the bypass on
-- itself for these tables. Route them through the key check like every other table.
ALTER POLICY computer_network_exits_system ON "computer_network_exits"
  USING ((SELECT app_rls_bypass()));
ALTER POLICY inbox_notifications_system ON "inbox_notifications"
  USING ((SELECT app_rls_bypass()));
ALTER POLICY computer_servers_system ON "computer_servers"
  USING ((SELECT app_rls_bypass()));
