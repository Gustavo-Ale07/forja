import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  autenticar,
  buscarLogin,
  codigoTotpAtual,
  CofreAesGcm,
  comEmpresa,
  criarBanco,
  criarEmpresa,
  criarSessao,
  definirSenha,
  definirTotp,
  importarConfig,
  novoSegredoTotp,
  revogarSessao,
  type ConfigImportada,
  type Db,
  type SessaoLocal,
} from '@forja/banco';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { carregarConfigBanco, type ConfigServidor } from '../src/config/banco.js';
import { montarExecutor, pastaTemporaria, textoDe } from './ajuda.js';

/** Banco de testes do pacote @forja/banco (migrado pelos testes dele). Valores genéricos. */
const URL_DONO = process.env.FORJA_BANCO_TESTE_DONO_URL ?? 'postgres://forja_dono:forja-local-dono@127.0.0.1:55433/forja_teste';
const URL_APP = process.env.FORJA_BANCO_TESTE_APP_URL ?? 'postgres://forja_app:forja-local-app@127.0.0.1:55433/forja_teste';
const CHAVE_MESTRA = crypto.randomBytes(32).toString('hex');
const cofre = new CofreAesGcm(Buffer.from(CHAVE_MESTRA, 'hex'));
const SENHA = 'senha-de-teste-bem-longa';

let dono: Db;
let app: Db;
const abertos: ConfigServidor[] = [];

beforeAll(() => {
  dono = criarBanco(URL_DONO, 2);
  app = criarBanco(URL_APP, 2);
});

afterAll(async () => {
  await Promise.all(abertos.map((c) => c.app.destroy()));
  await dono.destroy();
  await app.destroy();
});

function raiz(env: Record<string, string> = {}): string {
  const r = pastaTemporaria();
  const tudo = { FORJA_DATABASE_URL: URL_APP, FORJA_CHAVE_MESTRA: CHAVE_MESTRA, FORJA_CHAVE_APROVACAO: 'k'.repeat(40), ...env };
  fs.writeFileSync(path.join(r, '.env'), Object.entries(tudo).map(([k, v]) => `${k}=${v}`).join('\n'));
  return r;
}

/** Empresa importada como pelo forja-admin, com um usuário ativado e uma sessão aberta. */
async function empresaComSessao() {
  const slug = `srv-${crypto.randomBytes(3).toString('hex')}`;
  const login = `dev_${slug}`;
  const e = await criarEmpresa(dono, { nome: 'Servidor', slug });
  const cfg: ConfigImportada = {
    fuso: 'America/Sao_Paulo',
    ambiente: {
      url: `https://${slug}-teste.sankhyacloud.com.br`,
      hostPermitido: `${slug}-teste.sankhyacloud.com.br`,
      usuarioBancoEsperado: 'usuario_teste',
      gatewayUrl: 'https://api.sandbox.sankhya.com.br',
    },
    perfis: [{ nome: 'dev', ambientes: ['teste'], acoes: { teste: { ler_dicionario: 'livre', consultar_sql: 'livre' } }, tabelasBloqueadas: [] }],
    usuarios: { [login]: 'dev' },
    regras: { limiteRegistros: 50, leituraBloqueada: ['TSI*'], gravacaoNativaLiberada: [] },
    instancias: {},
    credenciais: {
      web_usuario: 'usuario.falso',
      web_senha: 'senha-falsa',
      gateway_client_id: 'id-falso',
      gateway_client_secret: 'segredo-falso-456',
      gateway_token: 'xtoken-falso-789',
    },
  };
  await importarConfig(dono, cofre, e.id, cfg);
  const achado = (await buscarLogin(dono, login))!;
  const { segredo } = novoSegredoTotp(login);
  await comEmpresa(dono, e.id, async (trx) => {
    await definirSenha(trx, achado.usuario_id, SENHA);
    await definirTotp(trx, cofre, e.id, achado.usuario_id, segredo);
  });
  const t = new Date();
  const u = await autenticar(app, cofre, { login, senha: SENHA, codigo: codigoTotpAtual(segredo, login, t) }, t);
  const s = await criarSessao(app, u, t);
  const sessao: SessaoLocal = { token: s.token, login, expira_em: s.expiraEm.toISOString() };
  return { e, slug, login, sessao, ler: () => sessao };
}

async function subir(r: string, ler: () => SessaoLocal | undefined): Promise<ConfigServidor> {
  const c = await carregarConfigBanco({ raiz: r, lerSessao: ler });
  abertos.push(c);
  return c;
}

const erroDe = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('devia ter recusado');
};

