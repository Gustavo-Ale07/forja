#!/bin/sh
# Roda uma vez, como superusuário, na primeira subida do volume.
#   forja_dono  : dono das tabelas; roda migrações e o forja-admin. NÃO é superusuário e NÃO tem
#                 BYPASSRLS: com FORCE ROW LEVEL SECURITY, também só enxerga a empresa do contexto.
#   forja_app   : usado pelo MCP e pelo login. Sem superusuário, sem BYPASSRLS, só os GRANTs das migrações.
#   forja_login : sem login; dono das funções SECURITY DEFINER de login/sessão (precisa de BYPASSRLS
#                 para achar o usuário antes de saber a empresa). Nunca conecta.
set -eu

psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres \
  -v senha_dono="$FORJA_PG_SENHA_DONO" -v senha_app="$FORJA_PG_SENHA_APP" <<'SQL'
CREATE ROLE forja_dono  LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'senha_dono';
CREATE ROLE forja_app   LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'senha_app';
CREATE ROLE forja_login NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
-- o dono precisa poder transferir as funções de login para forja_login
GRANT forja_login TO forja_dono;
CREATE DATABASE forja       OWNER forja_dono;
CREATE DATABASE forja_teste OWNER forja_dono;
SQL

for db in forja forja_teste; do
  psql -v ON_ERROR_STOP=1 --username postgres --dbname "$db" <<SQL
REVOKE ALL ON DATABASE $db FROM PUBLIC;
GRANT CONNECT ON DATABASE $db TO forja_app;
ALTER SCHEMA public OWNER TO forja_dono;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL
done
