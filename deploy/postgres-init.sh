#!/bin/sh
set -eu
export APP_PASSWORD="$(cat /run/secrets/db_app_password)"
export OWNER_PASSWORD="$(cat /run/secrets/db_owner_password)"
export BACKUP_PASSWORD="$(cat /run/secrets/db_backup_password)"
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --no-psqlrc --set ON_ERROR_STOP=1 <<'SQL'
\getenv app_password APP_PASSWORD
\getenv owner_password OWNER_PASSWORD
\getenv backup_password BACKUP_PASSWORD
CREATE ROLE omnihub_owner LOGIN PASSWORD :'owner_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE omnihub_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE omnihub_backup LOGIN PASSWORD :'backup_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT pg_read_all_data TO omnihub_backup;
ALTER ROLE omnihub_backup SET default_transaction_read_only = on;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO omnihub_owner;
GRANT USAGE ON SCHEMA public TO omnihub_app;
ALTER DEFAULT PRIVILEGES FOR ROLE omnihub_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO omnihub_app;
ALTER DEFAULT PRIVILEGES FOR ROLE omnihub_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO omnihub_app;
ALTER DEFAULT PRIVILEGES FOR ROLE omnihub_owner IN SCHEMA public GRANT USAGE ON TYPES TO omnihub_app;
SQL
unset APP_PASSWORD OWNER_PASSWORD BACKUP_PASSWORD
