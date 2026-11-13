import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CofreAesGcm } from '../src/cofre.js';
import { comEmpresa, criarBanco, type Db } from '../src/conexao.js';
import {
  autenticar,
  BLOQUEIO_MS,
  codigoTotpAtual,
  confirmarTotp,
  criarSessao,
  definirSenha,
  definirTotp,
  ErroLogin,
  hashSenha,
  MAX_TENTATIVAS,
  novoSegredoTotp,
  resolverSessao,
  revogarSessao,
  type SessaoValida,
} from '../src/login.js';
import { raizRepositorio } from '../src/env.js';
import {
  apagarSessaoLegada,
  apagarSessaoLocal,
  arquivoSessao,
  arquivoSessaoLegado,
  gravarSessaoLocal,
  lerSessaoLocal,
} from '../src/sessao-local.js';
import { criarEmpresaCompleta, type EmpresaDeTeste } from './ajuda.js';
import { URL_APP, URL_DONO } from './urls.js';

let dono: Db;
let app: Db;
let A: EmpresaDeTeste;
let B: EmpresaDeTeste;
const cofre = new CofreAesGcm(crypto.randomBytes(32));
const SENHA = 'senha-de-teste-bem-longa';

/** Cria um usuário com senha e TOTP. Devolve login e segredo. */
async function novoUsuario(E: EmpresaDeTeste, nome: string): Promise<{ id: string; login: string; segredo: string }> {
  const login = `${nome}-${crypto.randomBytes(3).toString('hex')}`;
  const { segredo } = novoSegredoTotp(login);
  const id = await comEmpresa(dono, E.id, async (trx) => {
    const u = await trx
      .insertInto('usuario')
      .values({ empresa_id: E.id, login, nome, perfil_id: E.perfilId, senha_hash: null, totp_cifrado: null })
      .returning('id')
      .executeTakeFirstOrThrow();
    await definirSenha(trx, u.id, SENHA);
    await definirTotp(trx, cofre, E.id, u.id, segredo);
    return u.id;
  });
  return { id, login, segredo };
}

/** Instantes em períodos TOTP diferentes, para não colidir com a proteção contra reuso. */
let relogio = Date.now();
const proximoPeriodo = () => new Date((relogio += 60_000));

async function linhaUsuario(E: EmpresaDeTeste, id: string) {
  return comEmpresa(dono, E.id, (trx) =>
    trx.selectFrom('usuario').select(['tentativas_falhas', 'bloqueado_ate', 'senha_hash', 'totp_cifrado']).where('id', '=', id).executeTakeFirstOrThrow(),
  );
}

beforeAll(async () => {
  dono = criarBanco(URL_DONO);
  app = criarBanco(URL_APP);
  A = await criarEmpresaCompleta(dono, 'login-a');
  B = await criarEmpresaCompleta(dono, 'login-b');
});

afterAll(async () => {
  await dono.destroy();
  await app.destroy();
});

