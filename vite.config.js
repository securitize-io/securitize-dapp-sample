import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Minimal Vite config. No backend, no middleware — this is a pure static SPA
// that fetches its data directly from the browser (or from the bundled JSON
// when CORS blocks that fetch).
export default defineConfig({
  plugins: [react()],
  server: { port: 3000 },
})
