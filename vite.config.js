import fs from 'node:fs'
import process from 'node:process'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { validateStagingBuildEnvironment } from './scripts/staging-build-guard.mjs'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const environment = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  if (mode === 'staging' || environment.VITE_APP_ENV === 'staging') {
    const firebaseAliases = JSON.parse(fs.readFileSync('.firebaserc', 'utf8'))
    validateStagingBuildEnvironment(environment, {
      productionProjectId: firebaseAliases?.projects?.default,
    })
  }
  return {
    plugins: [react()],
  }
})
