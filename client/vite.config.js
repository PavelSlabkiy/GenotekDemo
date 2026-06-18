import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Локальная разработка ходит в Express через прокси, чтобы фронт не знал порт API.
export default defineConfig({
  plugins: [
    react({
      jsxRuntime: 'automatic',
    })
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
