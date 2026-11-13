import crypto from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { sql } from 'kysely';
import * as OTPAuth from 'otpauth';
import type { Cofre } from './cofre.js';
import { comEmpresa, type Db, type Trx } from './conexao.js';

export const MAX_TENTATIVAS = 5;
export const BLOQUEIO_MS = 15 * 60_000;
export const DURACAO_SESSAO_MS = 12 * 60 * 60_000;
export const TAMANHO_MINIMO_SENHA = 12;

/** Erro de login. A mensagem é a mesma para login, senha ou código errados. */
export class ErroLogin extends Error {
  override readonly name = 'ErroLogin';
}
const INVALIDO = 'Login, senha ou código inválidos.';

// ---------------------------------------------------------------- senha (Argon2id)

export async function hashSenha(senha: string): Promise<string> {
  if (senha.length < TAMANHO_MINIMO_SENHA) throw new ErroLogin(`A senha precisa ter pelo menos ${TAMANHO_MINIMO_SENHA} caracteres.`);
  // Padrões do @node-rs/argon2: argon2id, m=19 MiB, t=2, p=1 (recomendação OWASP).
  return argonHash(senha);
}

/** Hash fixo para gastar o mesmo tempo quando o login não existe. */
let hashFalso: Promise<string> | undefined;
async function conferirSenha(hash: string | null, senha: string): Promise<boolean> {
  if (!hash) {
    hashFalso ??= argonHash(crypto.randomBytes(16).toString('hex'));
    await argonVerify(await hashFalso, senha).catch(() => false);
    return false;
  }
  return argonVerify(hash, senha).catch(() => false);
}

// ---------------------------------------------------------------- TOTP (RFC 6238)

export const contextoTotp = (empresaId: string, usuarioId: string) => `totp:${empresaId}:${usuarioId}`;

function totp(segredoBase32: string, login: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: 'Forja',
    label: login,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(segredoBase32),
  });
}

/** Novo segredo TOTP (160 bits) e o URI otpauth:// para o app autenticador. */
export function novoSegredoTotp(login: string): { segredo: string; uri: string } {
  const segredo = new OTPAuth.Secret({ size: 20 }).base32;
  return { segredo, uri: totp(segredo, login).toString() };
}

/**
 * Confere um código. Aceita o período atual e um de cada lado (relógio fora por até 30 s).
 * Devolve o número do período usado (para impedir reuso) ou undefined.
 */
export function conferirCodigoTotp(segredo: string, login: string, codigo: string, agora: Date): number | undefined {
  const limpo = codigo.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(limpo)) return undefined;
  const t = totp(segredo, login);
  const delta = t.validate({ token: limpo, timestamp: agora.getTime(), window: 1 });
  if (delta === null) return undefined;
  return t.counter({ timestamp: agora.getTime() }) + delta;
}

/** Só para testes e para conferir o cadastro: o código atual de um segredo. */
export function codigoTotpAtual(segredo: string, login: string, agora = new Date()): string {
  return totp(segredo, login).generate({ timestamp: agora.getTime() });
}

// ---------------------------------------------------------------- cadastro (papel dono)

/** Grava o hash da senha. `trx` com comEmpresa(empresa) e papel dono. */
export async function definirSenha(trx: Trx, usuarioId: string, senha: string): Promise<void> {
  const senha_hash = await hashSenha(senha);
  const r = await trx
    .updateTable('usuario')
    .set({ senha_hash, tentativas_falhas: 0, bloqueado_ate: null })
    .where('id', '=', usuarioId)
    .executeTakeFirst();
  if (Number(r.numUpdatedRows) !== 1) throw new ErroLogin('Usuário não encontrado nesta empresa.');
}

/** Grava o segredo TOTP cifrado no Cofre. `trx` com comEmpresa(empresa) e papel dono. */
export async function definirTotp(trx: Trx, cofre: Cofre, empresaId: string, usuarioId: string, segredo: string): Promise<void> {
  const { cifrado, versaoChave } = await cofre.cifrar(segredo, contextoTotp(empresaId, usuarioId));
  // versão da chave junto do texto, para o caso de rotação
  const r = await trx
    .updateTable('usuario')
    .set({ totp_cifrado: `${versaoChave}:${cifrado}`, totp_ultimo_passo: 0 })
    .where('id', '=', usuarioId)
    .executeTakeFirst();
  if (Number(r.numUpdatedRows) !== 1) throw new ErroLogin('Usuário não encontrado nesta empresa.');
}

async function lerSegredoTotp(cofre: Cofre, empresaId: string, usuarioId: string, guardado: string): Promise<string> {
  const i = guardado.indexOf(':');
  return cofre.decifrar({ versaoChave: Number(guardado.slice(0, i)), cifrado: guardado.slice(i + 1) }, contextoTotp(empresaId, usuarioId));
}

