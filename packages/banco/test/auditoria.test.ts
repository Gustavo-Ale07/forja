import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { criarEmpresa } from '../src/admin.js';
import { listarChamadas, passoExecutado, registrarChamada, reservaPendente, reservarPasso } from '../src/auditoria.js';
import { criarBanco, type Db } from '../src/conexao.js';
import { URL_APP, URL_DONO } from './urls.js';

let dono: Db;
let app: Db;
const nova = (nome: string) => criarEmpresa(dono, { nome, slug: `aud-${crypto.randomBytes(3).toString('hex')}` });
const base = { ambiente: 'teste', ferramenta: 'gravar_registros', parametrosJson: '{"x":1}', planoId: 'p', passoId: 1 } as const;

beforeAll(() => {
  dono = criarBanco(URL_DONO, 2);
  app = criarBanco(URL_APP, 2);
});
afterAll(async () => {
  await dono.destroy();
  await app.destroy();
});

describe('auditoria no Postgres', () => {
  it('registra e lista no intervalo, em ordem, com os JSONs', async () => {
    const e = await nova('A');
    const t = new Date('2026-11-11T13:00:00Z');
    await registrarChamada(app, e.id, { ...base, usuario: 'fulano', perfil: 'dev', resultado: 'aceito', motivo: 'previa', antesJson: '[{"a":1}]' }, t);
    await registrarChamada(app, e.id, { ...base, resultado: 'recusado', motivo: 'x' }, new Date(t.getTime() + 1000));
    await registrarChamada(app, e.id, { ...base, resultado: 'aceito', motivo: 'fora' }, new Date('2026-11-12T13:00:00Z'));
    const l = await listarChamadas(app, e.id, new Date('2026-11-11T03:00:00Z'), new Date('2026-11-12T03:00:00Z'));
    expect(l.map((c) => c.motivo)).toEqual(['previa', 'x']);
    expect(l[0]).toMatchObject({ usuario: 'fulano', perfil: 'dev', parametros: { x: 1 }, antes: [{ a: 1 }], depois: null, plano_id: 'p', passo_id: 1 });
  });

  it('passoExecutado só conta execução efetiva aceita, e só da própria empresa', async () => {
    const a = await nova('A');
    const b = await nova('B');
    await registrarChamada(app, a.id, { ...base, resultado: 'aceito', motivo: 'previa' });
    await registrarChamada(app, a.id, { ...base, resultado: 'erro', motivo: 'executado' });
    expect(await passoExecutado(app, a.id, 'p', 1)).toBe(false);
    await registrarChamada(app, b.id, { ...base, resultado: 'aceito', motivo: 'executado' });
    expect(await passoExecutado(app, a.id, 'p', 1)).toBe(false);
    expect(await passoExecutado(app, b.id, 'p', 1)).toBe(true);
    await registrarChamada(app, a.id, { ...base, resultado: 'aceito', motivo: 'já existia' });
    expect(await passoExecutado(app, a.id, 'p', 1)).toBe(true);
  });

  it('uma empresa não lista a auditoria da outra', async () => {
    const a = await nova('A');
    const b = await nova('B');
    await registrarChamada(app, b.id, { ...base, resultado: 'aceito', motivo: 'segredo de B' });
    const l = await listarChamadas(app, a.id, new Date(0), new Date('2100-01-01'));
    expect(l).toEqual([]);
  });
});

describe('reserva do passo antes de executar', () => {
  it('reserva, fecha com desfecho e só então o passo conta como executado', async () => {
    const e = await nova('R');
    const r = await reservarPasso(app, e.id, base);
    if (!r.reservado) throw new Error('devia reservar');
    expect(await reservaPendente(app, e.id, 'p', 1)).toMatchObject({ id: r.reservaId, resultado: 'em_execucao' });
    await registrarChamada(app, e.id, { ...base, resultado: 'aceito', motivo: 'executado', reservaId: r.reservaId });
    expect(await reservaPendente(app, e.id, 'p', 1)).toBeUndefined();
    expect(await passoExecutado(app, e.id, 'p', 1)).toBe(true);
    expect(await reservarPasso(app, e.id, base)).toEqual({ reservado: false, situacao: 'executado' });
  });

  it('reserva sem desfecho (queda) recusa o passo até a conferência manual', async () => {
    const e = await nova('R');
    const r = await reservarPasso(app, e.id, base);
    if (!r.reservado) throw new Error('devia reservar');
    // "reinício": nova tentativa encontra a reserva aberta
    expect(await reservarPasso(app, e.id, base)).toMatchObject({ reservado: false, situacao: 'em_execucao', reserva: { id: r.reservaId } });
    // conferência manual "não feito": desfecho erro libera nova tentativa
    await registrarChamada(app, e.id, { ...base, resultado: 'erro', motivo: 'não executado (conferência manual)', reservaId: r.reservaId });
    expect((await reservarPasso(app, e.id, base)).reservado).toBe(true);
  });

  it('duas reservas simultâneas: só uma ganha', async () => {
    const e = await nova('R');
    const rs = await Promise.all([reservarPasso(app, e.id, base), reservarPasso(app, e.id, base)]);
    expect(rs.filter((r) => r.reservado)).toHaveLength(1);
    expect(rs.filter((r) => !r.reservado && r.situacao === 'em_execucao')).toHaveLength(1);
  });

  it('um desfecho por reserva; a reserva não pode ser alterada', async () => {
    const e = await nova('R');
    const r = await reservarPasso(app, e.id, base);
    if (!r.reservado) throw new Error('devia reservar');
    await registrarChamada(app, e.id, { ...base, resultado: 'erro', motivo: 'x', reservaId: r.reservaId });
    await expect(registrarChamada(app, e.id, { ...base, resultado: 'aceito', motivo: 'executado', reservaId: r.reservaId })).rejects.toThrow();
  });

  it('reserva de outra empresa não interfere', async () => {
    const a = await nova('A');
    const b = await nova('B');
    expect((await reservarPasso(app, a.id, base)).reservado).toBe(true);
    expect((await reservarPasso(app, b.id, base)).reservado).toBe(true);
  });
});
