/**
 * Tipos de campo que a tela do Sankhya realmente cria (skill sankhya-estrutura-dados). O tamanho
 * não é configurável pela tela: cada tipo tem um único tamanho físico.
 */
export const TIPOS_CAMPO = {
  texto: { rotulo: 'Texto', tipcampo: 'S', dataType: 'VARCHAR2', tamanho: 100, comOpcoes: false },
  lista: { rotulo: 'Texto com Lista de Opções', tipcampo: 'S', dataType: 'VARCHAR2', tamanho: 10, comOpcoes: true },
  inteiro: { rotulo: 'Número Inteiro', tipcampo: 'I', dataType: 'NUMBER', tamanho: 10, comOpcoes: false },
  decimal: { rotulo: 'Número Decimal', tipcampo: 'F', dataType: 'FLOAT', tamanho: 126, comOpcoes: false },
  data_hora: { rotulo: 'Data e Hora', tipcampo: 'H', dataType: 'DATE', tamanho: 7, comOpcoes: false },
} as const;

export type TipoCampo = keyof typeof TIPOS_CAMPO;
export const NOMES_TIPOS = Object.keys(TIPOS_CAMPO) as [TipoCampo, ...TipoCampo[]];

export const COMBINACOES_ACEITAS = NOMES_TIPOS.map((t) => `${t}/${TIPOS_CAMPO[t].tamanho}`).join(', ');

/** Recusa tamanho diferente do que o Sankhya cria. Devolve o motivo, ou undefined. */
export function conferirTamanho(tipo: TipoCampo, tamanho: number | undefined): string | undefined {
  if (tamanho === undefined) return undefined;
  const esperado = TIPOS_CAMPO[tipo].tamanho;
  if (tamanho !== esperado) {
    return (
      `O Sankhya não cria ${tipo} com tamanho ${tamanho}: o tamanho não é configurável pela tela. ` +
      `Combinações aceitas (tipo/tamanho): ${COMBINACOES_ACEITAS}.`
    );
  }
  return undefined;
}

/** Tamanho físico observado em USER_TAB_COLUMNS (NUMBER/FLOAT usam a precisão). */
export function tamanhoFisico(coluna: { DATA_TYPE: string; DATA_LENGTH: number; DATA_PRECISION: number | null }): number {
  if (coluna.DATA_TYPE === 'NUMBER' || coluna.DATA_TYPE === 'FLOAT') return coluna.DATA_PRECISION ?? coluna.DATA_LENGTH;
  return coluna.DATA_LENGTH;
}

/** Nome de tabela/campo como digitado na tela: sem AD_, só letras e números (a tela remove "_"). */
export const NOME_SEM_PREFIXO = /^[A-Z][A-Z0-9]{0,24}$/;
/** Nome completo aceito para tabela nova: AD_ + nome sem "_". */
export const NOME_TABELA_NOVA = /^AD_[A-Z][A-Z0-9]{0,24}$/;
