import crypto from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buscarEmpresa,
  criarEmpresa,
  criarUsuario,
  exigirEmpresa,
  importarConfig,
  lerAmbiente,
  listarEmpresas,
  type ConfigImportada,
} from '../src/admin.js';
import { CofreAesGcm } from '../src/cofre.js';
import { comEmpresa, criarBanco, type Db } from '../src/conexao.js';
import { URL_APP, URL_DONO } from './urls.js';

let dono: Db;
let app: Db;
const cofre = new CofreAesGcm(crypto.randomBytes(32));
const sufixo = () => crypto.randomBytes(3).toString('hex');

function config(slug: string, extra: Partial<ConfigImportada> = {}): ConfigImportada {
  return {
    fuso: 'America/Sao_Paulo',
    ambiente: {
      url: `https://${slug}-teste.exemplo.com.br`,
      hostPermitido: `${slug}-teste.exemplo.com.br`,
      usuarioBancoEsperado: 'usuario_teste',
      gatewayUrl: 'https://api.sandbox.sankhya.com.br',
    },
    perfis: [
      {
        nome: 'desenvolvedor',
        descricao: 'Dev',
        ambientes: ['teste'],
        acoes: { teste: { consultar_sql: 'livre', gravar_registros: 'com_aprovacao' } },
        tabelasBloqueadas: ['tgffin'],
      },
    ],
    usuarios: { [`dev_${slug}`]: 'desenvolvedor' },
    regras: { horario: { inicio: '07:00', fim: '20:00', dias: [1, 2, 3, 4, 5] }, limiteRegistros: 50, leituraBloqueada: ['TSI*'], gravacaoNativaLiberada: [] },
    instancias: { ad_exemplo: 'Exemplo' },
    credenciais: {
      web_usuario: 'usuario.falso',
      web_senha: 'senha-falsa',
      gateway_client_id: 'id-falso',
      gateway_client_secret: 'segredo-falso',
      gateway_token: 'xtoken-falso',
    },
    ...extra,
  };
}

beforeAll(() => {
  dono = criarBanco(URL_DONO);
  app = criarBanco(URL_APP);
});

afterAll(async () => {
  await dono.destroy();
  await app.destroy();
});

describe('empresa', () => {
  it('cria, acha pelo slug e lista', async () => {
    const slug = `adm-${sufixo()}`;
    const e = await criarEmpresa(dono, { nome: 'Empresa Exemplo', slug });
    expect(await buscarEmpresa(dono, slug.toUpperCase())).toEqual(e);
    expect((await listarEmpresas(dono)).map((x) => x.slug)).toContain(slug);
  });

  it('recusa slug repetido, slug inválido e fuso inválido', async () => {
    const slug = `rep-${sufixo()}`;
    await criarEmpresa(dono, { nome: 'X', slug });
    await expect(criarEmpresa(dono, { nome: 'X', slug })).rejects.toThrow(/Já existe/);
    await expect(criarEmpresa(dono, { nome: 'X', slug: 'Com Espaço' })).rejects.toThrow(/Slug inválido/);
    await expect(criarEmpresa(dono, { nome: 'X', slug: `fz-${sufixo()}`, fuso: 'Lugar/Nenhum' })).rejects.toThrow(/Fuso/);
  });

  it('empresa inexistente: mensagem com o comando para criar', async () => {
    await expect(exigirEmpresa(dono, 'nao-existe-nada')).rejects.toThrow(/forja-admin empresa criar/);
  });

  it('o app não executa as funções de busca de empresa', async () => {
    await expect(sql`SELECT * FROM forja_listar_empresas()`.execute(app)).rejects.toThrow(/permission denied/);
    await expect(sql`SELECT * FROM forja_empresa_por_slug('x')`.execute(app)).rejects.toThrow(/permission denied/);
  });

  it('funções novas: donas forja_login, search_path fixo, sem EXECUTE público', async () => {
    const r = await sql<{ prosecdef: boolean; dono: string; proconfig: string[]; publico: boolean }>`
      SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS dono, p.proconfig,
             has_function_privilege('public', p.oid, 'EXECUTE') AS publico
      FROM pg_proc p WHERE p.proname IN ('forja_empresa_por_slug', 'forja_listar_empresas')`.execute(dono);
    expect(r.rows).toHaveLength(2);
    for (const f of r.rows) expect(f).toEqual({ prosecdef: true, dono: 'forja_login', proconfig: ['search_path=pg_catalog, pg_temp'], publico: false });
  });
});

