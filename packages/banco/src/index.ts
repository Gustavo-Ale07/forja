export { comEmpresa, criarBanco, type Db, type Trx } from './conexao.js';
export { exigirEnv, lerEnv, raizRepositorio } from './env.js';
export { migrar } from './migrar.js';
export type * from './tipos.js';
export { CofreAesGcm, ErroCofre, lerChaveMestra, type Cifrado, type Cofre } from './cofre.js';
export {
  autenticar,
  codigoTotpAtual,
  confirmarTotp,
  conferirCodigoTotp,
  criarSessao,
  definirSenha,
  definirTotp,
  DURACAO_SESSAO_MS,
  ErroLogin,
  hashSenha,
  novoSegredoTotp,
  resolverSessao,
  revogarSessao,
  type NovaSessao,
  type SessaoResolvida,
  type SessaoValida,
  type UsuarioAutenticado,
} from './login.js';
export { apagarSessaoLocal, arquivoSessao, gravarSessaoLocal, lerSessaoLocal, type SessaoLocal } from './sessao-local.js';
export { contextoCredencial, gravarCredencial, lerCredencial, tiposCadastrados, TIPOS_CREDENCIAL } from './credenciais.js';
