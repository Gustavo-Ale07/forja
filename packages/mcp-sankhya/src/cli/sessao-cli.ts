import { CofreAesGcm, criarBanco, lerChaveMestra, lerSessaoLocal, resolverSessao, type Db, type SessaoLocal, type SessaoValida } from '@forja/banco';
import { caminhos } from '../config/caminhos.js';
import { lerEnv } from '../config/index.js';

export const COMO_ENTRAR = 'Rode no seu terminal: pnpm forja-admin login';

export interface SessaoCli {
  app: Db;
  sessao: SessaoValida;
  env: Record<string, string | undefined>;
  caminhos: ReturnType<typeof caminhos>;
  /** Só quando pedido (precisa da FORJA_CHAVE_MESTRA para decifrar o TOTP). */
  cofre?: CofreAesGcm;
}

/**
 * Abre o banco com o papel app e exige a sessão local válida (a mesma do servidor MCP).
 * Quem chama fecha `app` no fim.
 */
export async function abrirSessaoCli(
  o: { raiz?: string; comCofre?: boolean; lerSessao?: () => SessaoLocal | undefined; agora?: Date } = {},
): Promise<SessaoCli> {
  const c = caminhos(o.raiz);
  const env = lerEnv(c.env);
  const url = env.FORJA_DATABASE_URL;
  if (!url) throw new Error('FORJA_DATABASE_URL não definido no .env.');
  const cofre = o.comCofre ? new CofreAesGcm(lerChaveMestra(env.FORJA_CHAVE_MESTRA)) : undefined;
  const local = (o.lerSessao ?? lerSessaoLocal)();
  if (!local) throw new Error(`Nenhuma sessão da Forja nesta máquina. ${COMO_ENTRAR}`);
  const app = criarBanco(url, 2);
  try {
    const s = await resolverSessao(app, local.token, o.agora);
    if (s.status !== 'valida') throw new Error(`A sessão da Forja não está válida (${s.status}). ${COMO_ENTRAR}`);
    return { app, sessao: s, env, caminhos: c, ...(cofre ? { cofre } : {}) };
  } catch (e) {
    await app.destroy();
    throw e;
  }
}
