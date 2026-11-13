export { comEmpresa, criarBanco, type Db, type Trx } from './conexao.js';
export { exigirEnv, lerEnv, raizRepositorio } from './env.js';
export { migrar } from './migrar.js';
export type * from './tipos.js';
export { CofreAesGcm, ErroCofre, lerChaveMestra, type Cifrado, type Cofre } from './cofre.js';
export { contextoCredencial, gravarCredencial, lerCredencial, tiposCadastrados, TIPOS_CREDENCIAL } from './credenciais.js';
