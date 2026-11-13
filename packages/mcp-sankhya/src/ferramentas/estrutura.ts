import { z } from 'zod';
import { ForjaErro } from '../comum/erros.js';
import type { Capturador, EspecCampo } from '../navegador/tipos.js';
import { normalizarTabela } from '../porteiro/tabelas.js';
import { lerEstrutura, type Estrutura } from '../sankhya/dicionario.js';
import {
  COMBINACOES_ACEITAS,
  conferirTamanho,
  NOME_SEM_PREFIXO,
  NOME_TABELA_NOVA,
  NOMES_TIPOS,
  TIPOS_CAMPO,
  tamanhoFisico,
} from '../sankhya/tipos-campo.js';
import { CONTROLE, definir, type ContextoExecucao } from './tipos.js';

const tabelaAd = z
  .string()
  .min(4)
  .max(40)
  .describe('Tabela adicional completa, com prefixo (ex.: AD_FORJATESTE). Sem "_" depois de AD_.');

const nomeCampo = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(
    z
      .string()
      .refine((s) => !s.startsWith('AD_'), 'informe o nome do campo SEM o prefixo AD_')
      .pipe(z.string().regex(NOME_SEM_PREFIXO, 'nome de campo: letras e números, começando por letra, sem "_" (a tela remove), até 25')),
  );

const opcao = z
  .object({
    valor: z.string().min(1).max(10).describe('Valor gravado (até 10 caracteres: lista é VARCHAR2(10)).'),
    descricao: z.string().min(1).max(100),
  })
  .strict();

const especCampo = {
  campo: nomeCampo.describe('Nome do campo sem AD_ (ex.: QTDPECAS).'),
  descricao: z.string().min(1).max(100).optional().describe('Descrição na tela. Padrão: o nome do campo.'),
  tipo: z.enum(NOMES_TIPOS).describe(`Tipo do campo. Combinações tipo/tamanho aceitas: ${COMBINACOES_ACEITAS}.`),
  tamanho: z.number().int().positive().optional().describe(`Opcional; se vier, tem de ser o do tipo (${COMBINACOES_ACEITAS}).`),
};

function refinarCampo(c: { tipo: (typeof NOMES_TIPOS)[number]; tamanho?: number | undefined }, ctx: z.RefinementCtx) {
  const t = conferirTamanho(c.tipo, c.tamanho);
  if (t) ctx.addIssue({ code: 'custom', message: t, path: ['tamanho'] });
}

function tabelaValida(p: unknown): string | undefined {
  const t = normalizarTabela((p as { tabela: string }).tabela);
  return t.valido ? undefined : `Nome de tabela inválido: "${t.original}".`;
}

const recusar = (m: string) => new ForjaErro('RECUSADO_EXECUCAO', m);

/** Acha a coluna do campo: com ou sem o prefixo AD_ que o Sankhya possa ter posto. */
function acharColuna(e: Estrutura, campo: string) {
  return e.colunas.find((c) => c.COLUMN_NAME === campo) ?? e.colunas.find((c) => c.COLUMN_NAME === `AD_${campo}`);
}

export function conferirCampo(e: Estrutura, c: Pick<EspecCampo, 'campo' | 'tipo'>): { divergencias: string[]; nomeReal?: string } {
  const div: string[] = [];
  const def = TIPOS_CAMPO[c.tipo];
  const col = acharColuna(e, c.campo);
  if (!col) return { divergencias: [`coluna ${c.campo} não existe em USER_TAB_COLUMNS`] };
  const nomeReal = col.COLUMN_NAME;
  if (col.DATA_TYPE !== def.dataType) div.push(`${nomeReal}: tipo físico ${col.DATA_TYPE}, esperado ${def.dataType}`);
  const tam = tamanhoFisico(col);
  if (tam !== def.tamanho) div.push(`${nomeReal}: tamanho físico ${tam}, esperado ${def.tamanho}`);
  const dic = e.campos.find((x) => x.NOMECAMPO === nomeReal);
  if (!dic) div.push(`${nomeReal}: ausente no dicionário (TDDCAM)`);
  else if (dic.TIPCAMPO !== def.tipcampo) div.push(`${nomeReal}: TIPCAMPO ${dic.TIPCAMPO}, esperado ${def.tipcampo}`);
  return { divergencias: div, nomeReal };
}

