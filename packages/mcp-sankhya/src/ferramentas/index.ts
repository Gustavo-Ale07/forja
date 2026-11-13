import { criarCampoAd, criarTabelaAd, definirOpcoesLista, marcarObrigatorio } from './estrutura.js';
import { gravarRegistros } from './gravacao.js';
import { carregarRegistros, consultarSql, lerDicionario } from './leitura.js';
import { criarProporPlano } from './plano.js';
import type { Ferramenta } from './tipos.js';

export function registroFerramentas(): Map<string, Ferramenta> {
  const mapa = new Map<string, Ferramenta>();
  const todas = [lerDicionario, consultarSql, carregarRegistros, gravarRegistros, criarTabelaAd, criarCampoAd, definirOpcoesLista, marcarObrigatorio, criarProporPlano(() => mapa)];
  for (const f of todas) mapa.set(f.nome, f);
  return mapa;
}
