import { confirmarTotp, ErroLogin, registrarChamada, reservaPendente, type Cofre, type Db, type SessaoValida } from '@forja/banco';
import { linhaAuditoria } from '../auditoria/registro.js';
import { mensagemSegura } from '../comum/mascara.js';
import { AMBIENTE_FASE1 } from '../config/trava-producao.js';
import { aprovarPasso, assinarPlano, gravarPlano, lerPlano, verificarAssinaturaPlano } from '../porteiro/planos.js';

export interface PedidoAprovacao {
  app: Db;
  cofre: Cofre;
  sessao: SessaoValida;
  chave: string;
  diretorioPlanos: string;
  id: string;
  passo?: number | undefined;
  /** Pergunta o id do plano de novo (confirmação). */
  confirmarId: (pergunta: string) => Promise<string>;
  /** Pede o código TOTP do aplicativo autenticador. */
  pedirCodigo: (pergunta: string) => Promise<string>;
  escrever: (t: string) => void;
  agora?: () => Date;
}

export type ResultadoAprovacao = { aprovado: true; aprovadoPor: string } | { aprovado: false; motivo: string };

/**
 * Núcleo do forja-aprovar. O aprovador é o usuário da sessão no banco; cada assinatura (e cada
 * --passo) exige um código TOTP novo, conferido e consumido no banco. Mantém o HMAC do plano.
 * Aprovação e recusa por TOTP ficam na auditoria da empresa.
 */
export async function aprovar(p: PedidoAprovacao): Promise<ResultadoAprovacao> {
  const agora = p.agora ?? (() => new Date());
  const plano = lerPlano(p.diretorioPlanos, p.id);
  if (!plano) throw new Error(`planos/${p.id}.json não existe.`);
  const alvo = p.passo === undefined ? 'o plano inteiro' : `o passo ${p.passo}`;

  p.escrever(`\nPlano ${plano.id}: ${plano.descricao}\n`);
  for (const s of plano.passos) {
    if (p.passo !== undefined && s.n !== p.passo) continue;
    p.escrever(`\n  Passo ${s.n} — ${s.ferramenta}${s.descricao ? ` — ${s.descricao}` : ''}\n`);
    p.escrever(`${JSON.stringify(s.parametros, null, 2).replace(/^/gm, '    ')}\n`);
  }
  if (p.passo === undefined && plano.assinatura && !verificarAssinaturaPlano(plano, p.chave)) {
    p.escrever('\nAviso: este plano já está assinado. Assinar de novo descarta as aprovações de passo.\n');
  }
  // Valida antes de pedir o código (ex.: passo inexistente ou plano sem assinatura).
  if (p.passo === undefined) assinarPlano(plano, p.chave, p.sessao.login, agora());
  else aprovarPasso(plano, p.passo, p.chave, p.sessao.login, agora());

  const digitado = await p.confirmarId(`\nPara aprovar ${alvo} como "${p.sessao.login}", digite o id do plano (${p.id}): `);
  if (digitado.trim() !== p.id) return { aprovado: false, motivo: 'Id não confere. Nada foi gravado.' };

  const auditar = (resultado: 'aceito' | 'recusado', motivo: string) =>
    registrarChamada(
      p.app,
      p.sessao.empresaId,
      linhaAuditoria({
        usuarioId: p.sessao.usuarioId,
        usuario: p.sessao.login,
        ambiente: AMBIENTE_FASE1,
        ferramenta: 'forja-aprovar',
        parametros: { plano_id: p.id, ...(p.passo !== undefined ? { passo: p.passo } : {}) },
        planoId: p.id,
        passoId: p.passo,
        resultado,
        motivo,
      }),
      agora(),
    );

  const codigo = (await p.pedirCodigo('Código TOTP do aplicativo: ')).trim();
  let aprovadoPor: string;
  try {
    aprovadoPor = (await confirmarTotp(p.app, p.cofre, p.sessao, codigo, agora())).login;
  } catch (e) {
    const motivo = e instanceof ErroLogin ? e.message : mensagemSegura(e);
    await auditar('recusado', `aprovação recusada: ${motivo}`);
    return { aprovado: false, motivo: `${motivo} Nada foi gravado.` };
  }

  const novo = p.passo === undefined ? assinarPlano(plano, p.chave, aprovadoPor, agora()) : aprovarPasso(plano, p.passo, p.chave, aprovadoPor, agora());
  gravarPlano(p.diretorioPlanos, novo);
  await auditar('aceito', p.passo === undefined ? 'plano assinado' : `passo ${p.passo} aprovado`);
  p.escrever(`Aprovado: ${alvo} de "${p.id}" por ${aprovadoPor}.\n`);
  return { aprovado: true, aprovadoPor };
}

