import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  build: { outDir: 'dist', assetsDir: 'assets', emptyOutDir: true },
  server: {
    proxy: {
      '/api': {
        target: process.env.REQFORGE_API ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
        // the API refuses requests whose Origin does not match its Host (CSRF guard)
        configure: (proxy) => proxy.on('proxyReq', (req) => req.removeHeader('origin')),
      },
    },
  },
})
