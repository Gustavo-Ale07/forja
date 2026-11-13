import pino from 'pino';
import { mascarar } from './mascara.js';

/** Log no stderr (o stdout é do protocolo MCP). Todo argumento passa pela máscara. */
export const log = pino(
  {
    level: process.env.FORJA_LOG ?? 'info',
    base: { app: 'forja' },
    hooks: {
      logMethod(args, metodo) {
        return metodo.apply(this, args.map((a) => mascarar(a)) as Parameters<typeof metodo>);
      },
    },
  },
  pino.destination(2),
);
