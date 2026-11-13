import fs from 'node:fs';
import { parse as parseDotenv } from 'dotenv';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { ForjaErro } from '../comum/erros.js';
import { esquemaConfig, type ConfigArquivo } from './esquema.js';

export interface Credenciais {
  url: string;
  usuario: string;
  senha: string;
  clientId: string;
  clientSecret: string;
  xToken: string;
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

