import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  envPrefix: 'DEVOPS_',
  base: process.env.DEVOPS_BASE_PATH || '/',
  server: {
    host: '127.0.0.1',
  },
});
