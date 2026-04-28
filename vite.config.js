import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/blast/' : '/',
  plugins: [react()],
  optimizeDeps: {
    include: ['@bsv/sdk'],
    exclude: ['@bsv/wallet-toolbox-client']
  },
  worker: {
    format: 'es'
  },
  server: {
    port: 5173
  }
}))
