import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'DEVOPS_');
  const basePath = env.DEVOPS_BASE_PATH?.replace(/^\/+|\/+$/g, '');

  return {
    plugins: [react()],
    envPrefix: 'DEVOPS_',
    base: basePath ? `/${basePath}/` : '/',
    server: {
      host: '127.0.0.1',
    },
  };
});
