import fs from 'node:fs';
import path from 'node:path';
import { raizRepositorio } from './env.js';

/**
 * Arquivo local da sessão (.forja/sessao), escrito por `forja-admin login` e lido pelo MCP e pelo
 * forja-aprovar. Guarda o token em claro (o banco só tem o hash); fica fora do git e bloqueado
 * para o Claude no .claude/settings.json.
 */
export interface SessaoLocal {
  token: string;
  login: string;
  expira_em: string;
}

export const arquivoSessao = (raiz = raizRepositorio()) => path.join(raiz, '.forja', 'sessao');

export function gravarSessaoLocal(s: SessaoLocal, arquivo = arquivoSessao()): void {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true, mode: 0o700 });
  fs.writeFileSync(arquivo, JSON.stringify(s), { mode: 0o600 });
  fs.chmodSync(arquivo, 0o600); // se já existia, o mode do writeFileSync não se aplica
}

export function lerSessaoLocal(arquivo = arquivoSessao()): SessaoLocal | undefined {
  if (!fs.existsSync(arquivo)) return undefined;
  try {
    const j = JSON.parse(fs.readFileSync(arquivo, 'utf8')) as Partial<SessaoLocal>;
    if (typeof j.token !== 'string' || typeof j.login !== 'string' || typeof j.expira_em !== 'string') return undefined;
    return { token: j.token, login: j.login, expira_em: j.expira_em };
  } catch {
    return undefined;
  }
}

export function apagarSessaoLocal(arquivo = arquivoSessao()): void {
  fs.rmSync(arquivo, { force: true });
}
