#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  apagarSessaoLegada,
  apagarSessaoLocal,
  arquivoSessao,
  autenticar,
  buscarLogin,
  CofreAesGcm,
  comEmpresa,
  conferirCodigoTotp,
  criarBanco,
  criarEmpresa,
  criarSessao,
  criarUsuario,
  definirSenha,
  definirTotp,
  exigirEmpresa,
  gravarAmbiente,
  gravarCredenciais,
  gravarSessaoLocal,
  hashSenha,
  importarConfig,
  lerAmbiente,
  lerChaveMestra,
  lerSessaoLocal,
  listarEmpresas,
  normalizarLogin,
  novoSegredoTotp,
  revogarSessao,
  TIPOS_CREDENCIAL,
  type Cofre,
  type Credenciais,
  type Db,
} from '@forja/banco';
import { mensagemSegura, registrarSegredo } from '../comum/mascara.js';
import { caminhos } from '../config/caminhos.js';
import { lerConfigParaImportar } from '../config/importar.js';
import { lerEnv } from '../config/index.js';
import { usuarioBancoConfere, verificarAmbiente } from '../config/trava-producao.js';
import { criarClienteReal } from '../gateway/cliente.js';
import { comoObjetos, SQL } from '../sankhya/dicionario.js';
import { perguntar } from './pergunta.js';

const AJUDA = `forja-admin — administração da Forja (rode no seu terminal, não pelo chat)

  login                                     entra com login, senha e código TOTP (sessão de 12 h)
  logout                                    revoga a sessão no banco e apaga o arquivo local

  empresa criar --slug S --nome "N" [--fuso F]
  empresa listar

  usuario criar --empresa S --login L --nome "N" --perfil P    cria e já cadastra senha + TOTP
  usuario ativar --login L                                     (re)define senha + TOTP

  ambiente cadastrar --empresa S --url https://... --usuario-banco U [--gateway-url https://...] [--somente-leitura]
                                            pergunta as 5 credenciais do Sankhya (cifradas no banco)
  ambiente testar --empresa S               confere trava, credenciais e SELECT USER pelo Gateway

  importar-config --empresa S               copia forja.config.yaml (+ local) e as FORJA_TESTE_* do .env para o banco
`;

const env = lerEnv(caminhos().env);

function exigir(nome: string): string {
  const v = env[nome];
  if (!v) throw new Error(`${nome} não definido no .env.`);
  return v;
}

const cofre = (): Cofre => new CofreAesGcm(lerChaveMestra(env.FORJA_CHAVE_MESTRA));
const bancoDono = (): Db => criarBanco(exigir('FORJA_DATABASE_URL_ADMIN'), 1);
const bancoApp = (): Db => criarBanco(exigir('FORJA_DATABASE_URL'), 1);

async function usar<T>(dbs: Db[], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    await Promise.all(dbs.map((d) => d.destroy()));
  }
}

function opcoes(args: string[], definicao: Record<string, { type: 'string' | 'boolean' }>) {
  return parseArgs({ args, options: definicao, allowPositionals: false, strict: true }).values as Record<string, string | boolean | undefined>;
}

function texto(v: Record<string, string | boolean | undefined>, nome: string): string {
  const x = v[nome];
  if (typeof x !== 'string' || !x.trim()) throw new Error(`Falta --${nome}.`);
  return x.trim();
}

// ---------------------------------------------------------------- sessão

async function login(): Promise<void> {
  const app = bancoApp();
  await usar([app], async () => {
    const usuario = (await perguntar('Login: ')).trim();
    const senha = await perguntar('Senha: ', true);
    const codigo = (await perguntar('Código TOTP: ')).trim();
    const u = await autenticar(app, cofre(), { login: usuario, senha, codigo });
    const anterior = lerSessaoLocal();
    if (anterior) await revogarSessao(app, anterior.token);
    const s = await criarSessao(app, u);
    gravarSessaoLocal({ token: s.token, login: u.login, expira_em: s.expiraEm.toISOString() });
    apagarSessaoLegada();
    console.log(`Sessão aberta para ${u.login} até ${s.expiraEm.toLocaleString('pt-BR')}.`);
    console.log(`Arquivo da sessão: ${arquivoSessao()}`);
  });
}

