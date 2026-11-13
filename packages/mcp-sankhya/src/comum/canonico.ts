import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Campos de controle que não fazem parte dos parâmetros "de negócio" de um passo. */
export const CAMPOS_CONTROLE = ['plano_id', 'passo_id', 'token_confirmacao'] as const;

/** JSON canônico: chaves ordenadas, `undefined` omitido. Mesma entrada → mesmo texto. */
export function canonico(valor: unknown): string {
  return JSON.stringify(ordenar(valor));
}

function ordenar(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(ordenar);
  if (v && typeof v === 'object') {
    const saida: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) saida[k] = ordenar(x);
    }
    return saida;
  }
  return v;
}

export function sha256(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

/** Hash dos parâmetros de uma chamada, sem os campos de controle. */
export function hashParametros(parametros: Record<string, unknown>): string {
  const semControle: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parametros)) {
    if (!(CAMPOS_CONTROLE as readonly string[]).includes(k)) semControle[k] = v;
  }
  return sha256(canonico(semControle));
}

export function hmac(conteudo: string, chave: string): string {
  return createHmac('sha256', chave).update(conteudo, 'utf8').digest('hex');
}

/** Comparação em tempo constante de dois hex. */
export function hexIguais(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
