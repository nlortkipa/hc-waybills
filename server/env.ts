/**
 * Loads `.env` from the project root into process.env (variables already set win).
 * Imported first by server/index.ts, before any module reads process.env.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const ENV_PATH = join(import.meta.dirname, '..', '.env')

if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH)
