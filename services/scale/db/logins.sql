-- scale_api : full access for the Web.API service.
-- inspector : read-only (db_datareader), used by the website's table viewer.
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = 'scale_api')
  CREATE LOGIN scale_api WITH PASSWORD = '$(API_PW)', CHECK_POLICY = OFF;
ELSE
  ALTER LOGIN scale_api WITH PASSWORD = '$(API_PW)', CHECK_POLICY = OFF;

IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = 'inspector')
  CREATE LOGIN inspector WITH PASSWORD = '$(RO_PW)', CHECK_POLICY = OFF;
ELSE
  ALTER LOGIN inspector WITH PASSWORD = '$(RO_PW)', CHECK_POLICY = OFF;
GO

IF DB_ID(N'$(DB)') IS NULL
BEGIN
  PRINT 'Database $(DB) is not attached; skipping user setup.';
  SET NOEXEC ON;
END
GO

USE [$(DB)];
-- An attached database may carry orphaned users with these names.
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'scale_api')
  ALTER USER scale_api WITH LOGIN = scale_api;
ELSE
  CREATE USER scale_api FOR LOGIN scale_api;
ALTER ROLE db_owner ADD MEMBER scale_api;

IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'inspector')
  ALTER USER inspector WITH LOGIN = inspector;
ELSE
  CREATE USER inspector FOR LOGIN inspector;
ALTER ROLE db_datareader ADD MEMBER inspector;
GO

SET NOEXEC OFF;
GO