async function logout(): Promise<void> {
  const local = lerSessaoLocal();
  if (apagarSessaoLegada()) console.log('Arquivo de sessão antigo (.forja/sessao no repositório) apagado.');
  if (!local) {
    console.log('Nenhuma sessão local.');
    return;
  }
  const app = bancoApp();
  await usar([app], async () => {
    const revogada = await revogarSessao(app, local.token);
    apagarSessaoLocal();
    console.log(revogada ? `Sessão de ${local.login} revogada.` : `Sessão de ${local.login} já estava encerrada; arquivo local apagado.`);
  });
}

// ---------------------------------------------------------------- empresa

async function empresa(sub: string | undefined, args: string[]): Promise<void> {
  const dono = bancoDono();
  await usar([dono], async () => {
    if (sub === 'criar') {
      const v = opcoes(args, { slug: { type: 'string' }, nome: { type: 'string' }, fuso: { type: 'string' } });
      const e = await criarEmpresa(dono, { slug: texto(v, 'slug'), nome: texto(v, 'nome'), ...(typeof v.fuso === 'string' ? { fuso: v.fuso } : {}) });
      console.log(`Empresa criada: ${e.slug} (${e.nome}), fuso ${e.fuso}.`);
    } else if (sub === 'listar') {
      const lista = await listarEmpresas(dono);
      if (!lista.length) console.log('Nenhuma empresa.');
      for (const e of lista) console.log(`${e.slug}\t${e.nome}\t${e.fuso}`);
    } else {
      throw new Error('Use: forja-admin empresa criar | listar');
    }
  });
}

// ---------------------------------------------------------------- usuário

async function perguntarSenhaNova(): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const s1 = await perguntar('Senha nova (mín. 12 caracteres): ', true);
    try {
      await hashSenha(s1); // valida o tamanho
    } catch (e) {
      console.log(mensagemSegura(e));
      continue;
    }
    const s2 = await perguntar('Repita a senha: ', true);
    if (s1 === s2) return s1;
    console.log('As senhas não conferem.');
  }
  throw new Error('Senha não definida.');
}

/** Gera o TOTP, mostra a chave e só aceita depois que o app autenticador gerar um código válido. */
async function cadastrarTotpInterativo(login: string): Promise<{ segredo: string; passo: number }> {
  const { segredo } = novoSegredoTotp(login);
  const agrupado = segredo.match(/.{1,4}/g)!.join(' ');
  console.log(`
No app autenticador (Google Authenticator, Microsoft Authenticator, Authy...):
  "Adicionar conta" → "Inserir chave de configuração"
  Conta:  Forja (${login})
  Chave:  ${agrupado}
  Tipo:   baseado em tempo (TOTP)
`);
  for (let i = 0; i < 3; i++) {
    const codigo = await perguntar('Código de 6 dígitos mostrado no app: ');
    const passo = conferirCodigoTotp(segredo, login, codigo, new Date());
    if (passo !== undefined) {
      console.clear();
      return { segredo, passo };
    }
    console.log('Código não confere. Veja se o relógio do celular está certo e tente de novo.');
  }
  throw new Error('TOTP não confirmado. Nada foi gravado.');
}

async function ativarUsuario(dono: Db, empresaId: string, usuarioId: string, login: string): Promise<void> {
  const senha = await perguntarSenhaNova();
  const { segredo, passo } = await cadastrarTotpInterativo(login);
  await comEmpresa(dono, empresaId, async (trx) => {
    await definirSenha(trx, usuarioId, senha);
    await definirTotp(trx, cofre(), empresaId, usuarioId, segredo, passo);
  });
  console.log(`Usuário ${login} com senha e TOTP cadastrados. Entre com: pnpm forja-admin login`);
}