describe('senha e TOTP guardados', () => {
  it('senha vira hash argon2id; TOTP vai cifrado', async () => {
    const u = await novoUsuario(A, 'guarda');
    const l = await linhaUsuario(A, u.id);
    expect(l.senha_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(l.senha_hash).not.toContain(SENHA);
    expect(l.totp_cifrado).toMatch(/^1:aesgcm\./);
    expect(l.totp_cifrado).not.toContain(u.segredo);
  });

  it('senha curta é recusada', async () => {
    await expect(hashSenha('curta')).rejects.toThrow(/pelo menos 12/);
  });

  it('o URI do TOTP serve para o app autenticador', () => {
    const { uri, segredo } = novoSegredoTotp('alguem');
    expect(uri).toMatch(/^otpauth:\/\/totp\/Forja:alguem\?/);
    expect(uri).toContain(`secret=${segredo}`);
    expect(segredo).toMatch(/^[A-Z2-7]{32}$/);
  });
});

describe('autenticar', () => {
  it('senha + código certos entram', async () => {
    const u = await novoUsuario(A, 'certo');
    const agora = proximoPeriodo();
    const r = await autenticar(app, cofre, { login: u.login, senha: SENHA, codigo: codigoTotpAtual(u.segredo, u.login, agora) }, agora);
    expect(r).toMatchObject({ usuarioId: u.id, empresaId: A.id, login: u.login, perfilId: A.perfilId });
  });

  it('login com maiúsculas e espaços é normalizado', async () => {
    const u = await novoUsuario(A, 'caixa');
    const agora = proximoPeriodo();
    const r = await autenticar(app, cofre, { login: `  ${u.login.toUpperCase()} `, senha: SENHA, codigo: codigoTotpAtual(u.segredo, u.login, agora) }, agora);
    expect(r.usuarioId).toBe(u.id);
  });

  it('aceita o código do período anterior (relógio atrasado 30 s), não de 2 períodos atrás', async () => {
    const u = await novoUsuario(A, 'janela');
    const agora = proximoPeriodo();
    const antes = new Date(agora.getTime() - 30_000);
    await expect(autenticar(app, cofre, { login: u.login, senha: SENHA, codigo: codigoTotpAtual(u.segredo, u.login, antes) }, agora)).resolves.toBeTruthy();
    const depois = proximoPeriodo();
    const velho = new Date(depois.getTime() - 90_000);
    await expect(autenticar(app, cofre, { login: u.login, senha: SENHA, codigo: codigoTotpAtual(u.segredo, u.login, velho) }, depois)).rejects.toThrow(ErroLogin);
  });

  it('o mesmo código não serve duas vezes', async () => {
    const u = await novoUsuario(A, 'reuso');
    const agora = proximoPeriodo();
    const codigo = codigoTotpAtual(u.segredo, u.login, agora);
    await autenticar(app, cofre, { login: u.login, senha: SENHA, codigo }, agora);
    await expect(autenticar(app, cofre, { login: u.login, senha: SENHA, codigo }, agora)).rejects.toThrow(/inválidos/);
  });

  it('mesma mensagem para login inexistente, senha errada e código errado', async () => {
    const u = await novoUsuario(A, 'generico');
    const agora = proximoPeriodo();
    const cod = codigoTotpAtual(u.segredo, u.login, agora);
    const msgs = await Promise.all([
      autenticar(app, cofre, { login: 'nao-existe-ninguem', senha: SENHA, codigo: cod }, agora).catch((e: Error) => e.message),
      autenticar(app, cofre, { login: u.login, senha: 'senha-errada-qualquer', codigo: cod }, agora).catch((e: Error) => e.message),
    ]);
    const msg3 = await autenticar(app, cofre, { login: u.login, senha: SENHA, codigo: '000000' }, proximoPeriodo()).catch((e: Error) => e.message);
    expect(new Set([...msgs, msg3])).toEqual(new Set(['Login, senha ou código inválidos.']));
  });

  it(`${MAX_TENTATIVAS} falhas bloqueiam por 15 min, mesmo com a senha certa depois`, async () => {
    const u = await novoUsuario(A, 'bloqueio');
    const t0 = proximoPeriodo();
    for (let i = 0; i < MAX_TENTATIVAS; i++) {
      await expect(autenticar(app, cofre, { login: u.login, senha: 'senha-errada-qualquer', codigo: '123456' }, t0)).rejects.toThrow(ErroLogin);
    }
    const l = await linhaUsuario(A, u.id);
    expect(l.bloqueado_ate!.getTime()).toBe(t0.getTime() + BLOQUEIO_MS);
    const t1 = new Date(t0.getTime() + 60_000);
    await expect(
      autenticar(app, cofre, { login: u.login, senha: SENHA, codigo: codigoTotpAtual(u.segredo, u.login, t1) }, t1),
    ).rejects.toThrow(/bloqueado/);
    const t2 = new Date(t0.getTime() + BLOQUEIO_MS + 60_000);
    relogio = t2.getTime();
    await expect(
      autenticar(app, cofre, { login: u.login, senha: SENHA, codigo: codigoTotpAtual(u.segredo, u.login, t2) }, t2),
    ).resolves.toBeTruthy();
    expect((await linhaUsuario(A, u.id)).tentativas_falhas).toBe(0);
  });

  it('acerto zera o contador de falhas', async () => {
    const u = await novoUsuario(A, 'zera');
    const t = proximoPeriodo();
    await autenticar(app, cofre, { login: u.login, senha: 'senha-errada-qualquer', codigo: '1' }, t).catch(() => undefined);
    expect((await linhaUsuario(A, u.id)).tentativas_falhas).toBe(1);
    await autenticar(app, cofre, { login: u.login, senha: SENHA, codigo: codigoTotpAtual(u.segredo, u.login, t) }, t);
    expect((await linhaUsuario(A, u.id)).tentativas_falhas).toBe(0);
  });

  it('usuário inativo ou sem TOTP não entra', async () => {
    const u = await novoUsuario(A, 'inativo');
    await comEmpresa(dono, A.id, (trx) => trx.updateTable('usuario').set({ ativo: false }).where('id', '=', u.id).execute());
    const t = proximoPeriodo();
    await expect(autenticar(app, cofre, { login: u.login, senha: SENHA, codigo: codigoTotpAtual(u.segredo, u.login, t) }, t)).rejects.toThrow(/inválidos/);
    // o usuário da empresa de teste foi criado sem senha nem TOTP
    const semTotp = await comEmpresa(dono, A.id, (trx) => trx.selectFrom('usuario').select('login').where('id', '=', A.usuarioId).executeTakeFirstOrThrow());
    await expect(autenticar(app, cofre, { login: semTotp.login, senha: SENHA, codigo: '123456' }, t)).rejects.toThrow(/sem senha ou TOTP/);
  });

  it('o segredo TOTP de A copiado para um usuário de B não decifra', async () => {
    const a = await novoUsuario(A, 'copia-a');
    const b = await novoUsuario(B, 'copia-b');
    const deA = (await linhaUsuario(A, a.id)).totp_cifrado;
    await comEmpresa(dono, B.id, (trx) => trx.updateTable('usuario').set({ totp_cifrado: deA }).where('id', '=', b.id).execute());
    const t = proximoPeriodo();
    await expect(autenticar(app, cofre, { login: b.login, senha: SENHA, codigo: codigoTotpAtual(a.segredo, a.login, t) }, t)).rejects.toThrow(/decifrar/);
  });
});

describe('sessão', () => {
  async function sessaoDe(E: EmpresaDeTeste, nome: string) {
    const u = await novoUsuario(E, nome);
    const t = proximoPeriodo();
    const aut = await autenticar(app, cofre, { login: u.login, senha: SENHA, codigo: codigoTotpAtual(u.segredo, u.login, t) }, t);
    return { u, aut, s: await criarSessao(app, aut, t), t };
  }

  it('o banco guarda só o SHA-256 do token', async () => {
    const { s, u } = await sessaoDe(A, 'hash');
    expect(s.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const linhas = await comEmpresa(dono, A.id, (trx) => trx.selectFrom('sessao').selectAll().where('usuario_id', '=', u.id).execute());
    expect(linhas).toHaveLength(1);
    const esperado = crypto.createHash('sha256').update(s.token).digest();
    expect(Buffer.compare(linhas[0]!.token_hash, esperado)).toBe(0);
    expect(JSON.stringify(linhas)).not.toContain(s.token);
  });

  it('resolve token válido para usuário e empresa; 12 h de validade', async () => {
    const { s, u, t } = await sessaoDe(A, 'valida');
    expect(s.expiraEm.getTime() - t.getTime()).toBe(12 * 3600_000);
    const r = await resolverSessao(app, s.token, t);
    expect(r).toMatchObject({ status: 'valida', usuarioId: u.id, empresaId: A.id, login: u.login, perfilId: A.perfilId });
  });

  it('expira', async () => {
    const { s } = await sessaoDe(A, 'expira');
    expect((await resolverSessao(app, s.token, new Date(s.expiraEm.getTime() + 1))).status).toBe('expirada');
  });

  it('logout revoga; segunda revogação devolve false', async () => {
    const { s, t } = await sessaoDe(A, 'logout');
    expect(await revogarSessao(app, s.token, t)).toBe(true);
    expect((await resolverSessao(app, s.token, t)).status).toBe('revogada');
    expect(await revogarSessao(app, s.token, t)).toBe(false);
  });

  it('trocar senha ou TOTP revoga as sessões abertas do usuário', async () => {
    const a = await sessaoDe(A, 'troca-senha');
    await comEmpresa(dono, A.id, (trx) => definirSenha(trx, a.u.id, 'outra-senha-bem-longa'));
    expect((await resolverSessao(app, a.s.token, a.t)).status).toBe('revogada');

    const b = await sessaoDe(A, 'troca-totp');
    await comEmpresa(dono, A.id, (trx) => definirTotp(trx, cofre, A.id, b.u.id, novoSegredoTotp(b.u.login).segredo));
    expect((await resolverSessao(app, b.s.token, b.t)).status).toBe('revogada');
  });

  it('token desconhecido ou lixo: inexistente', async () => {
    expect((await resolverSessao(app, crypto.randomBytes(32).toString('base64url'))).status).toBe('inexistente');
    expect((await resolverSessao(app, '')).status).toBe('inexistente');
    expect(await revogarSessao(app, 'lixo')).toBe(false);
  });

  it('usuário desativado derruba a sessão', async () => {
    const { s, u, t } = await sessaoDe(A, 'desativa');
    await comEmpresa(dono, A.id, (trx) => trx.updateTable('usuario').set({ ativo: false }).where('id', '=', u.id).execute());
    expect((await resolverSessao(app, s.token, t)).status).toBe('usuario_inativo');
  });

  it('sessão de B resolve para B; no contexto de A ela não aparece', async () => {
    const { s, u, t } = await sessaoDe(B, 'cruzada');
    const r = await resolverSessao(app, s.token, t);
    expect(r).toMatchObject({ status: 'valida', empresaId: B.id, usuarioId: u.id });
    const visto = await comEmpresa(app, A.id, (trx) => trx.selectFrom('sessao').select('id').where('usuario_id', '=', u.id).execute());
    expect(visto).toEqual([]);
  });

  it('o app não altera expira_em nem token_hash', async () => {
    const { u } = await sessaoDe(A, 'altera');
    await expect(
      comEmpresa(app, A.id, (trx) => trx.updateTable('sessao').set({ expira_em: new Date(Date.now() + 1e9) }).where('usuario_id', '=', u.id).execute()),
    ).rejects.toThrow(/permission denied/);
  });

  it('confirmarTotp (forja-aprovar): exige código novo e conta falhas', async () => {
    const { s, u, t } = await sessaoDe(A, 'confirma');
    const sessao = (await resolverSessao(app, s.token, t)) as SessaoValida;
    // o código usado no login já foi consumido
    await expect(confirmarTotp(app, cofre, sessao, codigoTotpAtual(u.segredo, u.login, t), t)).rejects.toThrow(/inválido ou já usado/);
    expect((await linhaUsuario(A, u.id)).tentativas_falhas).toBe(1);
    const t2 = new Date(t.getTime() + 30_000);
    const r = await confirmarTotp(app, cofre, sessao, codigoTotpAtual(u.segredo, u.login, t2), t2);
    expect(r).toMatchObject({ usuarioId: u.id, login: u.login });
    expect((await linhaUsuario(A, u.id)).tentativas_falhas).toBe(0);
  });
});

describe('funções SECURITY DEFINER do login', () => {
  it('donas: forja_login, search_path fixo, sem EXECUTE público', async () => {
    const r = await sql<{ proname: string; prosecdef: boolean; dono: string; proconfig: string[] | null; publico: boolean; app: boolean }>`
      SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS dono, p.proconfig,
             has_function_privilege('public', p.oid, 'EXECUTE') AS publico,
             has_function_privilege('forja_app', p.oid, 'EXECUTE') AS app
      FROM pg_proc p WHERE p.proname IN ('forja_buscar_login', 'forja_resolver_sessao') ORDER BY p.proname`.execute(dono);
    expect(r.rows).toHaveLength(2);
    for (const f of r.rows) {
      expect(f.prosecdef).toBe(true);
      expect(f.dono).toBe('forja_login');
      expect(f.proconfig).toEqual(['search_path=pg_catalog, pg_temp']);
      expect(f.publico).toBe(false);
      expect(f.app).toBe(true);
    }
  });

  it('forja_login não cria objetos no esquema e não lê hash de senha', async () => {
    const r = await sql<{ criar: boolean; senha: boolean; totp: boolean }>`
      SELECT has_schema_privilege('forja_login', 'public', 'CREATE') AS criar,
             has_column_privilege('forja_login', 'usuario', 'senha_hash', 'SELECT') AS senha,
             has_column_privilege('forja_login', 'usuario', 'totp_cifrado', 'SELECT') AS totp`.execute(dono);
    expect(r.rows[0]).toEqual({ criar: false, senha: false, totp: false });
  });

  it('forja_buscar_login devolve só ids', async () => {
    const u = await novoUsuario(B, 'ids');
    const r = await sql<Record<string, unknown>>`SELECT * FROM forja_buscar_login(${u.login})`.execute(app);
    expect(r.rows).toEqual([{ usuario_id: u.id, empresa_id: B.id }]);
  });
});

describe('arquivo local da sessão', () => {
  it('grava, lê e apaga; recusa conteúdo inválido', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-sessao-'));
    const arq = path.join(dir, '.forja', 'sessao');
    try {
      expect(lerSessaoLocal(arq)).toBeUndefined();
      gravarSessaoLocal({ token: 't', login: 'l', expira_em: '2030-01-01T00:00:00.000Z' }, arq);
      expect(lerSessaoLocal(arq)).toEqual({ token: 't', login: 'l', expira_em: '2030-01-01T00:00:00.000Z' });
      fs.writeFileSync(arq, '{"token":1}');
      expect(lerSessaoLocal(arq)).toBeUndefined();
      apagarSessaoLocal(arq);
      expect(fs.existsSync(arq)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fica fora do repositório: %APPDATA%\\forja no Windows, ~/.config/forja no resto', () => {
    expect(arquivoSessao({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'win32')).toBe(path.join('C:\\Users\\x\\AppData\\Roaming', 'forja', 'sessao'));
    expect(arquivoSessao({ XDG_CONFIG_HOME: '/home/x/.cfg' }, 'linux')).toBe(path.join('/home/x/.cfg', 'forja', 'sessao'));
    expect(arquivoSessao({}, 'darwin')).toBe(path.join(os.homedir(), '.config', 'forja', 'sessao'));
    expect(arquivoSessao().startsWith(raizRepositorio())).toBe(false);
  });

  it('apaga o arquivo do local antigo sem ler', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forja-legado-'));
    try {
      expect(apagarSessaoLegada(arquivoSessaoLegado(dir))).toBe(false);
      fs.mkdirSync(path.join(dir, '.forja'));
      fs.writeFileSync(arquivoSessaoLegado(dir), 'x');
      expect(apagarSessaoLegada(arquivoSessaoLegado(dir))).toBe(true);
      expect(fs.existsSync(arquivoSessaoLegado(dir))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
