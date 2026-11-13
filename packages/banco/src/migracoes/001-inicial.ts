/**
 * 001 — Esquema multiempresa da Forja.
 *
 * Isolamento entre empresas:
 *  - toda tabela tem empresa_id (a própria `empresa` usa id) e RLS com FORCE, inclusive para o dono;
 *  - a empresa do contexto vem de `SET LOCAL forja.empresa_id` (função forja_empresa_atual());
 *    sem contexto, nenhuma linha aparece e nenhum INSERT passa;
 *  - referências entre tabelas usam chave composta (empresa_id, id): uma linha da empresa A não
 *    consegue apontar para um perfil/ambiente/usuário da empresa B.
 *
 * Trava de fase 2: o único ambiente aceito é "teste" (CHECK), além da trava do código.
 * Auditoria (chamada_ferramenta): forja_app só tem SELECT/INSERT; gatilhos barram UPDATE, DELETE e
 * TRUNCATE para qualquer papel.
 */
export const SQL_001 = String.raw`
CREATE FUNCTION forja_empresa_atual() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = pg_catalog
  AS $$ SELECT nullif(current_setting('forja.empresa_id', true), '')::uuid $$;

CREATE TABLE empresa (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome       text NOT NULL CHECK (length(nome) BETWEEN 1 AND 200),
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  fuso       text NOT NULL DEFAULT 'America/Sao_Paulo',
  criada_em  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE perfil (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresa(id),
  nome       text NOT NULL CHECK (nome ~ '^[a-z0-9_][a-z0-9_-]{0,62}$'),
  descricao  text,
  UNIQUE (empresa_id, nome),
  UNIQUE (empresa_id, id)
);

CREATE TABLE ambiente (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id             uuid NOT NULL REFERENCES empresa(id),
  nome                   text NOT NULL CHECK (nome = 'teste'),   -- trava da fase 2
  url                    text NOT NULL CHECK (url ~ '^https://'),
  host_permitido         text NOT NULL CHECK (host_permitido = lower(host_permitido) AND length(host_permitido) >= 3),
  usuario_banco_esperado text NOT NULL CHECK (usuario_banco_esperado = upper(usuario_banco_esperado) AND length(usuario_banco_esperado) >= 1),
  gateway_url            text NOT NULL CHECK (gateway_url ~ '^https://'),
  somente_leitura        boolean NOT NULL DEFAULT false,
  duas_aprovacoes        boolean NOT NULL DEFAULT false,
  criado_em              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, nome),
  UNIQUE (empresa_id, id)
);

CREATE TABLE usuario (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id       uuid NOT NULL REFERENCES empresa(id),
  login            text NOT NULL UNIQUE CHECK (login ~ '^[a-z0-9][a-z0-9._@-]{1,99}$'),
  nome             text NOT NULL,
  perfil_id        uuid NOT NULL,
  senha_hash       text,
  totp_cifrado     text,
  ativo            boolean NOT NULL DEFAULT true,
  tentativas_falhas integer NOT NULL DEFAULT 0 CHECK (tentativas_falhas >= 0),
  bloqueado_ate    timestamptz,
  criado_em        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  FOREIGN KEY (empresa_id, perfil_id) REFERENCES perfil(empresa_id, id)
);

CREATE TABLE sessao (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid NOT NULL REFERENCES empresa(id),
  usuario_id  uuid NOT NULL,
  token_hash  bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  criada_em   timestamptz NOT NULL DEFAULT now(),
  expira_em   timestamptz NOT NULL,
  revogada_em timestamptz,
  FOREIGN KEY (empresa_id, usuario_id) REFERENCES usuario(empresa_id, id)
);

CREATE TABLE perfil_ambiente (
  empresa_id  uuid NOT NULL REFERENCES empresa(id),
  perfil_id   uuid NOT NULL,
  ambiente_id uuid NOT NULL,
  PRIMARY KEY (perfil_id, ambiente_id),
  FOREIGN KEY (empresa_id, perfil_id) REFERENCES perfil(empresa_id, id),
  FOREIGN KEY (empresa_id, ambiente_id) REFERENCES ambiente(empresa_id, id)
);

CREATE TABLE perfil_permissao (
  empresa_id  uuid NOT NULL REFERENCES empresa(id),
  perfil_id   uuid NOT NULL,
  ambiente_id uuid NOT NULL,
  acao        text NOT NULL CHECK (acao ~ '^[a-z][a-z0-9_]{0,62}$'),
  nivel       text NOT NULL CHECK (nivel IN ('livre', 'com_aprovacao', 'bloqueado')),
  PRIMARY KEY (perfil_id, ambiente_id, acao),
  FOREIGN KEY (empresa_id, perfil_id) REFERENCES perfil(empresa_id, id),
  FOREIGN KEY (empresa_id, ambiente_id) REFERENCES ambiente(empresa_id, id)
);

CREATE TABLE perfil_tabela_bloqueada (
  empresa_id uuid NOT NULL REFERENCES empresa(id),
  perfil_id  uuid NOT NULL,
  padrao     text NOT NULL CHECK (padrao ~ '^[A-Z][A-Z0-9_$#]*\*?$'),
  PRIMARY KEY (perfil_id, padrao),
  FOREIGN KEY (empresa_id, perfil_id) REFERENCES perfil(empresa_id, id)
);

CREATE TABLE credencial (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    uuid NOT NULL REFERENCES empresa(id),
  ambiente_id   uuid NOT NULL,
  tipo          text NOT NULL CHECK (tipo IN ('web_usuario', 'web_senha', 'gateway_client_id', 'gateway_client_secret', 'gateway_token')),
  cifrado       text NOT NULL,
  versao_chave  integer NOT NULL CHECK (versao_chave >= 1),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ambiente_id, tipo),
  FOREIGN KEY (empresa_id, ambiente_id) REFERENCES ambiente(empresa_id, id)
);

CREATE TABLE regra (
  empresa_id               uuid PRIMARY KEY REFERENCES empresa(id),
  horario_inicio           time,
  horario_fim              time,
  dias                     smallint[] NOT NULL DEFAULT '{1,2,3,4,5}' CHECK (dias <@ '{0,1,2,3,4,5,6}'),
  limite_registros         integer NOT NULL DEFAULT 50 CHECK (limite_registros > 0),
  leitura_bloqueada        text[] NOT NULL DEFAULT '{TSI*}',
  gravacao_nativa_liberada text[] NOT NULL DEFAULT '{}',
  CHECK ((horario_inicio IS NULL) = (horario_fim IS NULL))
);

CREATE TABLE instancia_tabela (
  empresa_id uuid NOT NULL REFERENCES empresa(id),
  tabela     text NOT NULL CHECK (tabela = upper(tabela)),
  instancia  text NOT NULL,
  PRIMARY KEY (empresa_id, tabela)
);

CREATE TABLE chamada_ferramenta (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa_id   uuid NOT NULL REFERENCES empresa(id),
  data_hora    timestamptz NOT NULL DEFAULT now(),
  usuario_id   uuid,
  usuario      text,
  perfil       text,
  ambiente     text NOT NULL,
  ferramenta   text NOT NULL,
  parametros   jsonb NOT NULL,
  plano_id     text,
  passo_id     integer,
  resultado    text NOT NULL CHECK (resultado IN ('aceito', 'recusado', 'erro')),
  motivo       text NOT NULL,
  antes        jsonb,
  depois       jsonb,
  captura_path text
);
CREATE INDEX ix_chamada_empresa_data  ON chamada_ferramenta (empresa_id, data_hora);
CREATE INDEX ix_chamada_empresa_plano ON chamada_ferramenta (empresa_id, plano_id, passo_id);

-- Auditoria só INSERT: vale para qualquer papel (inclusive o dono), além dos GRANTs.
CREATE FUNCTION forja_auditoria_so_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$ BEGIN RAISE EXCEPTION 'auditoria só aceita INSERT (% bloqueado)', TG_OP; END $$;
CREATE TRIGGER chamada_sem_update_delete BEFORE UPDATE OR DELETE ON chamada_ferramenta
  FOR EACH ROW EXECUTE FUNCTION forja_auditoria_so_insert();
CREATE TRIGGER chamada_sem_truncate BEFORE TRUNCATE ON chamada_ferramenta
  FOR EACH STATEMENT EXECUTE FUNCTION forja_auditoria_so_insert();

-- RLS com FORCE em tudo.
ALTER TABLE empresa ENABLE ROW LEVEL SECURITY;
ALTER TABLE empresa FORCE ROW LEVEL SECURITY;
CREATE POLICY empresa_isolada ON empresa
  USING (id = forja_empresa_atual()) WITH CHECK (id = forja_empresa_atual());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['perfil', 'ambiente', 'usuario', 'sessao', 'perfil_ambiente', 'perfil_permissao',
                           'perfil_tabela_bloqueada', 'credencial', 'regra', 'instancia_tabela', 'chamada_ferramenta']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (empresa_id = forja_empresa_atual()) WITH CHECK (empresa_id = forja_empresa_atual())',
                   t || '_isolada', t);
  END LOOP;
END $$;

-- Permissões do app (MCP e login): leitura da configuração, só INSERT na auditoria.
GRANT USAGE ON SCHEMA public TO forja_app;
GRANT EXECUTE ON FUNCTION forja_empresa_atual() TO forja_app;
GRANT SELECT ON empresa, perfil, ambiente, usuario, perfil_ambiente, perfil_permissao, perfil_tabela_bloqueada,
                credencial, regra, instancia_tabela TO forja_app;
GRANT UPDATE (tentativas_falhas, bloqueado_ate) ON usuario TO forja_app;
GRANT SELECT, INSERT ON sessao TO forja_app;
GRANT UPDATE (revogada_em) ON sessao TO forja_app;
GRANT SELECT, INSERT ON chamada_ferramenta TO forja_app;
REVOKE EXECUTE ON FUNCTION forja_auditoria_so_insert() FROM PUBLIC;
`;
