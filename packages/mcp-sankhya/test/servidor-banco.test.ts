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
  registrarChamada,
  reservarPasso,
  listarChamadas,
  resolverSessao,
  revogarSessao,
  type ConfigImportada,
  type Db,
  type SessaoLocal,
} from '@forja/banco';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aprovar, conferir, type PedidoAprovacao, type PedidoConferencia } from '../src/cli/aprovacao.js';
import { carregarConfigBanco, type ConfigServidor } from '../src/config/banco.js';
import { gravarPlano, lerPlano, verificarAssinaturaPlano } from '../src/porteiro/planos.js';
import { montarExecutor, pastaTemporaria, textoDe } from './ajuda.js';

/** Banco de testes do pacote @forja/banco (migrado pelos testes dele). Valores genéricos. */
const URL_DONO = process.env.FORJA_BANCO_TESTE_DONO_URL ?? 'postgres://forja_dono:forja-local-dono@127.0.0.1:55433/forja_teste';
const URL_APP = process.env.FORJA_BANCO_TESTE_APP_URL ?? 'postgres://forja_app:forja-local-app@127.0.0.1:55433/forja_teste';
const CHAVE_MESTRA = crypto.randomBytes(32).toString('hex');
const cofre = new CofreAesGcm(Buffer.from(CHAVE_MESTRA, 'hex'));
const SENHA = 'senha-de-teste-bem-longa';
const CHAVE_APROVACAO = 'k'.repeat(40);

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
  return { e, slug, login, segredo, sessao, ler: () => sessao };
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
    expect(m.eventos().at(-1)).toMatchObject({ usuario: x.login, usuario_id: c.usuarioId, resultado: 'aceito' });

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

describe('forja-aprovar: aprovador da sessão e TOTP a cada assinatura', () => {
  async function preparar() {
    const x = await empresaComSessao();
    const s = await resolverSessao(app, x.sessao.token);
    if (s.status !== 'valida') throw new Error('sessão de teste inválida');
    const dir = pastaTemporaria();
    gravarPlano(dir, {
      id: 'pl',
      descricao: 'plano de teste',
      passos: [{ n: 1, ferramenta: 'gravar_registros', parametros: { tabela: 'AD_X', registros: [{ A: 1 }] } }],
    });
    const saida: string[] = [];
    const pedido = (codigo: string, extra: Partial<PedidoAprovacao> = {}): PedidoAprovacao => ({
      app,
      cofre,
      sessao: s,
      chave: CHAVE_APROVACAO,
      diretorioPlanos: dir,
      id: 'pl',
      confirmarId: async () => 'pl',
      pedirCodigo: async () => codigo,
      escrever: (t) => saida.push(t),
      ...extra,
    });
    const auditoria = () => listarChamadas(app, x.e.id, new Date(0), new Date('2100-01-01'));
    return { x, s, dir, pedido, saida, auditoria };
  }
  const daqui = (s: number) => new Date(Date.now() + s * 1000);

  it('código errado: nada é gravado e a recusa vai para a auditoria', async () => {
    const { dir, pedido, auditoria, x } = await preparar();
    const r = await aprovar(pedido('000000'));
    expect(r).toMatchObject({ aprovado: false, motivo: expect.stringMatching(/TOTP inválido[\s\S]*Nada foi gravado/) });
    expect(lerPlano(dir, 'pl')!.assinatura).toBeUndefined();
    expect(await auditoria()).toMatchObject([{ ferramenta: 'forja-aprovar', resultado: 'recusado', usuario: x.login, plano_id: 'pl' }]);
  });

  it('id digitado diferente: nada é gravado e o código nem é pedido', async () => {
    const { dir, pedido } = await preparar();
    let pediu = false;
    const r = await aprovar(pedido('x', { confirmarId: async () => 'outro', pedirCodigo: async () => ((pediu = true), 'x') }));
    expect(r.aprovado).toBe(false);
    expect(pediu).toBe(false);
    expect(lerPlano(dir, 'pl')!.assinatura).toBeUndefined();
  });

  it('código certo assina com o login da sessão; o mesmo código não serve para o passo; um novo serve', async () => {
    const { x, s, dir, pedido, auditoria } = await preparar();
    const t1 = daqui(60);
    const c1 = codigoTotpAtual(x.segredo, x.login, t1);
    expect(await aprovar(pedido(c1, { agora: () => t1 }))).toEqual({ aprovado: true, aprovadoPor: x.login });
    const plano = lerPlano(dir, 'pl')!;
    expect(plano.aprovado_por).toBe(x.login);
    expect(verificarAssinaturaPlano(plano, CHAVE_APROVACAO)).toBeNull();

    // reuso do código (mesmo período): recusado
    expect(await aprovar(pedido(c1, { passo: 1, agora: () => t1 }))).toMatchObject({ aprovado: false });
    expect(lerPlano(dir, 'pl')!.passos[0]!.aprovacao).toBeUndefined();

    const t2 = daqui(90);
    expect(await aprovar(pedido(codigoTotpAtual(x.segredo, x.login, t2), { passo: 1, agora: () => t2 }))).toMatchObject({ aprovado: true });
    expect(lerPlano(dir, 'pl')!.passos[0]!.aprovacao!.aprovado_por).toBe(x.login);
    expect((await auditoria()).map((e) => `${e.resultado}:${e.motivo}`)).toEqual([
      'aceito:plano assinado',
      expect.stringMatching(/^recusado:aprovação recusada/),
      'aceito:passo 1 aprovado',
    ]);
    expect((await auditoria())[0]!.usuario_id).toBe(s.usuarioId);
  });
});

