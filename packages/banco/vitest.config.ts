import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Zera o banco forja_teste e aplica as migrações uma vez antes de todos os testes.
    globalSetup: ['./test/preparar-banco.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