/**
 * Roda uma ação do navegador garantindo que qualquer erro leve a pasta de capturas
 * (o executor grava `capturaPath` do erro em chamada_ferramenta.captura_path).
 */
async function comCaptura<T>(cap: Capturador, acao: () => Promise<T>): Promise<T> {
  try {
    return await acao();
  } catch (e) {
    if (e instanceof ForjaErro) {
      if (typeof e.detalhes?.capturaPath === 'string') throw e;
      throw new ForjaErro(e.codigo, e.message, { ...e.detalhes, capturaPath: cap.pasta });
    }
    throw new ForjaErro('NAVEGADOR_FALHOU', 'Falha no navegador ao operar o Construtor de Telas.', { capturaPath: cap.pasta });
  }
}

function divergente(msg: string, antes: unknown, depois: unknown, cap: Capturador): ForjaErro {
  return new ForjaErro('CONFERENCIA_DIVERGENTE', msg, { antes, depois, capturaPath: cap.pasta });
}

// ---------------------------------------------------------------- criar_tabela_ad

const esquemaTabela = z
  .object({
    nome: tabelaAd,
    descricao: z.string().min(1).max(100).describe('Descrição da instância/tela.'),
    nome_pk: nomeCampo.default('ID').describe('Nome da chave primária (inteiro, auto numeração). Padrão ID.'),
    descricao_pk: z.string().min(1).max(100).default('Código'),
    ...CONTROLE,
  })
  .strict()
  .superRefine((p, ctx) => {
    const t = normalizarTabela(p.nome);
    if (!t.valido || !NOME_TABELA_NOVA.test(t.nome)) {
      ctx.addIssue({ code: 'custom', path: ['nome'], message: 'use AD_ + letras/números, sem outro "_" (ex.: AD_FORJATESTE), até 28' });
    }
  });

/** Mensagem única para o formato antigo (campos dentro de criar_tabela_ad). */
export const CAMPOS_FORA_DA_TABELA =
  'criar_tabela_ad cria só a tabela e a chave primária; cada campo vira um passo criar_campo_ad separado no plano.';

