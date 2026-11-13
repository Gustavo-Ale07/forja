import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Raiz do repositório forja. Este arquivo fica em src/config (ou dist/config), quatro níveis
 * abaixo da raiz. FORJA_RAIZ sobrescreve (usado em testes).
 */
export function raizForja(): string {
  if (process.env.FORJA_RAIZ) return path.resolve(process.env.FORJA_RAIZ);
  const aqui = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(aqui, '..', '..', '..', '..');
}

export const caminhos = (raiz = raizForja()) => ({
  raiz,
  env: path.join(raiz, '.env'),
  config: path.join(raiz, 'forja.config.yaml'),
  /** Valores reais da sua base (fora do git). Lido por cima do forja.config.yaml. */
  configLocal: path.join(raiz, 'forja.config.local.yaml'),
  planos: path.join(raiz, 'planos'),
  auditoria: path.join(raiz, 'auditoria'),
  capturas: path.join(raiz, 'auditoria', 'capturas'),
});
