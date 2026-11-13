import readline from 'node:readline';

/** Pergunta no terminal. Com `oculto`, não ecoa o que é digitado (senha). */
export function perguntar(texto: string, oculto = false): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error('Este comando precisa de um terminal interativo.'));
  }
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (oculto) {
      const rli = rl as unknown as { _writeToOutput: (s: string) => void };
      rli._writeToOutput = (s: string) => {
        // ecoa só o prompt e a quebra de linha, nunca os caracteres digitados
        if (s.startsWith(texto) || s === '\r\n' || s === '\n') process.stdout.write(s.startsWith(texto) ? texto : s);
      };
    }
    rl.on('SIGINT', () => {
      rl.close();
      reject(new Error('Cancelado.'));
    });
    rl.question(texto, (r) => {
      rl.close();
      if (oculto) process.stdout.write('\n');
      resolve(r);
    });
  });
}