describe('forja-aprovar --conferir: fecha a reserva "em execução" sem desfecho', () => {
  async function preparar() {
    const x = await empresaComSessao();
    const s = await resolverSessao(app, x.sessao.token);
    if (s.status !== 'valida') throw new Error('sessão de teste inválida');
    const reservar = () =>
      reservarPasso(app, x.e.id, {
        ambiente: 'teste',
        ferramenta: 'marcar_obrigatorio',
        parametrosJson: '{"tabela":"AD_X","campo":"OBS"}',
        planoId: 'pc',
        passoId: 1,
      });
    const saida: string[] = [];
    const pedido = (codigo: string, extra: Partial<PedidoConferencia> = {}): PedidoConferencia => ({
      app,
      cofre,
      sessao: s,
      diretorioPlanos: pastaTemporaria(),
      id: 'pc',
      passo: 1,
      desfecho: 'feito',
      confirmarId: async () => 'pc',
      pedirCodigo: async () => codigo,
      escrever: (t) => saida.push(t),
      ...extra,
    });
    const auditoria = () => listarChamadas(app, x.e.id, new Date(0), new Date('2100-01-01'));
    return { x, reservar, pedido, saida, auditoria };
  }
  const daqui = (s: number) => new Date(Date.now() + s * 1000);

  it('sem reserva pendente: nada a conferir e o código nem é pedido', async () => {
    const { pedido } = await preparar();
    let pediu = false;
    const r = await conferir(pedido('x', { pedirCodigo: async () => ((pediu = true), 'x') }));
    expect(r).toMatchObject({ conferido: false, motivo: expect.stringMatching(/Nada a conferir/) });
    expect(pediu).toBe(false);
  });

  it('código errado: a reserva continua pendente e a recusa vai para a auditoria', async () => {
    const { reservar, pedido, auditoria } = await preparar();
    expect(await reservar()).toMatchObject({ reservado: true });
    expect(await conferir(pedido('000000'))).toMatchObject({ conferido: false });
    expect(await reservar()).toMatchObject({ reservado: false, situacao: 'em_execucao' });
    expect((await auditoria()).map((e) => e.resultado)).toEqual(['em_execucao', 'recusado']);
  });

  it('feito: o passo passa a constar como executado e não roda de novo', async () => {
    const { x, reservar, pedido, auditoria } = await preparar();
    const r1 = await reservar();
    const t = daqui(60);
    const r = await conferir(pedido(codigoTotpAtual(x.segredo, x.login, t), { agora: () => t }));
    expect(r).toEqual({ conferido: true, reservaId: (r1 as { reservaId: string }).reservaId });
    expect(await reservar()).toEqual({ reservado: false, situacao: 'executado' });
    const ultimo = (await auditoria()).at(-1)!;
    expect(ultimo).toMatchObject({ resultado: 'aceito', motivo: 'executado (conferência manual)', ferramenta: 'marcar_obrigatorio', usuario: x.login });
  });

  it('nao-feito: grava erro e libera o passo para uma nova reserva', async () => {
    const { x, reservar, pedido } = await preparar();
    await reservar();
    const t = daqui(60);
    expect(await conferir(pedido(codigoTotpAtual(x.segredo, x.login, t), { desfecho: 'nao-feito', agora: () => t }))).toMatchObject({ conferido: true });
    expect(await reservar()).toMatchObject({ reservado: true });
  });
});
