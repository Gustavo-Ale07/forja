import { z } from 'zod';

export const NIVEIS = ['livre', 'com_aprovacao', 'bloqueado'] as const;
export type Nivel = (typeof NIVEIS)[number];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM');

/** Padrão de tabela: nome exato (TGFPAR) ou prefixo com * (TSI*). */
const padraoTabela = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_$#]*\*?$/, 'use NOME ou PREFIXO*')
  .transform((s) => s.toUpperCase());

export const esquemaAmbiente = z.object({
  /** Host do Sankhya web aceito para este ambiente (exato). */
  host_permitido: z.string().min(3).transform((s) => s.toLowerCase()),
  /** Resultado esperado de SELECT USER FROM DUAL pelo Gateway. */
  usuario_banco_esperado: z.string().min(1).transform((s) => s.toUpperCase()),
  /** Origem do Gateway (sem caminho). */
  gateway_url: z.string().url().default('https://api.sankhya.com.br'),
  somente_leitura: z.boolean().default(false),
});

export const esquemaPerfil = z.object({
  descricao: z.string().optional(),
  ambientes: z.array(z.string()).min(1),
  /** acoes[ambiente][ferramenta] = nível. Ferramenta não listada = bloqueado. */
  acoes: z.record(z.string(), z.record(z.string(), z.enum(NIVEIS))),
  /** Tabelas (ou prefixos*) fora do alcance deste perfil, para qualquer ferramenta. */
  tabelas_bloqueadas: z.array(padraoTabela).default([]),
});

export const esquemaConfig = z.object({
  fuso: z.string().default('America/Sao_Paulo'),
  gateway_hosts_permitidos: z
    .array(z.string())
    .default(['api.sankhya.com.br', 'api.sandbox.sankhya.com.br']),
  ambientes: z.record(z.string(), esquemaAmbiente),
  perfis: z.record(z.string(), esquemaPerfil),
  /** usuario Forja → perfil */
  usuarios: z.record(z.string(), z.string()),
  regras: z
    .object({
      horario: z
        .object({
          inicio: hhmm,
          fim: hhmm,
          /** 0 = domingo ... 6 = sábado */
          dias: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
        })
        .optional(),
      limite_registros_por_execucao: z.number().int().positive().default(50),
      /** Leitura de dados bloqueada (consultar_sql, carregar_registros). Padrão: TSI*. */
      leitura_bloqueada: z.array(padraoTabela).default(['TSI*']),
      /** Tabelas nativas em que gravar_registros pode gravar (fora das travas fixas). */
      gravacao_nativa_liberada: z.array(padraoTabela).default([]),
    })
    .default({
      limite_registros_por_execucao: 50,
      leitura_bloqueada: ['TSI*'],
      gravacao_nativa_liberada: [],
    }),
  /** TABELA → instância (TDDINS) usada no CRUD, para tabelas com mais de uma instância. */
  instancias: z
    .record(z.string(), z.string())
    .default({})
    .transform((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k.toUpperCase(), v]))),
});

export type ConfigArquivo = z.infer<typeof esquemaConfig>;
export type ConfigAmbiente = z.infer<typeof esquemaAmbiente>;
export type ConfigPerfil = z.infer<typeof esquemaPerfil>;
