import crypto from 'node:crypto';
import { sql } from 'kysely';
import type { Cofre } from './cofre.js';
import { comEmpresa, type Db, type Trx } from './conexao.js';
import { gravarCredencial, lerCredencial, TIPOS_CREDENCIAL } from './credenciais.js';
import type { Nivel, TipoCredencial } from './tipos.js';

/**
 * Operações do forja-admin. Gravações exigem o papel dono (FORJA_DATABASE_URL_ADMIN); o app só lê.
 * Funções que recebem `trx` esperam a transação aberta com comEmpresa(empresaId).
 */

export class ErroAdmin extends Error {
  override readonly name = 'ErroAdmin';
}

/** Nome do único ambiente aceito na fase 2 (o banco também barra outro nome por CHECK). */
export const AMBIENTE_TESTE = 'teste';

// ---------------------------------------------------------------- empresa

export interface EmpresaResumo {
  id: string;
  nome: string;
  slug: string;
  fuso: string;
}

export async function buscarEmpresa(dono: Db, slug: string): Promise<EmpresaResumo | undefined> {
  const r = await sql<EmpresaResumo>`SELECT * FROM forja_empresa_por_slug(${slug})`.execute(dono);
  return r.rows[0];
}

export async function exigirEmpresa(dono: Db, slug: string): Promise<EmpresaResumo> {
  const e = await buscarEmpresa(dono, slug);
  if (!e) throw new ErroAdmin(`Empresa "${slug}" não existe. Crie com: forja-admin empresa criar --slug ${slug} --nome "..."`);
  return e;
}

export async function listarEmpresas(dono: Db): Promise<EmpresaResumo[]> {
  return (await sql<EmpresaResumo>`SELECT * FROM forja_listar_empresas()`.execute(dono)).rows;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

export async function criarEmpresa(dono: Db, e: { nome: string; slug: string; fuso?: string }): Promise<EmpresaResumo> {
  const slug = e.slug.trim().toLowerCase();
  if (!SLUG.test(slug)) throw new ErroAdmin('Slug inválido: use letras minúsculas, números e hífen (2 a 63 caracteres).');
  const nome = e.nome.trim();
  if (!nome) throw new ErroAdmin('Informe o nome da empresa.');
  const fuso = e.fuso ?? 'America/Sao_Paulo';
  validarFuso(fuso);
  if (await buscarEmpresa(dono, slug)) throw new ErroAdmin(`Já existe empresa com o slug "${slug}".`);
  const id = crypto.randomUUID();
  await comEmpresa(dono, id, (trx) => trx.insertInto('empresa').values({ id, nome, slug, fuso }).execute());
  return { id, nome, slug, fuso };
}

function validarFuso(fuso: string): void {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: fuso });
  } catch {
    throw new ErroAdmin(`Fuso horário inválido: "${fuso}".`);
  }
}

// ---------------------------------------------------------------- usuário

const LOGIN = /^[a-z0-9][a-z0-9_.@-]{1,99}$/;

export function normalizarLogin(login: string): string {
  const l = login.trim().toLowerCase();
  if (!LOGIN.test(l)) throw new ErroAdmin(`Login inválido: "${login}". Use letras, números, ".", "_", "@" ou "-" (2 a 100 caracteres).`);
  return l;
}

/** Empresa e id de um login (o login é único entre todas as empresas). */
export async function buscarLogin(dono: Db, login: string): Promise<{ usuario_id: string; empresa_id: string } | undefined> {
  const r = await sql<{ usuario_id: string; empresa_id: string }>`SELECT * FROM forja_buscar_login(${login})`.execute(dono);
  return r.rows[0];
}

async function idPerfil(trx: Trx, perfil: string): Promise<string> {
  const p = await trx.selectFrom('perfil').select('id').where('nome', '=', perfil).executeTakeFirst();
  if (!p) {
    const existentes = (await trx.selectFrom('perfil').select('nome').orderBy('nome').execute()).map((x) => x.nome);
    throw new ErroAdmin(`Perfil "${perfil}" não existe nesta empresa. Existentes: ${existentes.join(', ') || '(nenhum)'}.`);
  }
  return p.id;
}

/** Cria o usuário (sem senha nem TOTP; complete com definirSenha e definirTotp). */
export async function criarUsuario(
  dono: Db,
  trx: Trx,
  u: { empresaId: string; login: string; nome: string; perfil: string },
): Promise<string> {
  const login = normalizarLogin(u.login);
  if (await buscarLogin(dono, login)) throw new ErroAdmin(`O login "${login}" já existe.`);
  const perfilId = await idPerfil(trx, u.perfil);
  const r = await trx
    .insertInto('usuario')
    .values({ empresa_id: u.empresaId, login, nome: u.nome.trim() || login, perfil_id: perfilId, senha_hash: null, totp_cifrado: null })
    .returning('id')
    .executeTakeFirstOrThrow();
  return r.id;
}

