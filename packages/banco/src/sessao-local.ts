import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { raizRepositorio } from './env.js';

/**
 * Arquivo local da sessão, escrito por `forja-admin login` e lido pelo MCP e pelo forja-aprovar.
 * Guarda o token em claro (o banco só tem o hash) e fica FORA do repositório:
 *   Windows: %APPDATA%\forja\sessao      demais: $XDG_CONFIG_HOME/forja/sessao (~/.config/forja/sessao)
 * Fora do repositório o token não vai parar num commit nem na pasta de trabalho do agente. Não é uma
 * barreira contra quem roda comandos nesta máquina: a barreira para aprovar é o TOTP de cada assinatura.
 */
export interface SessaoLocal {
  token: string;
  login: string;
  expira_em: string;
}

/** Pasta de configuração do usuário no sistema operacional. */
export function pastaConfigUsuario(env: NodeJS.ProcessEnv = process.env, plataforma: NodeJS.Platform = process.platform): string {
  if (plataforma === 'win32') return env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

export const arquivoSessao = (env: NodeJS.ProcessEnv = process.env, plataforma: NodeJS.Platform = process.platform) =>
  path.join(pastaConfigUsuario(env, plataforma), 'forja', 'sessao');

/** Local antigo (etapa 3, dentro do repositório). Só é apagado, nunca lido. */
export const arquivoSessaoLegado = (raiz = raizRepositorio()) => path.join(raiz, '.forja', 'sessao');

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

/** Apaga o arquivo do local antigo, se ainda existir. Devolve true se apagou. */
export function apagarSessaoLegada(arquivo = arquivoSessaoLegado()): boolean {
  if (!fs.existsSync(arquivo)) return false;
  fs.rmSync(arquivo, { force: true });
  return true;
}
