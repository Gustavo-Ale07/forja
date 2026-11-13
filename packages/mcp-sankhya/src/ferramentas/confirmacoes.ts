import { randomBytes } from 'node:crypto';

export interface Pendente {
  hashParametros: string;
  usuario: string;
  planoId: string | undefined;
  passoId: number | undefined;
  hashAntes: string;
  expiraEm: number;
}

/**
 * Tokens de confirmação de gravar_registros. Em memória: reiniciar o servidor exige nova prévia.
 * Uso único, expira em 10 minutos, preso ao usuário, ao passo e aos parâmetros exatos.
 */
export class Confirmacoes {
  private readonly pendentes = new Map<string, Pendente>();
  constructor(private readonly validadeMs = 10 * 60_000) {}

  criar(p: Omit<Pendente, 'expiraEm'>, agora: number): { token: string; expiraEm: Date } {
    for (const [t, v] of this.pendentes) if (v.expiraEm <= agora) this.pendentes.delete(t);
    const token = randomBytes(16).toString('hex');
    const expiraEm = agora + this.validadeMs;
    this.pendentes.set(token, { ...p, expiraEm });
    return { token, expiraEm: new Date(expiraEm) };
  }

  /** Consome o token (sempre: certo ou errado, não serve de novo). Devolve o motivo da recusa. */
  consumir(token: string, esperado: Omit<Pendente, 'expiraEm' | 'hashAntes'>, agora: number): { ok: true; hashAntes: string } | { ok: false; motivo: string } {
    const p = this.pendentes.get(token);
    this.pendentes.delete(token);
    if (!p) return { ok: false, motivo: 'Token de confirmação desconhecido, já usado ou perdido (servidor reiniciado). Peça nova prévia.' };
    if (p.expiraEm <= agora) return { ok: false, motivo: 'Token de confirmação expirado. Peça nova prévia.' };
    if (p.usuario !== esperado.usuario) return { ok: false, motivo: 'Token de confirmação de outro usuário.' };
    if (p.planoId !== esperado.planoId || p.passoId !== esperado.passoId) {
      return { ok: false, motivo: 'Token de confirmação de outro plano/passo.' };
    }
    if (p.hashParametros !== esperado.hashParametros) {
      return { ok: false, motivo: 'Os parâmetros mudaram desde a prévia. Peça nova prévia.' };
    }
    return { ok: true, hashAntes: p.hashAntes };
  }
}
