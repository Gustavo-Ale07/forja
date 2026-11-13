import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comEmpresa, criarBanco, type Db } from '../src/conexao.js';
import { criarEmpresaCompleta, TABELAS_COM_EMPRESA, type EmpresaDeTeste } from './ajuda.js';
import { URL_APP, URL_DONO } from './urls.js';

let dono: Db;
let app: Db;
let A: EmpresaDeTeste;
let B: EmpresaDeTeste;

beforeAll(async () => {
  dono = criarBanco(URL_DONO);
  app = criarBanco(URL_APP);
  A = await criarEmpresaCompleta(dono, 'a');
  B = await criarEmpresaCompleta(dono, 'b');
});

afterAll(async () => {
  await dono.destroy();
  await app.destroy();
});

type Linha = { empresa: string };

/** Lê, como `db` e no contexto de `empresa`, a coluna de empresa de todas as linhas visíveis de `tabela`. */
async function linhasVisiveis(db: Db, empresa: string | undefined, tabela: keyof typeof TABELAS_COM_EMPRESA): Promise<string[]> {
  const coluna = TABELAS_COM_EMPRESA[tabela];
  const consulta = sql<Linha>`SELECT ${sql.ref(coluna)}::text AS empresa FROM ${sql.table(tabela)}`;
  const r = empresa
    ? await comEmpresa(db, empresa, (trx) => consulta.execute(trx))
    : await db.transaction().execute((trx) => consulta.execute(trx));
  return r.rows.map((l) => l.empresa);
}

