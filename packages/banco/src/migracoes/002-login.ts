/**
 * 002 — Login e sessão.
 *
 * O login precisa achar o usuário ANTES de saber a empresa (a RLS esconde tudo sem contexto).
 * Para isso há duas funções SECURITY DEFINER, donas: forja_login (BYPASSRLS, sem login), que
 * devolvem só ids — nunca hash de senha nem segredo TOTP. O resto (hash, TOTP, tentativas) é lido
 * depois, já no contexto da empresa, sob RLS.
 *
 * search_path fixo (pg_catalog, pg_temp) e nomes qualificados (public.x): um objeto criado em outro
 * esquema não consegue sequestrar a função.
 */
export const SQL_002 = String.raw`
ALTER TABLE usuario ADD COLUMN totp_ultimo_passo bigint NOT NULL DEFAULT 0;
GRANT UPDATE (totp_ultimo_passo) ON usuario TO forja_app;

CREATE FUNCTION forja_buscar_login(p_login text)
  RETURNS TABLE (usuario_id uuid, empresa_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT u.id, u.empresa_id FROM public.usuario u WHERE u.login = lower(btrim(p_login)) $$;

CREATE FUNCTION forja_resolver_sessao(p_token_hash bytea)
  RETURNS TABLE (sessao_id uuid, usuario_id uuid, empresa_id uuid, expira_em timestamptz, revogada_em timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT s.id, s.usuario_id, s.empresa_id, s.expira_em, s.revogada_em
        FROM public.sessao s WHERE s.token_hash = p_token_hash $$;

-- forja_login lê só as colunas de que as funções precisam.
GRANT USAGE ON SCHEMA public TO forja_login;
GRANT SELECT (id, empresa_id, login) ON usuario TO forja_login;
GRANT SELECT (id, usuario_id, empresa_id, token_hash, expira_em, revogada_em) ON sessao TO forja_login;

-- Transfere as funções para forja_login (CREATE no esquema só durante a transferência).
GRANT CREATE ON SCHEMA public TO forja_login;
ALTER FUNCTION forja_buscar_login(text) OWNER TO forja_login;
ALTER FUNCTION forja_resolver_sessao(bytea) OWNER TO forja_login;
REVOKE CREATE ON SCHEMA public FROM forja_login;

REVOKE ALL ON FUNCTION forja_buscar_login(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION forja_resolver_sessao(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION forja_buscar_login(text) TO forja_app;
GRANT EXECUTE ON FUNCTION forja_resolver_sessao(bytea) TO forja_app;
`;
