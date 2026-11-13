/**
 * Máscara de segredos. Tudo que vai para log, auditoria ou para o modelo passa por aqui.
 * Duas defesas: (1) valores conhecidos (registrados na carga do .env) são trocados por ***
 * onde aparecerem; (2) chaves/colunas com nome sensível têm o valor trocado por ***.
 */

/** Nomes de coluna cujo valor nunca é devolvido (pedido do usuário, item 7). */
export const PADRAO_COLUNA_SECRETA = /SENHA|PASSWORD|TOKEN|SECRET|CHAVE|KEY/i;

/** Nomes de chave de objeto mascarados em log/auditoria (inclui AUTH e afins). */
const PADRAO_CHAVE_SECRETA = /SENHA|PASSWORD|PASSWD|TOKEN|SECRET|CHAVE|KEY|AUTH|CREDENCIA/i;

export const MASCARA = '***';

const valoresSecretos = new Set<string>();

/** Registra um valor sensível (senha, client secret, token) para ser mascarado onde aparecer. */
export function registrarSegredo(valor: string | undefined): void {
  if (valor && valor.length >= 4) valoresSecretos.add(valor);
}

export function ehNomeSecreto(nome: string): boolean {
  return PADRAO_CHAVE_SECRETA.test(nome);
}

export function ehColunaSecreta(nome: string): boolean {
  return PADRAO_COLUNA_SECRETA.test(nome);
}

/** Códigos de cor/controle de terminal (ANSI), como os do call log do Playwright. */
const PADRAO_ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export function mascararTexto(texto: string): string {
  let r = texto.replace(PADRAO_ANSI, '');
  for (const v of valoresSecretos) r = r.split(v).join(MASCARA);
  r = r.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${MASCARA}`);
  r = r.replace(
    /((?:client_secret|client_id|password|senha|token|x-token|secret)["']?\s*[:=]\s*["']?)[^"'&\s,}]+/gi,
    `$1${MASCARA}`,
  );
  return r;
}

/** Cópia profunda com segredos mascarados (por nome de chave e por valor conhecido). */
export function mascarar(valor: unknown, profundidade = 0): unknown {
  if (profundidade > 20) return '[profundo demais]';
  if (typeof valor === 'string') return mascararTexto(valor);
  if (Array.isArray(valor)) return valor.map((v) => mascarar(v, profundidade + 1));
  if (valor && typeof valor === 'object') {
    const saida: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      saida[k] =
        ehNomeSecreto(k) && v !== null && typeof v !== 'object'
          ? MASCARA
          : mascarar(v, profundidade + 1);
    }
    return saida;
  }
  return valor;
}

/** Mensagem segura de um erro qualquer (sem pilha, sem segredos). */
export function mensagemSegura(erro: unknown): string {
  const msg = erro instanceof Error ? erro.message : String(erro);
  return mascararTexto(msg).slice(0, 2000);
}
