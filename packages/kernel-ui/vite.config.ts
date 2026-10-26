/// <reference types="vitest" />

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const isDev = mode === 'development';
  const isWatching = process.argv.includes('--watch');
  if (isWatching && !isDev) {
    throw new Error('Cannot watch in non-development mode');
  }

  return {
    css: {
      postcss: './postcss.config.js',
      preprocessorOptions: {
        scss: {
          quietDeps: true,
          silenceDeprecations: ['import'],
        },
      },
    },
    build: {
      // `build:lib` clears `dist` and writes the declarations first.
      emptyOutDir: false,
      outDir: 'dist',
      sourcemap: true,
      cssCodeSplit: false,
      cssMinify: !isDev,
      lib: {
        entry: { index: './src/bundle.ts' },
        name: 'KernelUI',
        formats: ['es'],
        fileName: (_format, entryName) => `${entryName}.js`,
      },
      rolldownOptions: {
        external: (id) =>
          id === 'react' ||
          id === 'react-dom' ||
          id.startsWith('react/') ||
          id.startsWith('react-dom/'),
        output: {
          globals: {
            react: 'React',
            'react-dom': 'ReactDOM',
          },
          assetFileNames: 'styles.css',
        },
      },
    },
    plugins: [react()],
  };
});