describe('papéis do Postgres', () => {
  it('forja_app e forja_dono não são superusuários nem têm BYPASSRLS', async () => {
    const r = await sql<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>`
      SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('forja_app', 'forja_dono') ORDER BY rolname`.execute(dono);
    expect(r.rows).toEqual([
      { rolname: 'forja_app', rolsuper: false, rolbypassrls: false },
      { rolname: 'forja_dono', rolsuper: false, rolbypassrls: false },
    ]);
  });

  it('todas as tabelas com empresa têm RLS ligada e FORCE', async () => {
    const r = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname <> ALL (ARRAY['kysely_migration', 'kysely_migration_lock'])
      ORDER BY relname`.execute(dono);
    expect(r.rows.map((x) => x.relname).sort()).toEqual(Object.keys(TABELAS_COM_EMPRESA).sort());
    for (const t of r.rows) expect([t.relname, t.relrowsecurity, t.relforcerowsecurity]).toEqual([t.relname, true, true]);
  });
});

describe('RLS: empresa A não enxerga nenhuma linha da empresa B', () => {
  for (const tabela of Object.keys(TABELAS_COM_EMPRESA) as Array<keyof typeof TABELAS_COM_EMPRESA>) {
    it(`${tabela}: o app no contexto de A só vê A; no de B só vê B`, async () => {
      const vistasA = await linhasVisiveis(app, A.id, tabela);
      const vistasB = await linhasVisiveis(app, B.id, tabela);
      expect(vistasA.length).toBeGreaterThan(0);
      expect(vistasB.length).toBeGreaterThan(0);
      expect(new Set(vistasA)).toEqual(new Set([A.id]));
      expect(new Set(vistasB)).toEqual(new Set([B.id]));
    });

    it(`${tabela}: sem contexto de empresa, nenhuma linha (app e dono)`, async () => {
      expect(await linhasVisiveis(app, undefined, tabela)).toEqual([]);
      expect(await linhasVisiveis(dono, undefined, tabela)).toEqual([]);
    });

    it(`${tabela}: FORCE vale para o dono — no contexto de A, nada de B`, async () => {
      expect(new Set(await linhasVisiveis(dono, A.id, tabela))).toEqual(new Set([A.id]));
    });
  }

  it('filtro explícito pela empresa B, no contexto de A, devolve zero', async () => {
    const r = await comEmpresa(app, A.id, (trx) =>
      trx.selectFrom('usuario').select('login').where('empresa_id', '=', B.id).execute(),
    );
    expect(r).toEqual([]);
    const porId = await comEmpresa(app, A.id, (trx) => trx.selectFrom('usuario').select('login').where('id', '=', B.usuarioId).execute());
    expect(porId).toEqual([]);
  });

  it('no contexto de A, o dono não grava linha com empresa_id de B (WITH CHECK)', async () => {
    await expect(
      comEmpresa(dono, A.id, (trx) => trx.insertInto('perfil').values({ empresa_id: B.id, nome: 'intruso', descricao: null }).execute()),
    ).rejects.toThrow(/row-level security/);
  });

  it('no contexto de A, UPDATE e DELETE em linhas de B não afetam nada', async () => {
    const r = await comEmpresa(dono, A.id, async (trx) => {
      const u = await trx.updateTable('perfil').set({ descricao: 'alterado' }).where('empresa_id', '=', B.id).executeTakeFirst();
      const d = await trx.deleteFrom('instancia_tabela').where('empresa_id', '=', B.id).executeTakeFirst();
      return [Number(u.numUpdatedRows), Number(d.numDeletedRows)];
    });
    expect(r).toEqual([0, 0]);
    const intacto = await comEmpresa(dono, B.id, (trx) => trx.selectFrom('instancia_tabela').select('tabela').execute());
    expect(intacto).toHaveLength(1);
  });

  it('uma linha de A não referencia perfil/ambiente de B (chave composta)', async () => {
    await expect(
      comEmpresa(dono, A.id, (trx) =>
        trx
          .insertInto('usuario')
          .values({ empresa_id: A.id, login: `cruzado-${A.slug}`, nome: 'X', perfil_id: B.perfilId, senha_hash: null, totp_cifrado: null })
          .execute(),
      ),
    ).rejects.toThrow(/foreign key/);
    await expect(
      comEmpresa(dono, A.id, (trx) =>
        trx.insertInto('perfil_ambiente').values({ empresa_id: A.id, perfil_id: A.perfilId, ambiente_id: B.ambienteId }).execute(),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('empresa_id inválido no contexto é recusado antes de ir ao banco', async () => {
    await expect(comEmpresa(app, "x' OR 1=1 --", async () => 1)).rejects.toThrow(/empresa_id inválido/);
  });
});

describe('permissões do app', () => {
  it('o app não altera configuração (perfil, ambiente, credencial)', async () => {
    await expect(
      comEmpresa(app, A.id, (trx) => trx.insertInto('perfil').values({ empresa_id: A.id, nome: 'novo', descricao: null }).execute()),
    ).rejects.toThrow(/permission denied/);
    await expect(
      comEmpresa(app, A.id, (trx) => trx.updateTable('ambiente').set({ somente_leitura: true }).execute()),
    ).rejects.toThrow(/permission denied/);
    await expect(
      comEmpresa(app, A.id, (trx) => trx.updateTable('credencial').set({ cifrado: 'x' }).execute()),
    ).rejects.toThrow(/permission denied/);
  });

  it('o app não troca a senha de um usuário (só tentativas/bloqueio)', async () => {
    await expect(
      comEmpresa(app, A.id, (trx) => trx.updateTable('usuario').set({ senha_hash: 'x' }).execute()),
    ).rejects.toThrow(/permission denied/);
    const r = await comEmpresa(app, A.id, (trx) => trx.updateTable('usuario').set({ tentativas_falhas: 0 }).executeTakeFirst());
    expect(Number(r.numUpdatedRows)).toBe(1);
  });
});

describe('auditoria só INSERT', () => {
  const evento = (empresa: string) => ({
    empresa_id: empresa,
    usuario_id: null,
    usuario: 'fulano',
    perfil: 'desenvolvedor',
    ambiente: 'teste',
    ferramenta: 'ler_dicionario',
    parametros: JSON.stringify({ tabela: 'AD_EXEMPLO' }),
    plano_id: null,
    passo_id: null,
    resultado: 'aceito' as const,
    motivo: 'executado',
    antes: null,
    depois: null,
    captura_path: null,
  });

  it('o app insere e lê na própria empresa', async () => {
    const id = await comEmpresa(app, A.id, async (trx) => {
      const r = await trx.insertInto('chamada_ferramenta').values(evento(A.id)).returning('id').executeTakeFirstOrThrow();
      return r.id;
    });
    expect(id).toBeTruthy();
  });

  it('o app não grava auditoria em nome de outra empresa', async () => {
    await expect(comEmpresa(app, A.id, (trx) => trx.insertInto('chamada_ferramenta').values(evento(B.id)).execute())).rejects.toThrow(
      /row-level security/,
    );
  });

  it('o app: UPDATE, DELETE e TRUNCATE são negados por permissão', async () => {
    await expect(comEmpresa(app, A.id, (trx) => trx.updateTable('chamada_ferramenta').set({ motivo: 'x' }).execute())).rejects.toThrow(
      /permission denied/,
    );
    await expect(comEmpresa(app, A.id, (trx) => trx.deleteFrom('chamada_ferramenta').execute())).rejects.toThrow(/permission denied/);
    await expect(comEmpresa(app, A.id, (trx) => sql`TRUNCATE chamada_ferramenta`.execute(trx))).rejects.toThrow(/permission denied/);
  });

  it('nem o dono altera: o gatilho barra UPDATE, DELETE e TRUNCATE', async () => {
    await expect(comEmpresa(dono, A.id, (trx) => trx.updateTable('chamada_ferramenta').set({ motivo: 'x' }).execute())).rejects.toThrow(
      /auditoria só aceita INSERT/,
    );
    await expect(comEmpresa(dono, A.id, (trx) => trx.deleteFrom('chamada_ferramenta').execute())).rejects.toThrow(
      /auditoria só aceita INSERT/,
    );
    await expect(comEmpresa(dono, A.id, (trx) => sql`TRUNCATE chamada_ferramenta`.execute(trx))).rejects.toThrow(
      /auditoria só aceita INSERT/,
    );
  });
});

describe('trava de fase 2 no banco', () => {
  it('ambiente diferente de "teste" ou sem https é recusado pelo próprio banco', async () => {
    const base = {
      empresa_id: A.id,
      url: 'https://x-teste.sankhyacloud.com.br',
      host_permitido: 'x-teste.sankhyacloud.com.br',
      usuario_banco_esperado: 'X',
      gateway_url: 'https://api.sandbox.sankhya.com.br',
    };
    await expect(comEmpresa(dono, A.id, (trx) => trx.insertInto('ambiente').values({ ...base, nome: 'producao' }).execute())).rejects.toThrow(
      /check constraint/,
    );
    await expect(
      comEmpresa(dono, A.id, (trx) => trx.updateTable('ambiente').set({ url: 'http://sem-tls-teste.sankhyacloud.com.br' }).execute()),
    ).rejects.toThrow(/check constraint/);
    await expect(
      comEmpresa(dono, A.id, (trx) => trx.updateTable('ambiente').set({ nome: 'producao' }).execute()),
    ).rejects.toThrow(/check constraint/);
  });
});