// ---------------------------------------------------------------- ambiente e credenciais

export interface DadosAmbiente {
  url: string;
  hostPermitido: string;
  usuarioBancoEsperado: string;
  gatewayUrl: string;
  somenteLeitura?: boolean;
  duasAprovacoes?: boolean;
}

export type Credenciais = Partial<Record<TipoCredencial, string>>;

/** Cria ou atualiza o ambiente teste da empresa. Devolve o id. */
export async function gravarAmbiente(trx: Trx, empresaId: string, a: DadosAmbiente): Promise<string> {
  const valores = {
    url: a.url,
    host_permitido: a.hostPermitido.toLowerCase(),
    usuario_banco_esperado: a.usuarioBancoEsperado.toUpperCase(),
    gateway_url: a.gatewayUrl,
    somente_leitura: a.somenteLeitura ?? false,
    duas_aprovacoes: a.duasAprovacoes ?? false,
  };
  const r = await trx
    .insertInto('ambiente')
    .values({ empresa_id: empresaId, nome: AMBIENTE_TESTE, ...valores })
    .onConflict((oc) => oc.columns(['empresa_id', 'nome']).doUpdateSet(valores))
    .returning('id')
    .executeTakeFirstOrThrow();
  return r.id;
}

/** Grava as credenciais informadas (as ausentes ficam como estão). Devolve os tipos gravados. */
export async function gravarCredenciais(
  trx: Trx,
  cofre: Cofre,
  empresaId: string,
  ambienteId: string,
  c: Credenciais,
): Promise<TipoCredencial[]> {
  const gravados: TipoCredencial[] = [];
  for (const tipo of TIPOS_CREDENCIAL) {
    const valor = c[tipo];
    if (!valor) continue;
    await gravarCredencial(trx, cofre, { empresaId, ambienteId, tipo, valor });
    gravados.push(tipo);
  }
  return gravados;
}

export interface AmbienteComCredenciais extends DadosAmbiente {
  id: string;
  /** Decifradas na hora; não guarde além do uso. */
  credenciais: Credenciais;
}

/** Lê o ambiente teste e decifra as credenciais (funciona com o papel app). */
export async function lerAmbiente(db: Db, cofre: Cofre, empresaId: string): Promise<AmbienteComCredenciais | undefined> {
  return comEmpresa(db, empresaId, async (trx) => {
    const a = await trx.selectFrom('ambiente').selectAll().where('nome', '=', AMBIENTE_TESTE).executeTakeFirst();
    if (!a) return undefined;
    const credenciais: Credenciais = {};
    for (const tipo of TIPOS_CREDENCIAL) {
      const v = await lerCredencial(trx, cofre, { empresaId, ambienteId: a.id, tipo });
      if (v !== undefined) credenciais[tipo] = v;
    }
    return {
      id: a.id,
      url: a.url,
      hostPermitido: a.host_permitido,
      usuarioBancoEsperado: a.usuario_banco_esperado,
      gatewayUrl: a.gateway_url,
      somenteLeitura: a.somente_leitura,
      duasAprovacoes: a.duas_aprovacoes,
      credenciais,
    };
  });
}

// ---------------------------------------------------------------- importar config

export interface PerfilImportado {
  nome: string;
  descricao?: string | undefined;
  ambientes: string[];
  /** acoes[ambiente][ferramenta] = nível */
  acoes: Record<string, Record<string, Nivel>>;
  tabelasBloqueadas: string[];
}

export interface ConfigImportada {
  fuso: string;
  ambiente: DadosAmbiente;
  perfis: PerfilImportado[];
  /** login → perfil */
  usuarios: Record<string, string>;
  regras: {
    horario?: { inicio: string; fim: string; dias: number[] } | undefined;
    limiteRegistros: number;
    leituraBloqueada: string[];
    gravacaoNativaLiberada: string[];
  };
  instancias: Record<string, string>;
  credenciais: Credenciais;
}

export interface ResumoImportacao {
  perfis: string[];
  permissoes: number;
  usuariosNovos: string[];
  usuariosAtualizados: string[];
  credenciais: TipoCredencial[];
  instancias: number;
}

/**
 * Importa a config (já validada e com a trava aplicada pelo chamador) para a empresa, numa transação
 * só: ou entra tudo, ou nada. Pode rodar de novo: perfis, regras, ambiente e instâncias são
 * atualizados; permissões e tabelas bloqueadas dos perfis importados são trocadas pelas do arquivo;
 * usuários novos são criados sem senha/TOTP (use forja-admin usuario ativar); credenciais
 * ausentes não apagam as já gravadas.
 */
