import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    extensions: ['.js', '.json']
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.js'],
      exclude: [
        'src/server.js',
        'src/config/**',
        'src/core/application/ports/**',
        'src/panel/static/**',
        'src/panel/index.html',
        'src/adapters/outbound/mongo/connection.js'
      ],
      thresholds: {
        lines: 80,
        functions: 70,
        branches: 70,
        statements: 80
      }
    },
    testTimeout: 30000,
    hookTimeout: 60000
  }
})
