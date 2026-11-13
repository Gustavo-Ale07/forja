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
  revogarSessoesDoUsuario,
  type NovaSessao,
  type SessaoResolvida,
  type SessaoValida,
  type UsuarioAutenticado,
} from './login.js';
export {
  AMBIENTE_TESTE,
  buscarEmpresa,
  buscarLogin,
  criarEmpresa,
  criarUsuario,
  ErroAdmin,
  exigirEmpresa,
  gravarAmbiente,
  gravarCredenciais,
  importarConfig,
  lerAmbiente,
  lerConfigEmpresa,
  listarEmpresas,
  normalizarLogin,
  type AmbienteComCredenciais,
  type ConfigEmpresa,
  type ConfigImportada,
  type Credenciais,
  type DadosAmbiente,
  type EmpresaResumo,
  type PerfilImportado,
  type ResumoImportacao,
} from './admin.js';
export {
  apagarSessaoLegada,
  apagarSessaoLocal,
  arquivoSessao,
  arquivoSessaoLegado,
  gravarSessaoLocal,
  lerSessaoLocal,
  pastaConfigUsuario,
  type SessaoLocal,
} from './sessao-local.js';
export { contextoCredencial, gravarCredencial, lerCredencial, tiposCadastrados, TIPOS_CREDENCIAL } from './credenciais.js';
export {
  listarChamadas,
  MOTIVOS_EXECUTADO,
  passoExecutado,
  registrarChamada,
  reservaPendente,
  reservarPasso,
  type ChamadaGravada,
  type ChamadaNova,
  type ResultadoReserva,
} from './auditoria.js';