export async function importarConfig(dono: Db, cofre: Cofre, empresaId: string, cfg: ConfigImportada): Promise<ResumoImportacao> {
  validarFuso(cfg.fuso);
  const logins = Object.entries(cfg.usuarios).map(([l, p]) => [normalizarLogin(l), p] as const);
  // logins já usados por OUTRA empresa: erro antes de abrir a transação
  for (const [login] of logins) {
    const achado = await buscarLogin(dono, login);
    if (achado && achado.empresa_id !== empresaId) throw new ErroAdmin(`O login "${login}" já existe em outra empresa.`);
  }

  return comEmpresa(dono, empresaId, async (trx) => {
    await trx.updateTable('empresa').set({ fuso: cfg.fuso }).where('id', '=', empresaId).execute();
    const ambienteId = await gravarAmbiente(trx, empresaId, cfg.ambiente);
    const idAmbiente = (nome: string) => {
      if (nome !== AMBIENTE_TESTE) throw new ErroAdmin(`Ambiente "${nome}" não é aceito: só "${AMBIENTE_TESTE}".`);
      return ambienteId;
    };

    let permissoes = 0;
    for (const p of cfg.perfis) {
      const { id: perfilId } = await trx
        .insertInto('perfil')
        .values({ empresa_id: empresaId, nome: p.nome, descricao: p.descricao ?? null })
        .onConflict((oc) => oc.columns(['empresa_id', 'nome']).doUpdateSet({ descricao: p.descricao ?? null }))
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx.deleteFrom('perfil_ambiente').where('perfil_id', '=', perfilId).execute();
      await trx.deleteFrom('perfil_permissao').where('perfil_id', '=', perfilId).execute();
      await trx.deleteFrom('perfil_tabela_bloqueada').where('perfil_id', '=', perfilId).execute();
      for (const amb of p.ambientes) {
        await trx.insertInto('perfil_ambiente').values({ empresa_id: empresaId, perfil_id: perfilId, ambiente_id: idAmbiente(amb) }).execute();
      }
      for (const [amb, acoes] of Object.entries(p.acoes)) {
        const ambId = idAmbiente(amb);
        for (const [acao, nivel] of Object.entries(acoes)) {
          await trx.insertInto('perfil_permissao').values({ empresa_id: empresaId, perfil_id: perfilId, ambiente_id: ambId, acao, nivel }).execute();
          permissoes++;
        }
      }
      for (const padrao of new Set(p.tabelasBloqueadas.map((t) => t.toUpperCase()))) {
        await trx.insertInto('perfil_tabela_bloqueada').values({ empresa_id: empresaId, perfil_id: perfilId, padrao }).execute();
      }
    }

    const usuariosNovos: string[] = [];
    const usuariosAtualizados: string[] = [];
    for (const [login, perfil] of logins) {
      const perfilId = await idPerfil(trx, perfil);
      const existe = await trx.selectFrom('usuario').select('id').where('login', '=', login).executeTakeFirst();
      if (existe) {
        await trx.updateTable('usuario').set({ perfil_id: perfilId }).where('id', '=', existe.id).execute();
        usuariosAtualizados.push(login);
      } else {
        await trx
          .insertInto('usuario')
          .values({ empresa_id: empresaId, login, nome: login, perfil_id: perfilId, senha_hash: null, totp_cifrado: null })
          .execute();
        usuariosNovos.push(login);
      }
    }

    const r = cfg.regras;
    const regra = {
      horario_inicio: r.horario?.inicio ?? null,
      horario_fim: r.horario?.fim ?? null,
      dias: r.horario?.dias ?? [1, 2, 3, 4, 5],
      limite_registros: r.limiteRegistros,
      leitura_bloqueada: r.leituraBloqueada.map((t) => t.toUpperCase()),
      gravacao_nativa_liberada: r.gravacaoNativaLiberada.map((t) => t.toUpperCase()),
    };
    await trx
      .insertInto('regra')
      .values({ empresa_id: empresaId, ...regra })
      .onConflict((oc) => oc.column('empresa_id').doUpdateSet(regra))
      .execute();

    for (const [tabela, instancia] of Object.entries(cfg.instancias)) {
      await trx
        .insertInto('instancia_tabela')
        .values({ empresa_id: empresaId, tabela: tabela.toUpperCase(), instancia })
        .onConflict((oc) => oc.columns(['empresa_id', 'tabela']).doUpdateSet({ instancia }))
        .execute();
    }

    const credenciais = await gravarCredenciais(trx, cofre, empresaId, ambienteId, cfg.credenciais);
    return {
      perfis: cfg.perfis.map((p) => p.nome),
      permissoes,
      usuariosNovos,
      usuariosAtualizados,
      credenciais,
      instancias: Object.keys(cfg.instancias).length,
    };
  });
}
