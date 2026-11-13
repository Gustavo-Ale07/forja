import fs from 'node:fs/promises';
import path from 'node:path';
import { hojeNoFuso } from '../auditoria/registro.js';
import type { Capturador } from './tipos.js';

/** auditoria/capturas/<AAAA-MM-DD>/<HHMMSS-mmm>-<ferramenta>/<nn>-<passo>.png */
export function criarCapturador(raiz: string, ferramenta: string, fuso: string, agora = new Date()): Capturador {
  const dia = hojeNoFuso(fuso, agora);
  const hora = new Intl.DateTimeFormat('en-GB', {
    timeZone: fuso,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
    .format(agora)
    .replace(/:/g, '');
  const ms = String(agora.getMilliseconds()).padStart(3, '0');
  const pasta = path.join(raiz, dia, `${hora}-${ms}-${ferramenta}`);
  const arquivos: string[] = [];
  return {
    pasta,
    arquivos,
    async salvar(passo, png) {
      await fs.mkdir(pasta, { recursive: true });
      const nome = `${String(arquivos.length + 1).padStart(2, '0')}-${passo.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60)}.png`;
      const arquivo = path.join(pasta, nome);
      await fs.writeFile(arquivo, png);
      arquivos.push(arquivo);
      return arquivo;
    },
  };
}
