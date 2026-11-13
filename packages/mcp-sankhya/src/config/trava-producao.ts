import type { ConfigArquivo } from './esquema.js';

/** Fase 1: o único ambiente que pode existir. */
export const AMBIENTE_FASE1 = 'teste';

/** Marcas genéricas de ambiente não produtivo que o host permitido precisa ter. */
const MARCA_NAO_PRODUCAO = /(teste|test|homolog|hml|sandbox|sbx|dev|qa)/i;

export interface EnvRelevante {
  FORJA_TESTE_URL?: string | undefined;
  [k: string]: string | undefined;
}

/**
 * Recusa iniciar quando algo parece produção. Devolve a lista de problemas (vazia = ok).
 * Nada aqui é fixo de uma empresa: o host aceito vem do forja.config.yaml (ou do forja.config.local.yaml).
 */
export function verificarTravaProducao(config: ConfigArquivo, env: EnvRelevante): string[] {
  const problemas: string[] = [];

  const nomesAmbientes = Object.keys(config.ambientes);
  const extras = nomesAmbientes.filter((n) => n !== AMBIENTE_FASE1);
  if (extras.length) {
    problemas.push(
      `forja.config.yaml define ambientes além de "${AMBIENTE_FASE1}" (${extras.join(', ')}). Na fase 1 só o ambiente de teste pode existir.`,
    );
  }
  const amb = config.ambientes[AMBIENTE_FASE1];
  if (!amb) {
    problemas.push(`forja.config.yaml não define o ambiente "${AMBIENTE_FASE1}".`);
    return problemas;
  }
  if (!MARCA_NAO_PRODUCAO.test(amb.host_permitido)) {
    problemas.push(
      `host_permitido "${amb.host_permitido}" não tem marca de ambiente de teste (teste/homolog/sandbox...) e parece produção.`,
    );
  }

  const prodVars = Object.keys(env).filter((k) => /^FORJA_PROD/i.test(k) && env[k]);
  if (prodVars.length) {
    problemas.push(`Variáveis de produção presentes no ambiente: ${prodVars.join(', ')}. Remova-as.`);
  }

  const bruto = env.FORJA_TESTE_URL;
  if (!bruto) {
    problemas.push('FORJA_TESTE_URL não definido no .env.');
  } else {
    let url: URL | undefined;
    try {
      url = new URL(bruto);
    } catch {
      problemas.push('FORJA_TESTE_URL não é uma URL válida.');
    }
    if (url) {
      if (url.protocol !== 'https:') problemas.push('FORJA_TESTE_URL precisa usar https.');
      if (url.hostname.toLowerCase() !== amb.host_permitido) {
        problemas.push(
          `FORJA_TESTE_URL aponta para "${url.hostname}", mas o host permitido do ambiente teste é "${amb.host_permitido}".`,
        );
      }
      if (url.username || url.password) problemas.push('FORJA_TESTE_URL não pode conter usuário/senha.');
    }
  }

  let gw: URL | undefined;
  try {
    gw = new URL(amb.gateway_url);
  } catch {
    problemas.push('gateway_url inválida.');
  }
  if (gw) {
    if (gw.protocol !== 'https:') problemas.push('gateway_url precisa usar https.');
    if (!config.gateway_hosts_permitidos.map((h) => h.toLowerCase()).includes(gw.hostname.toLowerCase())) {
      problemas.push(`gateway_url "${gw.hostname}" não está em gateway_hosts_permitidos.`);
    }
  }
  return problemas;
}

/** Normaliza o resultado de SELECT USER FROM DUAL e compara com o esperado. */
export function usuarioBancoConfere(obtido: unknown, esperado: string): boolean {
  return typeof obtido === 'string' && obtido.trim().toUpperCase() === esperado.trim().toUpperCase();
}
