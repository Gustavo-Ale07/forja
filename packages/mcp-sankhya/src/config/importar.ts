import type { ConfigImportada, Credenciais } from '@forja/banco';
import type { ConfigArquivo } from './esquema.js';
import { AMBIENTE_FASE1, verificarAmbiente, verificarTravaProducao } from './trava-producao.js';

/** Variáveis do .env lidas (uma vez) pelo importar-config, por tipo de credencial no banco. */
export const VARIAVEIS_CREDENCIAL: Record<keyof Credenciais, string> = {
  web_usuario: 'FORJA_TESTE_USUARIO',
  web_senha: 'FORJA_TESTE_SENHA',
  gateway_client_id: 'FORJA_TESTE_GATEWAY_CLIENT_ID',
  gateway_client_secret: 'FORJA_TESTE_GATEWAY_CLIENT_SECRET',
  gateway_token: 'FORJA_TESTE_GATEWAY_TOKEN',
};

/**
 * Converte forja.config.yaml (+ local, já validado pelo zod) e o .env para o formato do banco,
 * aplicando a mesma trava de produção do servidor. Devolve os problemas em vez de lançar.
 */
export function paraConfigImportada(
  arquivo: ConfigArquivo,
  env: Record<string, string | undefined>,
): { config?: ConfigImportada; problemas: string[] } {
  const problemas = verificarTravaProducao(arquivo, env);
  const amb = arquivo.ambientes[AMBIENTE_FASE1];
  const url = env.FORJA_TESTE_URL;
  if (!amb || !url) return { problemas };
  const ambiente = {
    url,
    hostPermitido: amb.host_permitido,
    usuarioBancoEsperado: amb.usuario_banco_esperado,
    gatewayUrl: amb.gateway_url,
    somenteLeitura: amb.somente_leitura,
  };
  for (const p of verificarAmbiente(ambiente)) if (!problemas.includes(p)) problemas.push(p);
  if (problemas.length) return { problemas };

  const credenciais: Credenciais = {};
  for (const [tipo, variavel] of Object.entries(VARIAVEIS_CREDENCIAL) as Array<[keyof Credenciais, string]>) {
    const v = env[variavel];
    if (v) credenciais[tipo] = v;
  }

  const r = arquivo.regras;
  return {
    problemas,
    config: {
      fuso: arquivo.fuso,
      ambiente,
      perfis: Object.entries(arquivo.perfis).map(([nome, p]) => ({
        nome,
        descricao: p.descricao,
        ambientes: p.ambientes,
        acoes: p.acoes,
        tabelasBloqueadas: p.tabelas_bloqueadas,
      })),
      usuarios: arquivo.usuarios,
      regras: {
        horario: r.horario,
        limiteRegistros: r.limite_registros_por_execucao,
        leituraBloqueada: r.leitura_bloqueada,
        gravacaoNativaLiberada: r.gravacao_nativa_liberada,
      },
      instancias: arquivo.instancias,
      credenciais,
    },
  };
}
