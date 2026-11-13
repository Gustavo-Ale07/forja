import type { Trx } from './conexao.js';
import type { Cofre } from './cofre.js';
import type { TipoCredencial } from './tipos.js';

export const TIPOS_CREDENCIAL: readonly TipoCredencial[] = [
  'web_usuario',
  'web_senha',
  'gateway_client_id',
  'gateway_client_secret',
  'gateway_token',
];

/** Contexto (AAD) de uma credencial: decifrar exige estar na mesma empresa, ambiente e tipo. */
export const contextoCredencial = (empresaId: string, ambienteId: string, tipo: TipoCredencial) =>
  `credencial:${empresaId}:${ambienteId}:${tipo}`;

/**
 * Grava (ou troca) uma credencial cifrada. Precisa do papel dono (o app não tem INSERT/UPDATE) e de
 * `trx` aberta com comEmpresa(empresaId).
 */
export async function gravarCredencial(
  trx: Trx,
  cofre: Cofre,
  c: { empresaId: string; ambienteId: string; tipo: TipoCredencial; valor: string },
): Promise<void> {
  if (!c.valor) throw new Error(`Credencial ${c.tipo} vazia.`);
  const { cifrado, versaoChave } = await cofre.cifrar(c.valor, contextoCredencial(c.empresaId, c.ambienteId, c.tipo));
  await trx
    .insertInto('credencial')
    .values({ empresa_id: c.empresaId, ambiente_id: c.ambienteId, tipo: c.tipo, cifrado, versao_chave: versaoChave })
    .onConflict((oc) =>
      oc.columns(['ambiente_id', 'tipo']).doUpdateSet({ cifrado, versao_chave: versaoChave, atualizado_em: new Date() }),
    )
    .execute();
}

/**
 * Lê e decifra uma credencial. Chame só no momento de usar e não guarde o resultado além do necessário.
 * Devolve undefined se não houver credencial desse tipo (ou se a RLS esconder a linha).
 */
export async function lerCredencial(
  trx: Trx,
  cofre: Cofre,
  c: { empresaId: string; ambienteId: string; tipo: TipoCredencial },
): Promise<string | undefined> {
  const linha = await trx
    .selectFrom('credencial')
    .select(['cifrado', 'versao_chave'])
    .where('ambiente_id', '=', c.ambienteId)
    .where('tipo', '=', c.tipo)
    .executeTakeFirst();
  if (!linha) return undefined;
  return cofre.decifrar(
    { cifrado: linha.cifrado, versaoChave: linha.versao_chave },
    contextoCredencial(c.empresaId, c.ambienteId, c.tipo),
  );
}

/** Quais tipos estão cadastrados para o ambiente (sem decifrar nada). */
export async function tiposCadastrados(trx: Trx, ambienteId: string): Promise<TipoCredencial[]> {
  const r = await trx.selectFrom('credencial').select('tipo').where('ambiente_id', '=', ambienteId).execute();
  return r.map((x) => x.tipo);
}
