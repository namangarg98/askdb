import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // The browser only talks to this dev server; it forwards /api to the API.
    // Same origin for the browser means the API needs no CORS configuration.
    proxy: {
      // ASKDB_API_URL points the UI at another API instance (default: the local dev API).
      '/api': process.env.ASKDB_API_URL ?? 'http://127.0.0.1:3001',
    },
  },
});
