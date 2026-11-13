#!/usr/bin/env node
import { criarBanco } from '../conexao.js';
import { exigirEnv, lerEnv } from '../env.js';
import { migrar } from '../migrar.js';

/** forja-migrar: aplica as migrações pendentes com o papel dono (FORJA_DATABASE_URL_ADMIN). */
async function principal(): Promise<void> {
  const db = criarBanco(exigirEnv(lerEnv(), 'FORJA_DATABASE_URL_ADMIN'), 1);
  try {
    const aplicadas = await migrar(db);
    console.log(aplicadas.length ? `Migrações aplicadas: ${aplicadas.join(', ')}` : 'Banco já está na versão mais recente.');
  } finally {
    await db.destroy();
  }
}

principal().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
