import crypto from 'node:crypto';

/** Texto cifrado + a versão da chave que o cifrou (para trocar a chave no futuro). */
export interface Cifrado {
  cifrado: string;
  versaoChave: number;
}

/**
 * Cofre de segredos. O resto do sistema só conhece esta interface: trocar AES local por
 * Vault/KMS é escrever outra implementação.
 *
 * `contexto` amarra o segredo ao lugar onde ele foi gravado (ex.: credencial:<empresa>:<ambiente>:<tipo>).
 * Decifrar com outro contexto falha: copiar o texto cifrado para outra linha/empresa não funciona.
 */
export interface Cofre {
  cifrar(texto: string, contexto: string): Promise<Cifrado>;
  decifrar(c: Cifrado, contexto: string): Promise<string>;
}

export class ErroCofre extends Error {
  override readonly name = 'ErroCofre';
}

const PREFIXO = 'aesgcm';
const TAM_IV = 12;
const TAM_TAG = 16;

/**
 * Lê uma chave mestra de 32 bytes em hex (64 caracteres) ou base64. Nunca inclui o valor em erro.
 */
export function lerChaveMestra(texto: string | undefined, nome = 'FORJA_CHAVE_MESTRA'): Buffer {
  const t = (texto ?? '').trim();
  if (!t) throw new ErroCofre(`${nome} não definido no .env.`);
  const chave = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  if (chave.length !== 32) {
    throw new ErroCofre(
      `${nome} precisa ter 32 bytes (64 caracteres hex ou base64). Gere com: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return chave;
}

/**
 * AES-256-GCM com chave mestra local. Formato: aesgcm.<iv>.<tag>.<dado> (base64url), IV aleatório
 * de 96 bits por cifragem, contexto como dado autenticado (AAD).
 */
export class CofreAesGcm implements Cofre {
  private readonly chaves: ReadonlyMap<number, Buffer>;

  /** @param chaves versão → chave de 32 bytes; @param versaoAtual a usada para cifrar. */
  constructor(
    chaves: ReadonlyMap<number, Buffer> | Buffer,
    private readonly versaoAtual = 1,
  ) {
    this.chaves = Buffer.isBuffer(chaves) ? new Map([[1, chaves]]) : chaves;
    for (const [v, k] of this.chaves) {
      if (k.length !== 32) throw new ErroCofre(`Chave da versão ${v} não tem 32 bytes.`);
    }
    if (!this.chaves.has(versaoAtual)) throw new ErroCofre(`Não há chave para a versão atual (${versaoAtual}).`);
  }

  async cifrar(texto: string, contexto: string): Promise<Cifrado> {
    if (!contexto) throw new ErroCofre('Contexto vazio: todo segredo precisa estar amarrado a um lugar.');
    const iv = crypto.randomBytes(TAM_IV);
    const c = crypto.createCipheriv('aes-256-gcm', this.chaves.get(this.versaoAtual)!, iv, { authTagLength: TAM_TAG });
    c.setAAD(Buffer.from(contexto, 'utf8'));
    const dado = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
    const tag = c.getAuthTag();
    return {
      cifrado: [PREFIXO, iv.toString('base64url'), tag.toString('base64url'), dado.toString('base64url')].join('.'),
      versaoChave: this.versaoAtual,
    };
  }

  async decifrar(c: Cifrado, contexto: string): Promise<string> {
    const chave = this.chaves.get(c.versaoChave);
    if (!chave) throw new ErroCofre(`Não há chave para a versão ${c.versaoChave}.`);
    const partes = c.cifrado.split('.');
    if (partes.length !== 4 || partes[0] !== PREFIXO) throw new ErroCofre('Formato de segredo cifrado desconhecido.');
    const [, ivB, tagB, dadoB] = partes as [string, string, string, string];
    const iv = Buffer.from(ivB, 'base64url');
    const tag = Buffer.from(tagB, 'base64url');
    if (iv.length !== TAM_IV || tag.length !== TAM_TAG) throw new ErroCofre('Segredo cifrado corrompido.');
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', chave, iv, { authTagLength: TAM_TAG });
      d.setAAD(Buffer.from(contexto, 'utf8'));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(Buffer.from(dadoB, 'base64url')), d.final()]).toString('utf8');
    } catch {
      // Mesma mensagem para chave errada, dado adulterado ou contexto trocado: não ajuda quem tenta adivinhar.
      throw new ErroCofre('Não foi possível decifrar o segredo (chave errada, dado adulterado ou segredo de outro lugar).');
    }
  }
}
