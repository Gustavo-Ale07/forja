import { sql } from 'kysely';
import { criarBanco } from '../src/conexao.js';
import { migrar } from '../src/migrar.js';
import { URL_DONO } from './urls.js';

/** globalSetup do vitest: banco forja_teste zerado + migrações. Sem o Postgres no ar, falha claro. */
export default async function preparar(): Promise<void> {
  const db = criarBanco(URL_DONO, 1);
  try {
    try {
      await sql`SELECT 1`.execute(db);
    } catch (e) {
      throw new Error(
        `Postgres de testes indisponível (${e instanceof Error ? e.message : String(e)}). Suba com: docker compose up -d`,
      );
    }
    await sql.raw('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; REVOKE ALL ON SCHEMA public FROM PUBLIC;').execute(db);
    await migrar(db);
  } finally {
    await db.destroy();
  }
}
