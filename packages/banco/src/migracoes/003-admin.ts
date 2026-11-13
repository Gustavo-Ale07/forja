/**
 * 003 — Administração.
 *
 * - Login aceita "_" (usuários vindos do forja.config.yaml, como "seu_usuario").
 * - O forja-admin (papel dono) precisa achar uma empresa pelo slug antes de ter o contexto dela;
 *   a RLS esconde tudo sem contexto, então há funções SECURITY DEFINER só para o dono, nos
 *   mesmos moldes da 002 (donas: forja_login, search_path fixo, nomes qualificados).
 */
export const SQL_003 = String.raw`
ALTER TABLE usuario DROP CONSTRAINT usuario_login_check;
ALTER TABLE usuario ADD CONSTRAINT usuario_login_check CHECK (login ~ '^[a-z0-9][a-z0-9_.@-]{1,99}$');

CREATE FUNCTION forja_empresa_por_slug(p_slug text)
  RETURNS TABLE (id uuid, nome text, slug text, fuso text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT e.id, e.nome, e.slug, e.fuso FROM public.empresa e WHERE e.slug = lower(btrim(p_slug)) $$;

CREATE FUNCTION forja_listar_empresas()
  RETURNS TABLE (id uuid, nome text, slug text, fuso text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT e.id, e.nome, e.slug, e.fuso FROM public.empresa e ORDER BY e.slug $$;

GRANT SELECT (id, nome, slug, fuso) ON empresa TO forja_login;

GRANT CREATE ON SCHEMA public TO forja_login;
ALTER FUNCTION forja_empresa_por_slug(text) OWNER TO forja_login;
ALTER FUNCTION forja_listar_empresas() OWNER TO forja_login;
REVOKE CREATE ON SCHEMA public FROM forja_login;

REVOKE ALL ON FUNCTION forja_empresa_por_slug(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION forja_listar_empresas() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION forja_empresa_por_slug(text) TO forja_dono;
GRANT EXECUTE ON FUNCTION forja_listar_empresas() TO forja_dono;
GRANT EXECUTE ON FUNCTION forja_buscar_login(text) TO forja_dono;
`;
