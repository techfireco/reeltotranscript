import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://reeltotranscript.com',
  build: { inlineStylesheets: 'never' },
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
    build: { assetsInlineLimit: 0 },
    server: {
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8000',
          changeOrigin: true,
        },
        '/auth': {
          target: 'http://127.0.0.1:8000',
          changeOrigin: true,
        },
      },
    },
  },
});
