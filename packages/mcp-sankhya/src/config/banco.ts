import {
  CofreAesGcm,
  criarBanco,
  lerAmbiente,
  lerChaveMestra,
  lerConfigEmpresa,
  lerSessaoLocal,
  resolverSessao,
  TIPOS_CREDENCIAL,
  type AmbienteComCredenciais,
  type ConfigEmpresa,
  type Db,
  type SessaoLocal,
} from '@forja/banco';
import { ForjaErro } from '../comum/erros.js';
import { mensagemSegura, registrarSegredo } from '../comum/mascara.js';
import type { Identidade } from '../servidor/executor.js';
import { caminhos } from './caminhos.js';
import type { ConfigAmbiente, ConfigArquivo } from './esquema.js';
import { lerEnv, TAMANHO_MINIMO_CHAVE, type Credenciais } from './index.js';
import { AMBIENTE_FASE1, GATEWAY_HOSTS_FIXOS, verificarAmbiente } from './trava-producao.js';

const COMO_ENTRAR = 'Rode no seu terminal: pnpm forja-admin login';

/** Monta o formato que o porteiro usa a partir do banco (permissões da empresa + ambiente teste). */
export function montarConfigArquivo(emp: ConfigEmpresa, amb: Pick<AmbienteComCredenciais, 'hostPermitido' | 'usuarioBancoEsperado' | 'gatewayUrl' | 'somenteLeitura'>): ConfigArquivo {
  const ambiente: ConfigAmbiente = {
    host_permitido: amb.hostPermitido.toLowerCase(),
    usuario_banco_esperado: amb.usuarioBancoEsperado.toUpperCase(),
    gateway_url: amb.gatewayUrl,
    somente_leitura: amb.somenteLeitura ?? false,
  };
  return {
    fuso: emp.fuso,
    gateway_hosts_permitidos: [...GATEWAY_HOSTS_FIXOS],
    ambientes: { [AMBIENTE_FASE1]: ambiente },
    perfis: Object.fromEntries(
      emp.perfis.map((p) => [
        p.nome,
        { ...(p.descricao ? { descricao: p.descricao } : {}), ambientes: p.ambientes, acoes: p.acoes, tabelas_bloqueadas: p.tabelasBloqueadas.map((t) => t.toUpperCase()) },
      ]),
    ),
    usuarios: emp.usuarios,
    regras: {
      ...(emp.regras.horario ? { horario: emp.regras.horario } : {}),
      limite_registros_por_execucao: emp.regras.limiteRegistros,
      leitura_bloqueada: emp.regras.leituraBloqueada.map((t) => t.toUpperCase()),
      gravacao_nativa_liberada: emp.regras.gravacaoNativaLiberada.map((t) => t.toUpperCase()),
    },
    instancias: Object.fromEntries(Object.entries(emp.instancias).map(([k, v]) => [k.toUpperCase(), v])),
  };
}

/** Sessão local → sessão válida no banco. Lança com a instrução de login quando não há. */
export async function sessaoAtiva(
  app: Db,
  ler: () => SessaoLocal | undefined = lerSessaoLocal,
  agora = new Date(),
): Promise<{ usuarioId: string; empresaId: string; login: string }> {
  const local = ler();
  if (!local) throw new ForjaErro('SEM_SESSAO', `Nenhuma sessão da Forja nesta máquina. ${COMO_ENTRAR}`);
  const s = await resolverSessao(app, local.token, agora);
  if (s.status !== 'valida') {
    const porque = { expirada: 'expirou', revogada: 'foi encerrada (logout ou troca de senha/TOTP)', usuario_inativo: 'é de um usuário desativado', inexistente: 'não existe no banco' }[s.status];
    throw new ForjaErro('SEM_SESSAO', `A sessão da Forja ${porque}. ${COMO_ENTRAR}`);
  }
  return { usuarioId: s.usuarioId, empresaId: s.empresaId, login: s.login };
}

/**
 * Identidade de cada chamada: a sessão precisa continuar válida e ser da mesma empresa com que o
 * servidor subiu; as permissões são relidas do banco (mudança de perfil vale na hora).
 */
export function criarIdentidade(
  app: Db,
  empresaId: string,
  ambiente: Pick<AmbienteComCredenciais, 'hostPermitido' | 'usuarioBancoEsperado' | 'gatewayUrl' | 'somenteLeitura'>,
  ler: () => SessaoLocal | undefined = lerSessaoLocal,
  agora: () => Date = () => new Date(),
): () => Promise<Identidade> {
  return async () => {
    const s = await sessaoAtiva(app, ler, agora());
    if (s.empresaId !== empresaId) {
      throw new ForjaErro('SEM_SESSAO', 'A sessão atual é de outra empresa. Reinicie o servidor MCP para trocar de empresa.');
    }
    return { usuario: s.login, usuarioId: s.usuarioId, config: montarConfigArquivo(await lerConfigEmpresa(app, empresaId), ambiente) };
  };
}