async function usuario(sub: string | undefined, args: string[]): Promise<void> {
  const dono = bancoDono();
  await usar([dono], async () => {
    if (sub === 'criar') {
      const v = opcoes(args, { empresa: { type: 'string' }, login: { type: 'string' }, nome: { type: 'string' }, perfil: { type: 'string' } });
      const e = await exigirEmpresa(dono, texto(v, 'empresa'));
      const login = normalizarLogin(texto(v, 'login'));
      cofre(); // falha antes de perguntar qualquer coisa se a chave mestra faltar
      const senha = await perguntarSenhaNova();
      const { segredo, passo } = await cadastrarTotpInterativo(login);
      await comEmpresa(dono, e.id, async (trx) => {
        const id = await criarUsuario(dono, trx, { empresaId: e.id, login, nome: texto(v, 'nome'), perfil: texto(v, 'perfil') });
        await definirSenha(trx, id, senha);
        await definirTotp(trx, cofre(), e.id, id, segredo, passo);
      });
      console.log(`Usuário ${login} criado em ${e.slug} com perfil ${texto(v, 'perfil')}. Entre com: pnpm forja-admin login`);
    } else if (sub === 'ativar') {
      const v = opcoes(args, { login: { type: 'string' } });
      const login = normalizarLogin(texto(v, 'login'));
      const achado = await buscarLogin(dono, login);
      if (!achado) throw new Error(`Login "${login}" não existe.`);
      cofre();
      await ativarUsuario(dono, achado.empresa_id, achado.usuario_id, login);
    } else {
      throw new Error('Use: forja-admin usuario criar | ativar');
    }
  });
}

// ---------------------------------------------------------------- ambiente

const ROTULOS: Record<keyof Credenciais, { rotulo: string; oculto: boolean }> = {
  web_usuario: { rotulo: 'Usuário do Sankhya web', oculto: false },
  web_senha: { rotulo: 'Senha do Sankhya web', oculto: true },
  gateway_client_id: { rotulo: 'Gateway client_id', oculto: false },
  gateway_client_secret: { rotulo: 'Gateway client_secret', oculto: true },
  gateway_token: { rotulo: 'Gateway X-Token', oculto: true },
};

async function ambiente(sub: string | undefined, args: string[]): Promise<void> {
  if (sub === 'cadastrar') {
    const v = opcoes(args, {
      empresa: { type: 'string' },
      url: { type: 'string' },
      'usuario-banco': { type: 'string' },
      'gateway-url': { type: 'string' },
      'somente-leitura': { type: 'boolean' },
    });
    const url = texto(v, 'url');
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      throw new Error('--url inválida.');
    }
    const dados = {
      url,
      hostPermitido: host,
      usuarioBancoEsperado: texto(v, 'usuario-banco'),
      gatewayUrl: typeof v['gateway-url'] === 'string' ? v['gateway-url'] : 'https://api.sandbox.sankhya.com.br',
      somenteLeitura: v['somente-leitura'] === true,
    };
    const problemas = verificarAmbiente(dados);
    if (problemas.length) throw new Error(`Trava de produção recusou o ambiente:\n- ${problemas.join('\n- ')}`);
    const c = cofre();
    const dono = bancoDono();
    await usar([dono], async () => {
      const e = await exigirEmpresa(dono, texto(v, 'empresa'));
      console.log('Credenciais (Enter vazio = manter a já gravada):');
      const credenciais: Credenciais = {};
      for (const tipo of TIPOS_CREDENCIAL) {
        const valor = (await perguntar(`  ${ROTULOS[tipo].rotulo}: `, ROTULOS[tipo].oculto)).trim();
        if (valor) credenciais[tipo] = valor;
      }
      const gravadas = await comEmpresa(dono, e.id, async (trx) => {
        const id = await gravarAmbiente(trx, e.id, dados);
        return gravarCredenciais(trx, c, e.id, id, credenciais);
      });
      console.log(`Ambiente teste de ${e.slug} gravado (${host}). Credenciais gravadas: ${gravadas.join(', ') || 'nenhuma'}.`);
      console.log(`Confira com: pnpm forja-admin ambiente testar --empresa ${e.slug}`);
    });
  } else if (sub === 'testar') {
    const v = opcoes(args, { empresa: { type: 'string' } });
    const c = cofre();
    const dono = bancoDono();
    const app = bancoApp();
    await usar([dono, app], async () => {
      const e = await exigirEmpresa(dono, texto(v, 'empresa'));
      // lê como o MCP vai ler: papel app, com RLS
      const a = await lerAmbiente(app, c, e.id);
      if (!a) throw new Error(`A empresa ${e.slug} não tem ambiente teste. Use importar-config ou ambiente cadastrar.`);
      for (const s of Object.values(a.credenciais)) registrarSegredo(s);
      console.log(`Ambiente teste de ${e.slug}: ${a.hostPermitido}`);
      const problemas = verificarAmbiente(a);
      if (problemas.length) throw new Error(`Trava de produção:\n- ${problemas.join('\n- ')}`);
      console.log('  ok  trava de produção (host de teste, https, Gateway conhecido)');
      const faltam = TIPOS_CREDENCIAL.filter((t) => !a.credenciais[t]);
      if (faltam.length) throw new Error(`Credenciais faltando: ${faltam.join(', ')}.`);
      console.log('  ok  5 credenciais presentes e decifradas (valores não exibidos)');
      const gateway = criarClienteReal({
        gatewayUrl: a.gatewayUrl,
        clientId: a.credenciais.gateway_client_id!,
        clientSecret: a.credenciais.gateway_client_secret!,
        xToken: a.credenciais.gateway_token!,
      });
      const obtido = comoObjetos(await gateway.executeQuery(SQL.usuarioBanco()))[0]?.USUARIO;
      if (!usuarioBancoConfere(obtido, a.usuarioBancoEsperado)) {
        throw new Error(`O Gateway respondeu como usuário de banco "${String(obtido)}", esperado "${a.usuarioBancoEsperado}".`);
      }
      console.log(`  ok  Gateway autenticou; SELECT USER = ${a.usuarioBancoEsperado}`);
      console.log('  --  login web (navegador) não é testado aqui; ele roda na primeira ferramenta de estrutura.');
    });
  } else {
    throw new Error('Use: forja-admin ambiente cadastrar | testar');
  }
}

