import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CofreAesGcm, ErroCofre, lerChaveMestra } from '../src/cofre.js';

const chave = () => crypto.randomBytes(32);
const SEGREDO = 'senha-falsa-de-teste-123';

describe('Cofre AES-256-GCM', () => {
  it('ida e volta com o mesmo contexto', async () => {
    const cofre = new CofreAesGcm(chave());
    const c = await cofre.cifrar(SEGREDO, 'credencial:a:b:web_senha');
    expect(c.versaoChave).toBe(1);
    expect(c.cifrado).not.toContain(SEGREDO);
    expect(await cofre.decifrar(c, 'credencial:a:b:web_senha')).toBe(SEGREDO);
  });

  it('IV aleatório: o mesmo segredo cifrado duas vezes dá textos diferentes', async () => {
    const cofre = new CofreAesGcm(chave());
    const a = await cofre.cifrar(SEGREDO, 'x');
    const b = await cofre.cifrar(SEGREDO, 'x');
    expect(a.cifrado).not.toBe(b.cifrado);
  });

  it('contexto trocado (outra linha/empresa) não decifra', async () => {
    const cofre = new CofreAesGcm(chave());
    const c = await cofre.cifrar(SEGREDO, 'credencial:empresa-a:amb:web_senha');
    await expect(cofre.decifrar(c, 'credencial:empresa-b:amb:web_senha')).rejects.toThrow(ErroCofre);
    await expect(cofre.decifrar(c, 'credencial:empresa-a:amb:gateway_token')).rejects.toThrow(ErroCofre);
  });

  it('chave errada não decifra', async () => {
    const c = await new CofreAesGcm(chave()).cifrar(SEGREDO, 'x');
    await expect(new CofreAesGcm(chave()).decifrar(c, 'x')).rejects.toThrow(/Não foi possível decifrar/);
  });

  it('qualquer byte adulterado (iv, tag ou dado) é detectado', async () => {
    const cofre = new CofreAesGcm(chave());
    const c = await cofre.cifrar(SEGREDO, 'x');
    const partes = c.cifrado.split('.');
    for (const i of [1, 2, 3]) {
      const bytes = Buffer.from(partes[i]!, 'base64url');
      bytes[0] = bytes[0]! ^ 0x01;
      const adulterado = [...partes];
      adulterado[i] = bytes.toString('base64url');
      await expect(cofre.decifrar({ ...c, cifrado: adulterado.join('.') }, 'x')).rejects.toThrow(ErroCofre);
    }
    await expect(cofre.decifrar({ ...c, cifrado: 'lixo' }, 'x')).rejects.toThrow(/Formato/);
  });

  it('versão de chave: cifra com a atual e decifra versões antigas', async () => {
    const v1 = chave();
    const v2 = chave();
    const antigo = await new CofreAesGcm(new Map([[1, v1]]), 1).cifrar(SEGREDO, 'x');
    const cofre = new CofreAesGcm(new Map([[1, v1], [2, v2]]), 2);
    expect(await cofre.decifrar(antigo, 'x')).toBe(SEGREDO);
    const novo = await cofre.cifrar(SEGREDO, 'x');
    expect(novo.versaoChave).toBe(2);
    await expect(new CofreAesGcm(v1).decifrar(novo, 'x')).rejects.toThrow(/versão 2/);
  });

  it('contexto vazio é recusado', async () => {
    await expect(new CofreAesGcm(chave()).cifrar(SEGREDO, '')).rejects.toThrow(/Contexto vazio/);
  });
});

describe('chave mestra do .env', () => {
  it('aceita 64 hex ou base64 de 32 bytes', () => {
    const k = chave();
    expect(lerChaveMestra(k.toString('hex')).equals(k)).toBe(true);
    expect(lerChaveMestra(k.toString('base64')).equals(k)).toBe(true);
  });

  it('recusa vazia ou de tamanho errado, sem mostrar o valor', () => {
    expect(() => lerChaveMestra(undefined)).toThrow(/não definido/);
    let msg = '';
    try {
      lerChaveMestra('chave-curta-secreta');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/32 bytes/);
    expect(msg).not.toContain('chave-curta-secreta');
  });
});