describe('importar config', () => {
  it('grava tudo; credenciais cifradas e legíveis pelo app', async () => {
    const slug = `imp-${sufixo()}`;
    const e = await criarEmpresa(dono, { nome: 'Importada', slug });
    const r = await importarConfig(dono, cofre, e.id, config(slug));
    expect(r).toEqual({
      perfis: ['desenvolvedor'],
      permissoes: 2,
      usuariosNovos: [`dev_${slug}`],
      usuariosAtualizados: [],
      credenciais: ['web_usuario', 'web_senha', 'gateway_client_id', 'gateway_client_secret', 'gateway_token'],
      instancias: 1,
    });

    const visto = await comEmpresa(app, e.id, async (trx) => ({
      permissoes: await trx.selectFrom('perfil_permissao').select(['acao', 'nivel']).orderBy('acao').execute(),
      bloqueadas: await trx.selectFrom('perfil_tabela_bloqueada').select('padrao').execute(),
      regra: await trx.selectFrom('regra').selectAll().executeTakeFirstOrThrow(),
      instancias: await trx.selectFrom('instancia_tabela').select(['tabela', 'instancia']).execute(),
      usuario: await trx.selectFrom('usuario').select(['login', 'senha_hash', 'totp_cifrado']).executeTakeFirstOrThrow(),
      cifrados: await trx.selectFrom('credencial').select('cifrado').execute(),
    }));
    expect(visto.permissoes).toEqual([
      { acao: 'consultar_sql', nivel: 'livre' },
      { acao: 'gravar_registros', nivel: 'com_aprovacao' },
    ]);
    expect(visto.bloqueadas).toEqual([{ padrao: 'TGFFIN' }]);
    expect(visto.regra).toMatchObject({ horario_inicio: '07:00:00', horario_fim: '20:00:00', dias: [1, 2, 3, 4, 5], limite_registros: 50 });
    expect(visto.instancias).toEqual([{ tabela: 'AD_EXEMPLO', instancia: 'Exemplo' }]);
    expect(visto.usuario).toEqual({ login: `dev_${slug}`, senha_hash: null, totp_cifrado: null });
    for (const c of visto.cifrados) expect(c.cifrado).not.toMatch(/falso|falsa/);

    const amb = await lerAmbiente(app, cofre, e.id);
    expect(amb).toMatchObject({ usuarioBancoEsperado: 'USUARIO_TESTE', credenciais: { web_senha: 'senha-falsa', gateway_token: 'xtoken-falso' } });
  });

  it('rodar de novo atualiza e não duplica; credenciais ausentes ficam como estavam', async () => {
    const slug = `re-${sufixo()}`;
    const e = await criarEmpresa(dono, { nome: 'Reimportada', slug });
    await importarConfig(dono, cofre, e.id, config(slug));
    const c2 = config(slug, { credenciais: {} });
    c2.perfis[0]!.acoes = { teste: { ler_dicionario: 'livre' } };
    const r = await importarConfig(dono, cofre, e.id, c2);
    expect(r.usuariosNovos).toEqual([]);
    expect(r.usuariosAtualizados).toEqual([`dev_${slug}`]);
    expect(r.credenciais).toEqual([]);
    const perms = await comEmpresa(app, e.id, (trx) => trx.selectFrom('perfil_permissao').select('acao').execute());
    expect(perms).toEqual([{ acao: 'ler_dicionario' }]);
    expect((await lerAmbiente(app, cofre, e.id))!.credenciais.web_senha).toBe('senha-falsa');
  });

  it('erro no meio desfaz tudo (perfil de usuário inexistente)', async () => {
    const slug = `tx-${sufixo()}`;
    const e = await criarEmpresa(dono, { nome: 'Transacao', slug });
    await expect(importarConfig(dono, cofre, e.id, config(slug, { usuarios: { [`u_${slug}`]: 'nao_existe' } }))).rejects.toThrow(/Perfil "nao_existe"/);
    const n = await comEmpresa(dono, e.id, (trx) => trx.selectFrom('perfil').select('id').execute());
    expect(n).toEqual([]);
    expect(await lerAmbiente(dono, cofre, e.id)).toBeUndefined();
  });

  it('ambiente diferente de teste é recusado', async () => {
    const slug = `pr-${sufixo()}`;
    const e = await criarEmpresa(dono, { nome: 'Prod', slug });
    const c = config(slug);
    c.perfis[0]!.ambientes = ['producao'];
    await expect(importarConfig(dono, cofre, e.id, c)).rejects.toThrow(/só "teste"/);
  });

  it('login de outra empresa não é tomado', async () => {
    const a = await criarEmpresa(dono, { nome: 'A', slug: `la-${sufixo()}` });
    const b = await criarEmpresa(dono, { nome: 'B', slug: `lb-${sufixo()}` });
    const login = `compartilhado_${sufixo()}`;
    await importarConfig(dono, cofre, a.id, config(a.slug, { usuarios: { [login]: 'desenvolvedor' } }));
    await expect(importarConfig(dono, cofre, b.id, config(b.slug, { usuarios: { [login]: 'desenvolvedor' } }))).rejects.toThrow(/outra empresa/);
  });
});

describe('usuario criar', () => {
  it('cria com perfil existente; recusa perfil inexistente e login repetido', async () => {
    const slug = `uc-${sufixo()}`;
    const e = await criarEmpresa(dono, { nome: 'Usuarios', slug });
    await importarConfig(dono, cofre, e.id, config(slug, { usuarios: {} }));
    const login = `Nova.Pessoa-${sufixo()}`;
    const id = await comEmpresa(dono, e.id, (trx) => criarUsuario(dono, trx, { empresaId: e.id, login, nome: 'Nova Pessoa', perfil: 'desenvolvedor' }));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      comEmpresa(dono, e.id, (trx) => criarUsuario(dono, trx, { empresaId: e.id, login, nome: 'X', perfil: 'desenvolvedor' })),
    ).rejects.toThrow(/já existe/);
    await expect(
      comEmpresa(dono, e.id, (trx) => criarUsuario(dono, trx, { empresaId: e.id, login: `o-${sufixo()}`, nome: 'X', perfil: 'gerente' })),
    ).rejects.toThrow(/Existentes: desenvolvedor/);
    await expect(
      comEmpresa(dono, e.id, (trx) => criarUsuario(dono, trx, { empresaId: e.id, login: 'com espaço', nome: 'X', perfil: 'desenvolvedor' })),
    ).rejects.toThrow(/Login inválido/);
  });
});
