import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // Test-only stubs: react-native is Flow-typed (unparseable here) and the
      // brownfield bridge pulls it in transitively. The app build uses Metro,
      // which does not read this config, so these only affect Vitest.
      'react-native': path.resolve(__dirname, 'test-stubs/react-native.ts'),
      '@callstack/react-native-brownfield': path.resolve(
        __dirname,
        'test-stubs/react-native-brownfield.ts',
      ),
    },
    // Resolve platform-split modules (e.g. message-bridge.native.ts) under the
    // native variant in tests, since there is no base message-bridge.ts.
    extensions: ['.native.ts', '.native.tsx', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
  },
  test: {
    include: [
      'src/**/*.test.{ts,tsx}',
      'server/**/*.test.{ts,tsx}',
      'scripts/**/*.test.{ts,tsx}',
      'plugins/**/*.test.{ts,tsx}',
      // Root-level config modules (app.config.ts).
      '__tests__/**/*.test.{ts,tsx}',
    ],
  },
});
