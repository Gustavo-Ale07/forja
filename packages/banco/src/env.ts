import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';

/** Raiz do repositório (packages/banco/{src,dist}/env.js → ../../..). */
export function raizRepositorio(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/** .env da raiz (sem poluir process.env) somado às variáveis FORJA_* do processo. */
export function lerEnv(arquivo = path.join(raizRepositorio(), '.env')): Record<string, string | undefined> {
  const doArquivo = fs.existsSync(arquivo) ? parseDotenv(fs.readFileSync(arquivo)) : {};
  const env: Record<string, string | undefined> = { ...doArquivo };
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('FORJA_')) env[k] = v;
  return env;
}

export function exigirEnv(env: Record<string, string | undefined>, nome: string): string {
  const v = env[nome];
  if (!v) throw new Error(`${nome} não definido no .env.`);
  return v;
}
