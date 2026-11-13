import { sql } from 'kysely';
import { comEmpresa, type Db, type Trx } from './conexao.js';
import type { Resultado } from './tipos.js';

/** Um evento a gravar. Os JSONs já chegam mascarados (quem mascara é o servidor MCP). */
export interface ChamadaNova {
  usuarioId?: string | undefined;
  usuario?: string | undefined;
  perfil?: string | undefined;
  ambiente: string;
  ferramenta: string;
  parametrosJson: string;
  planoId?: string | undefined;
  passoId?: number | undefined;
  resultado: Resultado;
  motivo: string;
  antesJson?: string | null | undefined;
  depoisJson?: string | null | undefined;
  capturaPath?: string | undefined;
  /** Desfecho de uma reserva (linha em_execucao) criada por reservarPasso. */
  reservaId?: string | undefined;
}

export interface ChamadaGravada {
  id: string;
  data_hora: Date;
  usuario_id: string | null;
  usuario: string | null;
  perfil: string | null;
  ambiente: string;
  ferramenta: string;
  parametros: unknown;
  plano_id: string | null;
  passo_id: number | null;
  resultado: Resultado;
  motivo: string;
  antes: unknown;
  depois: unknown;
  captura_path: string | null;
  reserva_id: string | null;
}

/** INSERT na auditoria da empresa (sob RLS). A tabela recusa UPDATE, DELETE e TRUNCATE por gatilho. */
export async function registrarChamada(app: Db, empresaId: string, ev: ChamadaNova, agora = new Date()): Promise<string> {
  const r = await comEmpresa(app, empresaId, (trx) =>
    trx
      .insertInto('chamada_ferramenta')
      .values({
        empresa_id: empresaId,
        data_hora: agora,
        usuario_id: ev.usuarioId ?? null,
        usuario: ev.usuario ?? null,
        perfil: ev.perfil ?? null,
        ambiente: ev.ambiente,
        ferramenta: ev.ferramenta,
        parametros: ev.parametrosJson,
        plano_id: ev.planoId ?? null,
        passo_id: ev.passoId ?? null,
        resultado: ev.resultado,
        motivo: ev.motivo,
        antes: ev.antesJson ?? null,
        depois: ev.depoisJson ?? null,
        captura_path: ev.capturaPath ?? null,
        reserva_id: ev.reservaId ?? null,
      })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );
  return r.id;
}

/** Motivos de desfecho aceito que contam como execução efetiva do passo. */
export const MOTIVOS_EXECUTADO = ['executado', 'já existia', 'executado (conferência manual)'];

/** Um passo conta como executado quando houve execução efetiva aceita ('executado' ou 'já existia'). */
export async function passoExecutado(app: Db, empresaId: string, planoId: string, passoId: number): Promise<boolean> {
  const r = await comEmpresa(app, empresaId, (trx) =>
    trx
      .selectFrom('chamada_ferramenta')
      .select('id')
      .where('plano_id', '=', planoId)
      .where('passo_id', '=', passoId)
      .where('resultado', '=', 'aceito')
      .where('motivo', 'in', MOTIVOS_EXECUTADO)
      .limit(1)
      .executeTakeFirst(),
  );
  return r !== undefined;
}

/** Eventos da empresa em [inicio, fim), em ordem de gravação. */
export async function listarChamadas(app: Db, empresaId: string, inicio: Date, fim: Date): Promise<ChamadaGravada[]> {
  return comEmpresa(app, empresaId, (trx) =>
    trx
      .selectFrom('chamada_ferramenta')
      .select([
        'id',
        'data_hora',
        'usuario_id',
        'usuario',
        'perfil',
        'ambiente',
        'ferramenta',
        'parametros',
        'plano_id',
        'passo_id',
        'resultado',
        'motivo',
        'antes',
        'depois',
        'captura_path',
        'reserva_id',
      ])
      .where('data_hora', '>=', inicio)
      .where('data_hora', '<', fim)
      .orderBy('id')
      .execute(),
  ) as Promise<ChamadaGravada[]>;
}

export type ResultadoReserva =
  | { reservado: true; reservaId: string }
  | { reservado: false; situacao: 'em_execucao'; reserva: ChamadaGravada }
  | { reservado: false; situacao: 'executado' };

const COLUNAS = [
  'id',
  'data_hora',
  'usuario_id',
  'usuario',
  'perfil',
  'ambiente',
  'ferramenta',
  'parametros',
  'plano_id',
  'passo_id',
  'resultado',
  'motivo',
  'antes',
  'depois',
  'captura_path',
  'reserva_id',
] as const;

async function pendente(trx: Trx, planoId: string, passoId: number): Promise<ChamadaGravada | undefined> {
  return (await trx
    .selectFrom('chamada_ferramenta as c')
    .select(COLUNAS.map((c) => `c.${c}` as const))
    .where('c.resultado', '=', 'em_execucao')
    .where('c.plano_id', '=', planoId)
    .where('c.passo_id', '=', passoId)
    .where(({ not, exists, selectFrom }) =>
      not(exists(selectFrom('chamada_ferramenta as d').select('d.id').whereRef('d.reserva_id', '=', 'c.id'))),
    )
    .orderBy('c.id')
    .limit(1)
    .executeTakeFirst()) as ChamadaGravada | undefined;
}

/**
 * Reserva o passo ANTES de executar: grava uma linha "em_execucao" na auditoria. Com lock do
 * Postgres por (empresa, plano, passo), então vale entre processos. Recusa se o passo já foi
 * executado ou se há uma reserva sem desfecho (queda no meio: exige conferência manual).
 * O desfecho é gravado com registrarChamada({ ..., reservaId }).
 */
export async function reservarPasso(
  app: Db,
  empresaId: string,
  ev: Omit<ChamadaNova, 'resultado' | 'motivo' | 'reservaId'>,
  agora = new Date(),
): Promise<ResultadoReserva> {
  const { planoId, passoId } = ev;
  if (!planoId || passoId === undefined) throw new Error('reservarPasso exige plano e passo.');
  return comEmpresa(app, empresaId, async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`forja-passo:${empresaId}:${planoId}#${passoId}`}))`.execute(trx);
    const p = await pendente(trx, planoId, passoId);
    if (p) return { reservado: false, situacao: 'em_execucao', reserva: p };
    const feito = await trx
      .selectFrom('chamada_ferramenta')
      .select('id')
      .where('plano_id', '=', planoId)
      .where('passo_id', '=', passoId)
      .where('resultado', '=', 'aceito')
      .where('motivo', 'in', MOTIVOS_EXECUTADO)
      .limit(1)
      .executeTakeFirst();
    if (feito) return { reservado: false, situacao: 'executado' };
    const r = await trx
      .insertInto('chamada_ferramenta')
      .values({
        empresa_id: empresaId,
        data_hora: agora,
        usuario_id: ev.usuarioId ?? null,
        usuario: ev.usuario ?? null,
        perfil: ev.perfil ?? null,
        ambiente: ev.ambiente,
        ferramenta: ev.ferramenta,
        parametros: ev.parametrosJson,
        plano_id: planoId,
        passo_id: passoId,
        resultado: 'em_execucao',
        motivo: 'reserva: em execução',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { reservado: true, reservaId: r.id };
  });
}

/** A reserva sem desfecho do passo, se houver (para a conferência manual). */
export async function reservaPendente(app: Db, empresaId: string, planoId: string, passoId: number): Promise<ChamadaGravada | undefined> {
  return comEmpresa(app, empresaId, (trx) => pendente(trx, planoId, passoId));
}