export interface ConfigServidor {
  app: Db;
  empresaId: string;
  usuarioId: string;
  login: string;
  ambiente: string;
  arquivo: ConfigArquivo;
  configAmbiente: ConfigAmbiente;
  /** Nunca sai deste processo: nem para log, nem para o modelo. */
  credenciais: Credenciais;
  chaveAprovacao: string;
  navegadorVisivel: boolean;
  caminhos: ReturnType<typeof caminhos>;
  identidade: () => Promise<Identidade>;
}

/**
 * Carrega a configuração do servidor a partir do Postgres e aplica a trava de produção.
 * Qualquer problema = exceção (o servidor não inicia). Do .env só vêm a URL do banco, a chave
 * mestra, a chave de aprovação e opções locais; credenciais e permissões vêm do banco.
 */
export async function carregarConfigBanco(
  o: { raiz?: string; lerSessao?: () => SessaoLocal | undefined } = {},
): Promise<ConfigServidor> {
  const c = caminhos(o.raiz);
  const lerSessao = o.lerSessao ?? lerSessaoLocal;
  const env = lerEnv(c.env);
  const problemas: string[] = [];

  const ambiente = env.FORJA_AMBIENTE ?? AMBIENTE_FASE1;
  if (ambiente !== AMBIENTE_FASE1) problemas.push(`FORJA_AMBIENTE="${ambiente}": nesta fase só "teste".`);
  const prodVars = Object.keys(env).filter((k) => /^FORJA_PROD/i.test(k) && env[k]);
  if (prodVars.length) problemas.push(`Variáveis de produção presentes no ambiente: ${prodVars.join(', ')}. Remova-as.`);
  const exigir = (nome: string): string => {
    const v = env[nome];
    if (!v) problemas.push(`${nome} não definido no .env.`);
    return v ?? '';
  };
  const urlBanco = exigir('FORJA_DATABASE_URL');
  const chaveAprovacao = exigir('FORJA_CHAVE_APROVACAO');
  if (chaveAprovacao && chaveAprovacao.length < TAMANHO_MINIMO_CHAVE) {
    problemas.push(`FORJA_CHAVE_APROVACAO precisa ter pelo menos ${TAMANHO_MINIMO_CHAVE} caracteres.`);
  }
  registrarSegredo(chaveAprovacao);
  let cofre: CofreAesGcm | undefined;
  try {
    cofre = new CofreAesGcm(lerChaveMestra(env.FORJA_CHAVE_MESTRA));
  } catch (e) {
    problemas.push(mensagemSegura(e));
  }
  const recusar = (): never => {
    throw new ForjaErro('INICIO_RECUSADO', `O servidor Forja recusou iniciar:\n- ${problemas.join('\n- ')}`);
  };
  if (problemas.length || !cofre) recusar();

  const app = criarBanco(urlBanco, 4);
  try {
    const s = await sessaoAtiva(app, lerSessao).catch((e: unknown) => {
      problemas.push(mensagemSegura(e));
      return recusar();
    });
    const amb = await lerAmbiente(app, cofre!, s.empresaId);
    if (!amb) {
      problemas.push('A empresa da sessão não tem ambiente teste cadastrado. Rode: pnpm forja-admin importar-config (ou ambiente cadastrar).');
      recusar();
    }
    for (const v of Object.values(amb!.credenciais)) registrarSegredo(v);
    problemas.push(...verificarAmbiente(amb!));
    const faltam = TIPOS_CREDENCIAL.filter((t) => !amb!.credenciais[t]);
    if (faltam.length) problemas.push(`Credenciais do ambiente teste faltando no banco: ${faltam.join(', ')}.`);
    if (problemas.length) recusar();

    const identidade = criarIdentidade(app, s.empresaId, amb!, lerSessao);
    const { config: arquivo } = await identidade();
    const k = amb!.credenciais;
    return {
      app,
      empresaId: s.empresaId,
      usuarioId: s.usuarioId,
      login: s.login,
      ambiente,
      arquivo,
      configAmbiente: arquivo.ambientes[AMBIENTE_FASE1]!,
      credenciais: {
        url: amb!.url,
        usuario: k.web_usuario!,
        senha: k.web_senha!,
        clientId: k.gateway_client_id!,
        clientSecret: k.gateway_client_secret!,
        xToken: k.gateway_token!,
      },
      chaveAprovacao,
      navegadorVisivel: env.FORJA_NAVEGADOR_VISIVEL === '1',
      caminhos: c,
      identidade,
    };
  } catch (e) {
    await app.destroy();
    throw e;
  }
}