// ---------------------------------------------------------------- importar config

async function importar(args: string[]): Promise<void> {
  const v = opcoes(args, { empresa: { type: 'string' } });
  const config = lerConfigParaImportar();
  const c = cofre();
  const dono = bancoDono();
  await usar([dono], async () => {
    const e = await exigirEmpresa(dono, texto(v, 'empresa'));
    const r = await importarConfig(dono, c, e.id, config);
    console.log(`Importado para ${e.slug}:`);
    console.log(`  ambiente teste   ${config.ambiente.hostPermitido} (usuário de banco ${config.ambiente.usuarioBancoEsperado.toUpperCase()})`);
    console.log(`  perfis           ${r.perfis.join(', ')} (${r.permissoes} permissões)`);
    console.log(`  usuários novos   ${r.usuariosNovos.join(', ') || '-'}`);
    console.log(`  usuários atualiz ${r.usuariosAtualizados.join(', ') || '-'}`);
    console.log(`  regras           fuso ${config.fuso}, limite ${config.regras.limiteRegistros}, instâncias ${r.instancias}`);
    console.log(`  credenciais      ${r.credenciais.join(', ') || 'nenhuma (FORJA_TESTE_* ausentes no .env)'}`);
    for (const login of r.usuariosNovos) console.log(`Próximo passo: pnpm forja-admin usuario ativar --login ${login}`);
  });
}

// ---------------------------------------------------------------- principal

async function principal(argv: string[]): Promise<void> {
  const [cmd, sub, ...resto] = argv;
  switch (cmd) {
    case 'login':
      return login();
    case 'logout':
      return logout();
    case 'empresa':
      return empresa(sub, resto);
    case 'usuario':
      return usuario(sub, resto);
    case 'ambiente':
      return ambiente(sub, resto);
    case 'importar-config':
      return importar(argv.slice(1));
    default:
      console.log(AJUDA);
      if (cmd && cmd !== 'ajuda' && cmd !== '--help') process.exitCode = 1;
  }
}

principal(process.argv.slice(2)).catch((e: unknown) => {
  console.error(mensagemSegura(e));
  process.exit(1);
});
