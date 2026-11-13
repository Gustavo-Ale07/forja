/** Erro com código estável. A mensagem já deve estar sem segredos (ver mascara.ts). */
export class ForjaErro extends Error {
  constructor(
    readonly codigo: string,
    mensagem: string,
    readonly detalhes?: Record<string, unknown>,
  ) {
    super(mensagem);
    this.name = 'ForjaErro';
  }
}

export const ehForjaErro = (e: unknown): e is ForjaErro => e instanceof ForjaErro;

/**
 * Erro do navegador como as ferramentas o registram: um ForjaErro passa como está (a mensagem
 * já é nossa); qualquer outro (Playwright: seletores, call log, códigos de cor) vira uma frase
 * fixa com o nome do passo. O detalhe técnico fica só na captura.
 */
export function erroNavegador(e: unknown, passo: string, onde = 'do Construtor de Telas', detalhes?: Record<string, unknown>): ForjaErro {
  if (e instanceof ForjaErro) return new ForjaErro(e.codigo, e.message, { ...e.detalhes, passo, ...detalhes });
  return new ForjaErro('NAVEGADOR_PASSO', `Falha no passo "${passo}" ${onde}.`, { passo, ...detalhes });
}
