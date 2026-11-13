#!/usr/bin/env node
import { CofreAesGcm, lerChaveMestra } from '../cofre.js';
import { criarBanco } from '../conexao.js';
import { exigirEnv, lerEnv } from '../env.js';
import { autenticar, criarSessao, revogarSessao } from '../login.js';
import { apagarSessaoLocal, gravarSessaoLocal, lerSessaoLocal } from '../sessao-local.js';
import { perguntar } from './pergunta.js';

const AJUDA = `forja-admin — administração da Forja

  forja-admin login     entra com login, senha e código TOTP; grava .forja/sessao (12 h)
  forja-admin logout    revoga a sessão no banco e apaga .forja/sessao
`;

async function login(): Promise<void> {
  const env = lerEnv();
  const cofre = new CofreAesGcm(lerChaveMestra(env.FORJA_CHAVE_MESTRA));
  const app = criarBanco(exigirEnv(env, 'FORJA_DATABASE_URL'), 1);
  try {
    const usuario = (await perguntar('Login: ')).trim();
    const senha = await perguntar('Senha: ', true);
    const codigo = (await perguntar('Código TOTP: ')).trim();
    const u = await autenticar(app, cofre, { login: usuario, senha, codigo });
    const anterior = lerSessaoLocal();
    if (anterior) await revogarSessao(app, anterior.token);
    const s = await criarSessao(app, u);
    gravarSessaoLocal({ token: s.token, login: u.login, expira_em: s.expiraEm.toISOString() });
    console.log(`Sessão aberta para ${u.login} até ${s.expiraEm.toLocaleString('pt-BR')}.`);
  } finally {
    await app.destroy();
  }
}

async function logout(): Promise<void> {
  const local = lerSessaoLocal();
  if (!local) {
    console.log('Nenhuma sessão local.');
    return;
  }
  const app = criarBanco(exigirEnv(lerEnv(), 'FORJA_DATABASE_URL'), 1);
  try {
    const revogada = await revogarSessao(app, local.token);
    apagarSessaoLocal();
    console.log(revogada ? `Sessão de ${local.login} revogada.` : `Sessão de ${local.login} já estava encerrada; arquivo local apagado.`);
  } finally {
    await app.destroy();
  }
}

async function principal(args: string[]): Promise<void> {
  const [cmd] = args;
  if (cmd === 'login') return login();
  if (cmd === 'logout') return logout();
  console.log(AJUDA);
  if (cmd && cmd !== 'ajuda' && cmd !== '--help') process.exitCode = 1;
}

principal(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
