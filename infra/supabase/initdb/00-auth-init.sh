#!/bin/bash
# LOCAL DEV ONLY. Runs once on a fresh Postgres data dir (/docker-entrypoint-initdb.d).
#
# GoTrue creates tables INSIDE the `auth` schema and issues UNQUALIFIED queries relying on
# search_path=auth, so it must connect as a role whose search_path is `auth`. This creates that role
# (supabase_auth_admin) with the SAME password GoTrue uses (compose passes ${POSTGRES_PASSWORD}).
#
# This MUST be a shell script (not plain .sql) so the role password tracks POSTGRES_PASSWORD — a .sql
# initdb file gets no env substitution, which would hard-code the password and break GoTrue's DB login
# whenever POSTGRES_PASSWORD != that literal. (Assumes a password with no single-quote char.)
set -e

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname "${POSTGRES_DB:-postgres}" <<EOSQL
CREATE SCHEMA IF NOT EXISTS auth;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO \$\$ BEGIN
  CREATE ROLE supabase_auth_admin LOGIN PASSWORD '${POSTGRES_PASSWORD}' SUPERUSER;
EXCEPTION WHEN duplicate_object THEN
  ALTER ROLE supabase_auth_admin WITH LOGIN PASSWORD '${POSTGRES_PASSWORD}' SUPERUSER;
END \$\$;

ALTER ROLE supabase_auth_admin SET search_path = auth;
ALTER SCHEMA auth OWNER TO supabase_auth_admin;
EOSQL
