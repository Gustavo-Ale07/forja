import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { Banco } from './tipos.js';

export type Db = Kysely<Banco>;
export type Trx = Transaction<Banco>;

// timestamptz → Date (padrão do pg); bigint (ids da auditoria) fica como string.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function criarBanco(url: string, max = 5): Db {
  return new Kysely<Banco>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max }) }),
  });
}

/**
 * Roda `fn` numa transação com a empresa do contexto fixada (SET LOCAL forja.empresa_id).
 * Todas as políticas de RLS filtram por esse valor; ele some no fim da transação, então uma
 * conexão devolvida ao pool nunca "lembra" a empresa anterior.
 */
export async function comEmpresa<T>(db: Db, empresaId: string, fn: (trx: Trx) => Promise<T>): Promise<T> {
  if (!UUID.test(empresaId)) throw new Error(`empresa_id inválido: ${empresaId}`);
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('forja.empresa_id', ${empresaId}, true)`.execute(trx);
    return fn(trx);
  });
}