export interface PedidoConferencia extends Omit<PedidoAprovacao, 'chave' | 'passo'> {
  passo: number;
  /** O que a pessoa conferiu no Sankhya: a ação foi feita ou não. */
  desfecho: 'feito' | 'nao-feito';
}

export type ResultadoConferencia = { conferido: true; reservaId: string } | { conferido: false; motivo: string };

/**
 * forja-aprovar <plano> --passo N --conferir feito|nao-feito. Fecha a reserva "em execução" que
 * ficou sem desfecho (servidor caiu ou a auditoria falhou depois de agir). Quem confere é o usuário
 * da sessão, com TOTP novo. "feito" marca o passo como executado (não roda de novo); "nao-feito"
 * grava erro e libera o passo para ser chamado outra vez.
 */
export async function conferir(p: PedidoConferencia): Promise<ResultadoConferencia> {
  const agora = p.agora ?? (() => new Date());
  const reserva = await reservaPendente(p.app, p.sessao.empresaId, p.id, p.passo);
  if (!reserva) return { conferido: false, motivo: `Nada a conferir: o passo ${p.passo} de "${p.id}" não tem reserva "em execução" pendente.` };

  const quando = reserva.data_hora.toISOString();
  p.escrever(`\nReserva #${reserva.id}: plano ${p.id} passo ${p.passo} — ${reserva.ferramenta}, por ${reserva.usuario ?? '-'} em ${quando}\n`);
  p.escrever(`${JSON.stringify(reserva.parametros, null, 2).replace(/^/gm, '    ')}\n`);
  p.escrever(
    p.desfecho === 'feito'
      ? '\nVocê está declarando que conferiu no Sankhya e a ação FOI feita. O passo fica como executado e não roda de novo.\n'
      : '\nVocê está declarando que conferiu no Sankhya e a ação NÃO foi feita. O passo fica liberado para ser chamado de novo.\n',
  );

  const digitado = await p.confirmarId(`\nPara registrar a conferência como "${p.sessao.login}", digite o id do plano (${p.id}): `);
  if (digitado.trim() !== p.id) return { conferido: false, motivo: 'Id não confere. Nada foi gravado.' };

  const base = {
    usuarioId: p.sessao.usuarioId,
    usuario: p.sessao.login,
    ambiente: reserva.ambiente,
    planoId: p.id,
    passoId: p.passo,
  };
  const codigo = (await p.pedirCodigo('Código TOTP do aplicativo: ')).trim();
  let quem: string;
  try {
    quem = (await confirmarTotp(p.app, p.cofre, p.sessao, codigo, agora())).login;
  } catch (e) {
    const motivo = e instanceof ErroLogin ? e.message : mensagemSegura(e);
    await registrarChamada(
      p.app,
      p.sessao.empresaId,
      linhaAuditoria({ ...base, ferramenta: 'forja-aprovar', parametros: { plano_id: p.id, passo: p.passo, conferir: p.desfecho }, resultado: 'recusado', motivo: `conferência recusada: ${motivo}` }),
      agora(),
    );
    return { conferido: false, motivo: `${motivo} Nada foi gravado.` };
  }

  // Desfecho da reserva (o índice único do banco impede um segundo desfecho para a mesma reserva).
  await registrarChamada(
    p.app,
    p.sessao.empresaId,
    linhaAuditoria({
      ...base,
      usuario: quem,
      perfil: reserva.perfil ?? undefined,
      ferramenta: reserva.ferramenta,
      parametros: reserva.parametros,
      resultado: p.desfecho === 'feito' ? 'aceito' : 'erro',
      motivo: p.desfecho === 'feito' ? 'executado (conferência manual)' : 'não executado (conferência manual)',
      reservaId: reserva.id,
    }),
    agora(),
  );
  p.escrever(`Conferência registrada: passo ${p.passo} de "${p.id}" ${p.desfecho === 'feito' ? 'executado' : 'não executado (liberado)'}, por ${quem}.\n`);
  return { conferido: true, reservaId: reserva.id };
}
