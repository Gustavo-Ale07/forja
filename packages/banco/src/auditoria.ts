import { comEmpresa, type Db } from './conexao.js';
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
      })
      .returning('id')
      .executeTakeFirstOrThrow(),
  );
  return r.id;
}

/** Um passo conta como executado quando houve execução efetiva aceita ('executado' ou 'já existia'). */
export async function passoExecutado(app: Db, empresaId: string, planoId: string, passoId: number): Promise<boolean> {
  const r = await comEmpresa(app, empresaId, (trx) =>
    trx
      .selectFrom('chamada_ferramenta')
      .select('id')
      .where('plano_id', '=', planoId)
      .where('passo_id', '=', passoId)
      .where('resultado', '=', 'aceito')
      .where('motivo', 'in', ['executado', 'já existia'])
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
      ])
      .where('data_hora', '>=', inicio)
      .where('data_hora', '<', fim)
      .orderBy('id')
      .execute(),
  ) as Promise<ChamadaGravada[]>;
}