export const criarTabelaAd = definir({
  nome: 'criar_tabela_ad',
  descricao:
    'Cria uma tabela adicional (AD_*) pelo Construtor de Telas do Sankhya (navegador), SÓ com a chave primária ' +
    'inteira e auto numeração oficial. Confere no dicionário depois. Exige plano aprovado. Os demais campos vão em ' +
    'passos criar_campo_ad separados, depois deste.',
  altera: true,
  usaSankhya: true,
  usaNavegador: true,
  schema: esquemaTabela,
  analisar: (b) => ({ alvos: [{ tabela: String(b.nome ?? ''), operacao: 'estrutura' }] }),
  async executar(p, ctx) {
    const nome = normalizarTabela(p.nome).nome;
    const antes = await lerEstrutura(ctx.gateway, nome);
    if (antes.existe) throw recusar(`A tabela ${nome} já existe. Nada foi criado.`);
    const cap = ctx.novoCapturador('criar_tabela_ad');
    await comCaptura(cap, () =>
      ctx.construtor().criarTabela({ nome, descricao: p.descricao, pk: { nome: p.nome_pk, descricao: p.descricao_pk } }, cap),
    );

    const depois = await lerEstrutura(ctx.gateway, nome);
    const div: string[] = [];
    if (!depois.existe) div.push('tabela não encontrada depois da criação');
    if (!depois.dicionario) div.push('tabela ausente em TDDTAB');
    else if (depois.dicionario.TIPONUMERACAO !== 'A') div.push(`TIPONUMERACAO ${depois.dicionario.TIPONUMERACAO}, esperado A (auto numeração)`);
    if (depois.instancias.length === 0) div.push('sem instância em TDDINS');
    const pkCol = acharColuna(depois, p.nome_pk);
    if (!pkCol) div.push(`coluna da chave ${p.nome_pk} ausente`);
    else {
      if (pkCol.DATA_TYPE !== 'NUMBER') div.push(`chave ${pkCol.COLUMN_NAME} é ${pkCol.DATA_TYPE}, esperado NUMBER`);
      if (depois.chavePrimaria.join(',') !== pkCol.COLUMN_NAME) div.push(`chave primária física (${depois.chavePrimaria.join(',')}) diferente de ${pkCol.COLUMN_NAME}`);
      if (!depois.campos.some((c) => c.NOMECAMPO === pkCol.COLUMN_NAME)) div.push(`chave ${pkCol.COLUMN_NAME} ausente no dicionário (TDDCAM)`);
    }
    if (div.length) throw divergente(`Conferência no dicionário divergiu: ${div.join('; ')}.`, antes, depois, cap);
    return {
      antes,
      depois,
      capturaPath: cap.pasta,
      dados: { situacao: 'CRIADA E CONFERIDA NO DICIONÁRIO', tabela: nome, chave: pkCol!.COLUMN_NAME, capturas: cap.arquivos, estrutura: depois },
    };
  },
});

// ---------------------------------------------------------------- criar_campo_ad

const esquemaCampo = z
  .object({ tabela: tabelaAd, ...especCampo, ...CONTROLE })
  .strict()
  .superRefine(refinarCampo);

export const criarCampoAd = definir({
  nome: 'criar_campo_ad',
  descricao:
    'Cria um campo numa tabela adicional (AD_*) já existente, pelo Construtor de Telas do Sankhya (navegador), e ' +
    `confere no dicionário e no banco. Exige plano aprovado. Tipos/tamanhos aceitos: ${COMBINACOES_ACEITAS}. ` +
    'Só cria a coluna (tipo, descrição, apresentação): as opções de um campo "lista" vão num passo ' +
    'definir_opcoes_lista e o "Requerido" num passo marcar_obrigatorio. Seguro repetir. Não altera tabelas nativas.',
  altera: true,
  usaSankhya: true,
  usaNavegador: true,
  schema: esquemaCampo,
  analisar: (b) => ({ alvos: [{ tabela: String(b.tabela ?? ''), operacao: 'estrutura' }] }),
  validarExtra: tabelaValida,
  async executar(p, ctx) {
    const tabela = normalizarTabela(p.tabela).nome;
    const antes = await lerEstrutura(ctx.gateway, tabela);
    if (!antes.existe) throw recusar(`A tabela ${tabela} não existe.`);
    const espec: EspecCampo = { tabela, campo: p.campo, descricao: p.descricao ?? p.campo, tipo: p.tipo };
    // Seguro para repetir: campo igual já existente = "já existia", sem tocar na tela.
    if (acharColuna(antes, p.campo)) {
      const ja = conferirCampo(antes, espec);
      if (ja.divergencias.length) {
        throw recusar(`O campo ${ja.nomeReal ?? p.campo} já existe em ${tabela} com outra definição (${ja.divergencias.join('; ')}). Nada foi alterado.`);
      }
      return {
        antes,
        depois: antes,
        motivo: 'já existia',
        dados: { situacao: 'JÁ EXISTIA — nada foi alterado', tabela, campo: ja.nomeReal },
      };
    }
    const cap = ctx.novoCapturador('criar_campo_ad');
    await comCaptura(cap, () => ctx.construtor().criarCampo(espec, cap));
    const depois = await lerEstrutura(ctx.gateway, tabela);
    const r = conferirCampo(depois, espec);
    if (r.divergencias.length) {
      throw divergente(`Conferência no dicionário divergiu: ${r.divergencias.join('; ')}.`, antes, depois, cap);
    }
    return {
      antes,
      depois,
      capturaPath: cap.pasta,
      dados: { situacao: 'CRIADO E CONFERIDO NO DICIONÁRIO', tabela, campo: r.nomeReal, capturas: cap.arquivos },
    };
  },
});

