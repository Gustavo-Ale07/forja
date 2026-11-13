import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Ferramenta } from '../ferramentas/tipos.js';
import type { Executor } from './executor.js';

/** JSON Schema de entrada (o que o modelo vê). Plano B para tipos não representáveis. */
export function esquemaEntrada(f: Ferramenta): Record<string, unknown> {
  let js: Record<string, unknown>;
  try {
    js = z.toJSONSchema(f.schema, { io: 'input' }) as Record<string, unknown>;
  } catch {
    js = z.toJSONSchema(f.schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  }
  const { $schema: _s, ...resto } = js;
  return { type: 'object', ...resto };
}

export function criarServidor(ferramentas: Map<string, Ferramenta>, executor: Executor): Server {
  const server = new Server(
    { name: 'forja-sankhya', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Forja: acesso controlado ao Sankhya (somente base de TESTE). Toda chamada passa por um porteiro de 7 regras e ' +
        'fica registrada na auditoria. Leitura livre dispensa plano. Para alterar algo: propor_plano → o usuário assina ' +
        'com forja-aprovar no terminal → chame a ferramenta com plano_id, passo_id e exatamente os parâmetros do passo.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...ferramentas.values()].map((f) => ({
      name: f.nome,
      description: f.descricao,
      inputSchema: esquemaEntrada(f) as { type: 'object' },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const r = await executor.chamar(req.params.name, req.params.arguments ?? {});
    return { ...r };
  });
  return server;
}
