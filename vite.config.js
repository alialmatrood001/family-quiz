import fs from 'node:fs'
import process from 'node:process'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import {
  requiresStagingBuildGuard,
  validateStagingBuildEnvironment,
} from './scripts/staging-build-guard.mjs'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const environment = { ...loadEnv(mode, process.cwd(), ''), ...process.env }
  if (requiresStagingBuildGuard(environment, mode)) {
    const firebaseAliases = JSON.parse(fs.readFileSync('.firebaserc', 'utf8'))
    validateStagingBuildEnvironment(environment, {
      productionProjectId: firebaseAliases?.projects?.default,
    })
  }
  return {
    plugins: [react()],
  }
})
