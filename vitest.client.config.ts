/**
 * Client-side unit test config: jsdom environment, TS/TSX transpilation.
 * Mirrors the DSH web lane conventions (*.client.spec.ts(x)).
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/client/**/*.client.spec.{ts,tsx}'],
    css: {
      include: /.module.css$/,
    },
    server: {
      deps: {
        inline: ['@deepseek-ai/dsh-client-ui-primitives'],
      },
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
})
