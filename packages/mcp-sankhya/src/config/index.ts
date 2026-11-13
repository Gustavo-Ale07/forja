import fs from 'node:fs';
import { parse as parseDotenv } from 'dotenv';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ForjaErro } from '../comum/erros.js';
import { registrarSegredo } from '../comum/mascara.js';
import { caminhos } from './caminhos.js';
import { esquemaConfig, type ConfigAmbiente, type ConfigArquivo } from './esquema.js';
import { AMBIENTE_FASE1, verificarTravaProducao } from './trava-producao.js';

export interface Credenciais {
  url: string;
  usuario: string;
  senha: string;
  clientId: string;
  clientSecret: string;
  xToken: string;
}

export interface ConfigForja {
  arquivo: ConfigArquivo;
  ambiente: string;
  configAmbiente: ConfigAmbiente;
  usuarioForja: string | undefined;
  /** Nunca sai deste processo: nem para log, nem para o modelo. */
  credenciais: Credenciais;
  chaveAprovacao: string;
  navegadorVisivel: boolean;
  caminhos: ReturnType<typeof caminhos>;
}

/** Lê o .env do repositório (sem poluir process.env) somado ao ambiente do processo. */
export function lerEnv(arquivo: string): Record<string, string | undefined> {
  const doArquivo = fs.existsSync(arquivo) ? parseDotenv(fs.readFileSync(arquivo)) : {};
  const env: Record<string, string | undefined> = { ...doArquivo };
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('FORJA_')) env[k] = v;
  return env;
}

const ehObjeto = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Mescla `local` sobre `base`: objetos campo a campo; listas e valores simples são substituídos. */
export function mesclarConfig(base: unknown, local: unknown): unknown {
  if (!ehObjeto(base) || !ehObjeto(local)) return local === undefined ? base : local;
  const r: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(local)) r[k] = k in base ? mesclarConfig(base[k], v) : v;
  return r;
}

function lerYaml(arquivo: string): unknown {
  try {
    return parseYaml(fs.readFileSync(arquivo, 'utf8'));
  } catch (e) {
    throw new ForjaErro('CONFIG_INVALIDA', `${arquivo} não é um YAML válido: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Lê o forja.config.yaml (genérico, versionado) e, se existir, o forja.config.local.yaml (valores reais
 * da sua base, fora do git) por cima. A validação e a trava de produção valem para o resultado mesclado.
 */
export function lerConfigArquivo(arquivo: string, arquivoLocal?: string): ConfigArquivo {
  if (!fs.existsSync(arquivo)) throw new ForjaErro('CONFIG_AUSENTE', `Arquivo ${arquivo} não encontrado.`);
  let bruto = lerYaml(arquivo);
  const temLocal = arquivoLocal !== undefined && fs.existsSync(arquivoLocal);
  if (temLocal) bruto = mesclarConfig(bruto, lerYaml(arquivoLocal) ?? {});
  const r = esquemaConfig.safeParse(bruto);
  if (!r.success) {
    const nome = temLocal ? 'forja.config.yaml + forja.config.local.yaml' : 'forja.config.yaml';
    throw new ForjaErro('CONFIG_INVALIDA', `${nome} inválido:\n${z.prettifyError(r.error)}`);
  }
  return r.data;
}

export const TAMANHO_MINIMO_CHAVE = 32;

/**
 * Carrega tudo e aplica a trava de produção. Qualquer problema = exceção (o servidor não inicia).
 */
export function carregarConfig(raiz?: string): ConfigForja {
  const c = caminhos(raiz);
  const env = lerEnv(c.env);
  const arquivo = lerConfigArquivo(c.config, c.configLocal);

  const problemas = verificarTravaProducao(arquivo, env);
  const ambiente = env.FORJA_AMBIENTE ?? AMBIENTE_FASE1;
  if (ambiente !== AMBIENTE_FASE1) problemas.push(`FORJA_AMBIENTE="${ambiente}": na fase 1 só "teste".`);

  const exigir = (nome: string): string => {
    const v = env[nome];
    if (!v) problemas.push(`${nome} não definido no .env.`);
    return v ?? '';
  };
  const credenciais: Credenciais = {
    url: exigir('FORJA_TESTE_URL'),
    usuario: exigir('FORJA_TESTE_USUARIO'),
    senha: exigir('FORJA_TESTE_SENHA'),
    clientId: exigir('FORJA_TESTE_GATEWAY_CLIENT_ID'),
    clientSecret: exigir('FORJA_TESTE_GATEWAY_CLIENT_SECRET'),
    xToken: exigir('FORJA_TESTE_GATEWAY_TOKEN'),
  };
  const chaveAprovacao = exigir('FORJA_CHAVE_APROVACAO');
  if (chaveAprovacao && chaveAprovacao.length < TAMANHO_MINIMO_CHAVE) {
    problemas.push(`FORJA_CHAVE_APROVACAO precisa ter pelo menos ${TAMANHO_MINIMO_CHAVE} caracteres.`);
  }
  for (const s of [credenciais.senha, credenciais.clientId, credenciais.clientSecret, credenciais.xToken, chaveAprovacao]) {
    registrarSegredo(s);
  }

  if (problemas.length) {
    throw new ForjaErro('INICIO_RECUSADO', `O servidor Forja recusou iniciar:\n- ${problemas.join('\n- ')}`);
  }
  return {
    arquivo,
    ambiente,
    configAmbiente: arquivo.ambientes[ambiente]!,
    usuarioForja: env.FORJA_USUARIO,
    credenciais,
    chaveAprovacao,
    navegadorVisivel: env.FORJA_NAVEGADOR_VISIVEL === '1',
    caminhos: c,
  };
}
