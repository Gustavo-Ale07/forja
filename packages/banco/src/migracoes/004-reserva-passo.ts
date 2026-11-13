/**
 * 004 — Reserva do passo antes de executar.
 *
 * Antes de mandar um passo de plano ao Sankhya, o servidor grava na auditoria uma linha
 * "em_execucao" (a reserva). O desfecho (aceito, erro ou recusado) é outra linha, que aponta para
 * a reserva em reserva_id. Reserva sem desfecho = o servidor caiu no meio ou a auditoria falhou:
 * o passo fica recusado até uma conferência manual (forja-aprovar --conferir). A tabela continua
 * só INSERT.
 */
export const SQL_004 = String.raw`
ALTER TABLE chamada_ferramenta DROP CONSTRAINT chamada_ferramenta_resultado_check;
ALTER TABLE chamada_ferramenta ADD CONSTRAINT chamada_ferramenta_resultado_check
  CHECK (resultado IN ('aceito', 'recusado', 'erro', 'em_execucao'));

ALTER TABLE chamada_ferramenta ADD COLUMN reserva_id bigint REFERENCES chamada_ferramenta(id);
ALTER TABLE chamada_ferramenta ADD CONSTRAINT chamada_reserva_coerente CHECK (
  (resultado = 'em_execucao' AND reserva_id IS NULL AND plano_id IS NOT NULL AND passo_id IS NOT NULL)
  OR resultado <> 'em_execucao'
);
-- No máximo um desfecho por reserva.
CREATE UNIQUE INDEX ux_chamada_desfecho_unico ON chamada_ferramenta (reserva_id) WHERE reserva_id IS NOT NULL;
CREATE INDEX ix_chamada_reservas ON chamada_ferramenta (empresa_id, plano_id, passo_id) WHERE resultado = 'em_execucao';
`;