describe('servidor MCP a partir do banco', () => {
  it('sobe com sessão válida: usuário, permissões, ambiente e credenciais vêm do banco', async () => {
    const x = await empresaComSessao();
    const c = await subir(raiz(), x.ler);
    expect(c.login).toBe(x.login);
    expect(c.empresaId).toBe(x.e.id);
    expect(c.arquivo.usuarios).toEqual({ [x.login]: 'dev' });
    expect(c.arquivo.perfis.dev!.acoes.teste).toEqual({ ler_dicionario: 'livre', consultar_sql: 'livre' });
    expect(c.configAmbiente).toEqual({
      host_permitido: `${x.slug}-teste.sankhyacloud.com.br`,
      usuario_banco_esperado: 'USUARIO_TESTE',
      gateway_url: 'https://api.sandbox.sankhya.com.br',
      somente_leitura: false,
    });
    expect(c.credenciais).toMatchObject({ url: `https://${x.slug}-teste.sankhyacloud.com.br`, senha: 'senha-falsa', xToken: 'xtoken-falso-789' });
  });

  it('sem sessão, ou com sessão revogada: não sobe e diz para rodar o login', async () => {
    expect(await erroDe(subir(raiz(), () => undefined))).toMatch(/recusou iniciar[\s\S]*Nenhuma sessão[\s\S]*forja-admin login/);
    const x = await empresaComSessao();
    await revogarSessao(app, x.sessao.token);
    expect(await erroDe(subir(raiz(), x.ler))).toMatch(/encerrada[\s\S]*forja-admin login/);
  });

  it('FORJA_AMBIENTE, FORJA_PROD*, chave curta e chave mestra ausente: recusa sem vazar segredo', async () => {
    const x = await empresaComSessao();
    const msg = await erroDe(
      subir(raiz({ FORJA_AMBIENTE: 'producao', FORJA_PROD_URL: 'https://x.exemplo.com', FORJA_CHAVE_APROVACAO: 'curta', FORJA_CHAVE_MESTRA: '' }), x.ler),
    );
    expect(msg).toMatch(/só "teste"/);
    expect(msg).toMatch(/FORJA_PROD_URL/);
    expect(msg).toMatch(/32 caracteres/);
    expect(msg).toMatch(/FORJA_CHAVE_MESTRA não definido/);
    expect(msg).not.toContain('curta');
  });

  it('trava de produção sobre o ambiente gravado no banco (Gateway fora da lista)', async () => {
    const x = await empresaComSessao();
    await comEmpresa(dono, x.e.id, (trx) => trx.updateTable('ambiente').set({ gateway_url: 'https://gateway.malicioso.com' }).execute());
    expect(await erroDe(subir(raiz(), x.ler))).toMatch(/não é um host do Gateway/);
  });

  it('credencial faltando no banco: recusa, sem mostrar as outras', async () => {
    const x = await empresaComSessao();
    await comEmpresa(dono, x.e.id, (trx) => trx.deleteFrom('credencial').where('tipo', '=', 'gateway_token').execute());
    const msg = await erroDe(subir(raiz(), x.ler));
    expect(msg).toMatch(/faltando no banco: gateway_token/);
    expect(msg).not.toContain('segredo-falso-456');
  });

  it('a cada chamada: permissões relidas do banco; logout derruba na hora', async () => {
    const x = await empresaComSessao();
    const c = await subir(raiz(), x.ler);
    const m = montarExecutor({ usuario: x.login, identidade: c.identidade });

    const ok = await m.executor.chamar('ler_dicionario', { tabela: 'TGFPAR' });
    expect(ok.isError).toBeUndefined();

    // o admin bloqueia a ação no banco: vale na próxima chamada, sem reiniciar
    await comEmpresa(dono, x.e.id, (trx) => trx.updateTable('perfil_permissao').set({ nivel: 'bloqueado' }).where('acao', '=', 'ler_dicionario').execute());
    const bloqueada = await m.executor.chamar('ler_dicionario', { tabela: 'TGFPAR' });
    expect(textoDe(bloqueada)).toMatch(/regra 4[\s\S]*bloqueada/);

    await revogarSessao(app, x.sessao.token);
    const r = await m.executor.chamar('consultar_sql', { sql: 'SELECT 1 FROM DUAL' });
    expect(textoDe(r)).toMatch(/RECUSADO pelo porteiro \[regra 1[\s\S]*encerrada[\s\S]*forja-admin login/);
    expect(m.eventos().at(-1)).toMatchObject({ ferramenta: 'consultar_sql', resultado: 'recusado' });
  });

  it('sessão de outra empresa no meio do caminho: recusa', async () => {
    const a = await empresaComSessao();
    const b = await empresaComSessao();
    let atual = a.sessao;
    const c = await subir(raiz(), () => atual);
    atual = b.sessao;
    await expect(c.identidade()).rejects.toThrow(/outra empresa/);
  });
});