// ---------------------------------------------------------------- autenticação (papel app)

export interface UsuarioAutenticado {
  usuarioId: string;
  empresaId: string;
  login: string;
  nome: string;
  perfilId: string;
}

interface LinhaUsuario {
  id: string;
  empresa_id: string;
  login: string;
  nome: string;
  perfil_id: string;
  senha_hash: string | null;
  totp_cifrado: string | null;
  ativo: boolean;
  tentativas_falhas: number;
  bloqueado_ate: Date | null;
  totp_ultimo_passo: string;
}

async function lerUsuario(trx: Trx, usuarioId: string): Promise<LinhaUsuario | undefined> {
  const r = await sql<LinhaUsuario>`
    SELECT id, empresa_id, login, nome, perfil_id, senha_hash, totp_cifrado, ativo, tentativas_falhas, bloqueado_ate, totp_ultimo_passo
    FROM usuario WHERE id = ${usuarioId} FOR UPDATE`.execute(trx);
  return r.rows[0];
}

async function registrarFalha(trx: Trx, u: LinhaUsuario, agora: Date): Promise<void> {
  const tentativas = u.tentativas_falhas + 1;
  const bloquear = tentativas >= MAX_TENTATIVAS;
  await trx
    .updateTable('usuario')
    .set({ tentativas_falhas: bloquear ? 0 : tentativas, bloqueado_ate: bloquear ? new Date(agora.getTime() + BLOQUEIO_MS) : u.bloqueado_ate })
    .where('id', '=', u.id)
    .execute();
}

/** Confere usuário ativo, não bloqueado, com senha e TOTP cadastrados. Lança ErroLogin. */
function conferirConta(u: LinhaUsuario | undefined, agora: Date): asserts u is LinhaUsuario {
  if (!u || !u.ativo) throw new ErroLogin(INVALIDO);
  if (u.bloqueado_ate && u.bloqueado_ate > agora) {
    throw new ErroLogin(`Usuário bloqueado por excesso de tentativas até ${u.bloqueado_ate.toISOString()}.`);
  }
  if (!u.senha_hash || !u.totp_cifrado) {
    throw new ErroLogin('Usuário sem senha ou TOTP cadastrados. Peça ao administrador (forja-admin usuario senha / totp).');
  }
}

/**
 * Confere o código TOTP e consome o período (um código não serve duas vezes). Na falha conta
 * tentativa. Devolve false sem lançar, para a transação gravar a falha.
 */
async function consumirTotp(trx: Trx, cofre: Cofre, u: LinhaUsuario, codigo: string, agora: Date): Promise<boolean> {
  const segredo = await lerSegredoTotp(cofre, u.empresa_id, u.id, u.totp_cifrado!);
  const passo = conferirCodigoTotp(segredo, u.login, codigo, agora);
  if (passo === undefined || passo <= Number(u.totp_ultimo_passo)) return false;
  await trx.updateTable('usuario').set({ totp_ultimo_passo: passo }).where('id', '=', u.id).execute();
  return true;
}

async function empresaDoLogin(app: Db, login: string): Promise<{ usuario_id: string; empresa_id: string } | undefined> {
  const r = await sql<{ usuario_id: string; empresa_id: string }>`SELECT * FROM forja_buscar_login(${login})`.execute(app);
  return r.rows[0];
}

const autenticado = (u: LinhaUsuario): UsuarioAutenticado => ({
  usuarioId: u.id,
  empresaId: u.empresa_id,
  login: u.login,
  nome: u.nome,
  perfilId: u.perfil_id,
});

/** Login com senha (Argon2) + código TOTP. 5 falhas seguidas bloqueiam por 15 minutos. */
export async function autenticar(
  app: Db,
  cofre: Cofre,
  e: { login: string; senha: string; codigo: string },
  agora = new Date(),
): Promise<UsuarioAutenticado> {
  const achado = await empresaDoLogin(app, e.login);
  if (!achado) {
    await conferirSenha(null, e.senha); // mesmo custo de tempo de um login existente
    throw new ErroLogin(INVALIDO);
  }
  const r = await comEmpresa(app, achado.empresa_id, async (trx) => {
    const u = await lerUsuario(trx, achado.usuario_id);
    conferirConta(u, agora);
    const ok = (await conferirSenha(u.senha_hash, e.senha)) && (await consumirTotp(trx, cofre, u, e.codigo, agora));
    if (!ok) {
      await registrarFalha(trx, u, agora);
      return undefined;
    }
    await trx.updateTable('usuario').set({ tentativas_falhas: 0, bloqueado_ate: null }).where('id', '=', u.id).execute();
    return autenticado(u);
  });
  if (!r) throw new ErroLogin(INVALIDO);
  return r;
}