// ---------------------------------------------------------------- campo existente: comum

/** Campo já existente numa AD_: lê a estrutura e devolve o nome real da coluna. */
async function campoExistente(ctx: ContextoExecucao, tabelaBruta: string, campo: string) {
  const tabela = normalizarTabela(tabelaBruta).nome;
  const antes = await lerEstrutura(ctx.gateway, tabela);
  if (!antes.existe) throw recusar(`A tabela ${tabela} não existe.`);
  const col = acharColuna(antes, campo);
  if (!col) throw recusar(`O campo ${campo} não existe em ${tabela}. Crie-o antes com criar_campo_ad.`);
  return { tabela, antes, nomeReal: col.COLUMN_NAME };
}

const alvoCampo = { tabela: tabelaAd, campo: nomeCampo.describe('Nome do campo já existente (sem AD_).') };

// ---------------------------------------------------------------- definir_opcoes_lista

const esquemaOpcoes = z
  .object({
    ...alvoCampo,
    opcoes: z.array(opcao).min(1).max(50).describe('Opções da lista: valor (até 10) e descrição.'),
    ...CONTROLE,
  })
  .strict()
  .superRefine((p, ctx) => {
    const vistos = new Set<string>();
    for (const [i, o] of p.opcoes.entries()) {
      if (vistos.has(o.valor)) ctx.addIssue({ code: 'custom', path: ['opcoes', i, 'valor'], message: `valor "${o.valor}" repetido` });
      vistos.add(o.valor);
    }
  });

export const definirOpcoesLista = definir({
  nome: 'definir_opcoes_lista',
  descricao:
    'Inclui, pelo botão "Opções" do Construtor de Telas (navegador), as opções que faltam num campo tipo "lista" já ' +
    'existente de uma tabela AD_*, e confere em TDDOPC. Exige plano aprovado. Seguro repetir: opções iguais às ' +
    'existentes = "já existia"; mesmo valor com outra descrição = recusa (nada é alterado). Não remove opções.',
  altera: true,
  usaSankhya: true,
  usaNavegador: true,
  schema: esquemaOpcoes,
  analisar: (b) => ({ alvos: [{ tabela: String(b.tabela ?? ''), operacao: 'estrutura' }] }),
  validarExtra: tabelaValida,
  async executar(p, ctx) {
    const { tabela, antes, nomeReal } = await campoExistente(ctx, p.tabela, p.campo);
    const tipo = conferirCampo(antes, { campo: nomeReal, tipo: 'lista' });
    if (tipo.divergencias.length) {
      throw recusar(`O campo ${nomeReal} de ${tabela} não é do tipo lista (${tipo.divergencias.join('; ')}). Nada foi alterado.`);
    }
    const existentes = antes.opcoes.filter((o) => o.NOMECAMPO === nomeReal);
    const conflitos = p.opcoes.flatMap((o) => {
      const x = existentes.find((e) => e.VALOR === o.valor);
      return x && x.OPCAO !== o.descricao ? [`"${o.valor}" já existe como "${x.OPCAO ?? ''}" (pedido: "${o.descricao}")`] : [];
    });
    if (conflitos.length) throw recusar(`Opções divergentes em ${tabela}.${nomeReal}: ${conflitos.join('; ')}. Nada foi alterado.`);
    const faltam = p.opcoes.filter((o) => !existentes.some((e) => e.VALOR === o.valor));
    if (faltam.length === 0) {
      return {
        antes,
        depois: antes,
        motivo: 'já existia',
        dados: { situacao: 'JÁ EXISTIA — todas as opções já estavam na lista; nada foi alterado', tabela, campo: nomeReal },
      };
    }
    const cap = ctx.novoCapturador('definir_opcoes_lista');
    await comCaptura(cap, () => ctx.construtor().incluirOpcoes({ tabela, campo: nomeReal, opcoes: faltam }, cap));
    const depois = await lerEstrutura(ctx.gateway, tabela);
    const div = p.opcoes.flatMap((o) => {
      const x = depois.opcoes.find((e) => e.NOMECAMPO === nomeReal && e.VALOR === o.valor);
      if (!x) return [`opção "${o.valor}" ausente em TDDOPC`];
      return x.OPCAO === o.descricao ? [] : [`opção "${o.valor}" gravada como "${x.OPCAO ?? ''}", esperado "${o.descricao}"`];
    });
    if (div.length) throw divergente(`Conferência em TDDOPC divergiu: ${div.join('; ')}.`, antes, depois, cap);
    return {
      antes,
      depois,
      capturaPath: cap.pasta,
      dados: {
        situacao: 'OPÇÕES INCLUÍDAS E CONFERIDAS EM TDDOPC',
        tabela,
        campo: nomeReal,
        incluidas: faltam.map((o) => o.valor),
        ja_existiam: p.opcoes.filter((o) => !faltam.includes(o)).map((o) => o.valor),
        capturas: cap.arquivos,
      },
    };
  },
});

