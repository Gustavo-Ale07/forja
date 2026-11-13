/**
 * Banco de TESTES (forja_teste, no Postgres do docker compose). Os padrões são as senhas de
 * desenvolvimento do docker-compose.yml; dá para trocar pelas variáveis abaixo.
 */
export const URL_DONO =
  process.env.FORJA_BANCO_TESTE_DONO_URL ?? 'postgres://forja_dono:forja-local-dono@127.0.0.1:55433/forja_teste';
export const URL_APP =
  process.env.FORJA_BANCO_TESTE_APP_URL ?? 'postgres://forja_app:forja-local-app@127.0.0.1:55433/forja_teste';
