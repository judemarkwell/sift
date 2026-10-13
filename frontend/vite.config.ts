import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    // Forward API calls to FastAPI so the browser only ever talks to one origin.
    proxy: {
      '/api': { target: process.env.SIFT_API_URL ?? 'http://localhost:8000', changeOrigin: true },
    },
  },
})