// ---------------------------------------------------------------- marcar_obrigatorio

const esquemaObrigatorio = z.object({ ...alvoCampo, ...CONTROLE }).strict();

const requerido = (e: Estrutura, campo: string) =>
  e.atributos.find((a) => a.NOMECAMPO === campo && a.NOME === 'requerido')?.VALOR ?? null;

export const marcarObrigatorio = definir({
  nome: 'marcar_obrigatorio',
  descricao:
    'Liga o atributo "Requerido" de um campo já existente de uma tabela AD_*, pelo botão "Atributos" do Construtor ' +
    'de Telas (navegador), e confere em TDDPCO (requerido = S). Exige plano aprovado. Seguro repetir: se já é ' +
    'requerido, registra "já existia" e não mexe na tela.',
  altera: true,
  usaSankhya: true,
  usaNavegador: true,
  schema: esquemaObrigatorio,
  analisar: (b) => ({ alvos: [{ tabela: String(b.tabela ?? ''), operacao: 'estrutura' }] }),
  validarExtra: tabelaValida,
  async executar(p, ctx) {
    const { tabela, antes, nomeReal } = await campoExistente(ctx, p.tabela, p.campo);
    if (requerido(antes, nomeReal) === 'S') {
      return {
        antes,
        depois: antes,
        motivo: 'já existia',
        dados: { situacao: 'JÁ EXISTIA — o campo já era requerido; nada foi alterado', tabela, campo: nomeReal },
      };
    }
    const cap = ctx.novoCapturador('marcar_obrigatorio');
    await comCaptura(cap, () => ctx.construtor().marcarRequerido({ tabela, campo: nomeReal }, cap));
    const depois = await lerEstrutura(ctx.gateway, tabela);
    const v = requerido(depois, nomeReal);
    if (v !== 'S') {
      throw divergente(`Conferência em TDDPCO divergiu: ${nomeReal} requerido = ${v ?? '(ausente)'}, esperado S.`, antes, depois, cap);
    }
    return {
      antes,
      depois,
      capturaPath: cap.pasta,
      dados: { situacao: 'REQUERIDO MARCADO E CONFERIDO EM TDDPCO', tabela, campo: nomeReal, capturas: cap.arquivos },
    };
  },
});
