import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider, type MigrationResultSet } from 'kysely/migration';
import { SQL_001 } from './migracoes/001-inicial.js';
import { SQL_002 } from './migracoes/002-login.js';
import { SQL_003 } from './migracoes/003-admin.js';
import { SQL_004 } from './migracoes/004-reserva-passo.js';

/** Migrações em ordem. Cada uma é SQL puro, revisável, rodada pelo papel forja_dono. */
const MIGRACOES: Record<string, string> = {
  '001-inicial': SQL_001,
  '002-login': SQL_002,
  '003-admin': SQL_003,
  '004-reserva-passo': SQL_004,
};

const provedor: MigrationProvider = {
  async getMigrations(): Promise<Record<string, Migration>> {
    return Object.fromEntries(
      Object.entries(MIGRACOES).map(([nome, texto]) => [
        nome,
        {
          async up(db: Kysely<unknown>) {
            await sql.raw(texto).execute(db);
          },
        },
      ]),
    );
  },
};

/** Aplica as migrações pendentes. Lança na primeira falha (a migração com erro é desfeita). */
export async function migrar(db: Kysely<any>): Promise<string[]> {
  const r: MigrationResultSet = await new Migrator({ db, provider: provedor }).migrateToLatest();
  if (r.error) {
    const falhou = r.results?.find((x) => x.status === 'Error')?.migrationName ?? '?';
    throw new Error(`Migração ${falhou} falhou: ${r.error instanceof Error ? r.error.message : String(r.error)}`);
  }
  return (r.results ?? []).filter((x) => x.status === 'Success').map((x) => x.migrationName);
}
