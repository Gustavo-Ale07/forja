import type { ColumnType, Generated } from 'kysely';

/** Data gravada pelo banco (DEFAULT now()). */
type Instante = ColumnType<Date, Date | string | undefined, Date | string>;
type InstanteOpcional = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export type Nivel = 'livre' | 'com_aprovacao' | 'bloqueado';
export type TipoCredencial = 'web_usuario' | 'web_senha' | 'gateway_client_id' | 'gateway_client_secret' | 'gateway_token';
export type Resultado = 'aceito' | 'recusado' | 'erro';

export interface TabelaEmpresa {
  id: Generated<string>;
  nome: string;
  slug: string;
  fuso: Generated<string>;
  criada_em: Instante;
}

export interface TabelaPerfil {
  id: Generated<string>;
  empresa_id: string;
  nome: string;
  descricao: string | null;
}

export interface TabelaAmbiente {
  id: Generated<string>;
  empresa_id: string;
  nome: string;
  url: string;
  host_permitido: string;
  usuario_banco_esperado: string;
  gateway_url: string;
  somente_leitura: Generated<boolean>;
  duas_aprovacoes: Generated<boolean>;
  criado_em: Instante;
}

export interface TabelaUsuario {
  id: Generated<string>;
  empresa_id: string;
  login: string;
  nome: string;
  perfil_id: string;
  senha_hash: string | null;
  totp_cifrado: string | null;
  ativo: Generated<boolean>;
  tentativas_falhas: Generated<number>;
  bloqueado_ate: InstanteOpcional;
  /** Último período TOTP aceito (bigint; o pg devolve como texto). Impede reusar um código. */
  totp_ultimo_passo: ColumnType<string, number | string | undefined, number | string>;
  criado_em: Instante;
}

export interface TabelaSessao {
  id: Generated<string>;
  empresa_id: string;
  usuario_id: string;
  token_hash: Buffer;
  criada_em: Instante;
  expira_em: ColumnType<Date, Date | string, Date | string>;
  revogada_em: InstanteOpcional;
}

export interface TabelaPerfilAmbiente {
  empresa_id: string;
  perfil_id: string;
  ambiente_id: string;
}

export interface TabelaPerfilPermissao {
  empresa_id: string;
  perfil_id: string;
  ambiente_id: string;
  acao: string;
  nivel: Nivel;
}

export interface TabelaPerfilTabelaBloqueada {
  empresa_id: string;
  perfil_id: string;
  padrao: string;
}

export interface TabelaCredencial {
  id: Generated<string>;
  empresa_id: string;
  ambiente_id: string;
  tipo: TipoCredencial;
  cifrado: string;
  versao_chave: number;
  atualizado_em: Instante;
}

export interface TabelaRegra {
  empresa_id: string;
  horario_inicio: string | null;
  horario_fim: string | null;
  dias: ColumnType<number[], number[] | undefined, number[]>;
  limite_registros: Generated<number>;
  leitura_bloqueada: ColumnType<string[], string[] | undefined, string[]>;
  gravacao_nativa_liberada: ColumnType<string[], string[] | undefined, string[]>;
}

export interface TabelaInstanciaTabela {
  empresa_id: string;
  tabela: string;
  instancia: string;
}

export interface TabelaChamadaFerramenta {
  id: ColumnType<string, never, never>;
  empresa_id: string;
  data_hora: Instante;
  usuario_id: string | null;
  usuario: string | null;
  perfil: string | null;
  ambiente: string;
  ferramenta: string;
  parametros: ColumnType<unknown, string, never>;
  plano_id: string | null;
  passo_id: number | null;
  resultado: Resultado;
  motivo: string;
  antes: ColumnType<unknown, string | null, never>;
  depois: ColumnType<unknown, string | null, never>;
  captura_path: string | null;
}

export interface Banco {
  empresa: TabelaEmpresa;
  perfil: TabelaPerfil;
  ambiente: TabelaAmbiente;
  usuario: TabelaUsuario;
  sessao: TabelaSessao;
  perfil_ambiente: TabelaPerfilAmbiente;
  perfil_permissao: TabelaPerfilPermissao;
  perfil_tabela_bloqueada: TabelaPerfilTabelaBloqueada;
  credencial: TabelaCredencial;
  regra: TabelaRegra;
  instancia_tabela: TabelaInstanciaTabela;
  chamada_ferramenta: TabelaChamadaFerramenta;
}
