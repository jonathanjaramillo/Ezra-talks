import { defineConfig } from 'vite'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  plugins: [
    {
      name: 'serve-graph-data',
      configureServer(server) {
        server.middlewares.use('/graph_data.json', (_req, res) => {
          try {
            const data = readFileSync(resolve(__dirname, '../../graph_data.json'))
            res.setHeader('Content-Type', 'application/json')
            res.end(data)
          } catch {
            res.statusCode = 404
            res.end('graph_data.json not found at project root')
          }
        })
      },
    },
  ],
})