/**
 * Confirma a presença do usuário de uma sessão válida com um código TOTP novo (usado pelo
 * forja-aprovar a cada assinatura). Conta tentativa e respeita o bloqueio, como o login.
 */
export async function confirmarTotp(
  app: Db,
  cofre: Cofre,
  sessao: SessaoValida,
  codigo: string,
  agora = new Date(),
): Promise<UsuarioAutenticado> {
  const r = await comEmpresa(app, sessao.empresaId, async (trx) => {
    const u = await lerUsuario(trx, sessao.usuarioId);
    conferirConta(u, agora);
    if (!(await consumirTotp(trx, cofre, u, codigo, agora))) {
      await registrarFalha(trx, u, agora);
      return undefined;
    }
    await trx.updateTable('usuario').set({ tentativas_falhas: 0 }).where('id', '=', u.id).execute();
    return autenticado(u);
  });
  if (!r) throw new ErroLogin('Código TOTP inválido ou já usado.');
  return r;
}

// ---------------------------------------------------------------- sessão

const hashToken = (token: string) => crypto.createHash('sha256').update(token, 'utf8').digest();

export interface NovaSessao {
  token: string;
  expiraEm: Date;
}

/** Cria a sessão. O banco guarda só o SHA-256 do token; o token vai para o arquivo local do usuário. */
export async function criarSessao(app: Db, u: UsuarioAutenticado, agora = new Date(), duracaoMs = DURACAO_SESSAO_MS): Promise<NovaSessao> {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiraEm = new Date(agora.getTime() + duracaoMs);
  await comEmpresa(app, u.empresaId, (trx) =>
    trx
      .insertInto('sessao')
      .values({ empresa_id: u.empresaId, usuario_id: u.usuarioId, token_hash: hashToken(token), criada_em: agora, expira_em: expiraEm })
      .execute(),
  );
  return { token, expiraEm };
}

export interface SessaoValida {
  status: 'valida';
  sessaoId: string;
  usuarioId: string;
  empresaId: string;
  login: string;
  perfilId: string;
  expiraEm: Date;
}
export type SessaoResolvida =
  | SessaoValida
  | { status: 'expirada' | 'revogada' | 'usuario_inativo'; usuarioId: string; empresaId: string; login?: string }
  | { status: 'inexistente' };

/** Quem é o dono deste token. Não lança: devolve o status para o chamador decidir (e auditar). */
export async function resolverSessao(app: Db, token: string, agora = new Date()): Promise<SessaoResolvida> {
  if (!token || token.length > 200) return { status: 'inexistente' };
  const r = await sql<{ sessao_id: string; usuario_id: string; empresa_id: string; expira_em: Date; revogada_em: Date | null }>`
    SELECT * FROM forja_resolver_sessao(${hashToken(token)})`.execute(app);
  const s = r.rows[0];
  if (!s) return { status: 'inexistente' };
  const base = { usuarioId: s.usuario_id, empresaId: s.empresa_id };
  const u = await comEmpresa(app, s.empresa_id, (trx) =>
    trx.selectFrom('usuario').select(['login', 'perfil_id', 'ativo']).where('id', '=', s.usuario_id).executeTakeFirst(),
  );
  if (s.revogada_em) return { status: 'revogada', ...base, ...(u ? { login: u.login } : {}) };
  if (s.expira_em <= agora) return { status: 'expirada', ...base, ...(u ? { login: u.login } : {}) };
  if (!u || !u.ativo) return { status: 'usuario_inativo', ...base, ...(u ? { login: u.login } : {}) };
  return { status: 'valida', sessaoId: s.sessao_id, ...base, login: u.login, perfilId: u.perfil_id, expiraEm: s.expira_em };
}

/** Revoga a sessão do token (logout). Devolve false se o token não existia ou já estava revogado. */
export async function revogarSessao(app: Db, token: string, agora = new Date()): Promise<boolean> {
  const r = await sql<{ empresa_id: string; revogada_em: Date | null }>`SELECT * FROM forja_resolver_sessao(${hashToken(token)})`.execute(app);
  const s = r.rows[0];
  if (!s || s.revogada_em) return false;
  const u = await comEmpresa(app, s.empresa_id, (trx) =>
    trx.updateTable('sessao').set({ revogada_em: agora }).where('token_hash', '=', hashToken(token)).where('revogada_em', 'is', null).executeTakeFirst(),
  );
  return Number(u.numUpdatedRows) === 1;
}
