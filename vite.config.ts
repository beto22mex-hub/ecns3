
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE_PATH || './',
  plugins: [react()],
  publicDir: 'static',
  define: {
    'process.env.AZURE_AUTH_ENABLED': JSON.stringify(process.env.AZURE_AUTH_ENABLED || process.env.ENABLE_AZURE_AUTH || 'false'),
  },
  server: {
    port: Number(process.env.PORT) || 3000,
    host: '0.0.0.0',
  },
});
