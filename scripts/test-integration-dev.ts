/**
 * Integration test against a live Lyntari Edge Functions deployment.
 *
 * Exercises the managed-lifecycle happy path end-to-end:
 *   1. Create a client with `InMemoryStorage` + lifecycle wiring.
 *   2. Log in with real credentials → tokens persist to storage.
 *   3. Force a refresh → tokens rotate; storage updates.
 *   4. Clear state.
 *
 * Env loading (in order of precedence — first match wins):
 *   1. Process env already populated by the shell.
 *   2. If `LYNTARI_SDK_TEST_ENV_FILE` is set, that file is parsed via dotenv
 *      and its keys are used to fill any vars missing from process.env. The
 *      path is resolved relative to the current working directory; absolute
 *      paths are accepted. The file is expected to define `LYNTARI_*` keys
 *      directly (no key remapping).
 *   3. Otherwise, `./.env.local` in the SDK repo root is loaded if it exists
 *      (gitignored — see `.gitignore`). This is the zero-config developer
 *      ergonomic: drop a `.env.local` with `LYNTARI_*` keys next to the SDK
 *      and `npm run test:integration:dev` works.
 *
 * The script logs which source supplied each var at the top so a reader
 * can tell what's being used without echoing the values.
 *
 * Required vars (script exits non-zero with a clear message if any are missing):
 *   LYNTARI_BASE_URL          Edge Functions URL to exercise (e.g.,
 *                             `https://<project>.supabase.co/functions/v1`)
 *   LYNTARI_API_KEY           public API key
 *   LYNTARI_HMAC_KEY          HMAC signing secret
 *   LYNTARI_TEST_EMAIL        email for an existing test account
 *   LYNTARI_TEST_PASSWORD     password for that account
 *
 * Optional:
 *   LYNTARI_SDK_TEST_ENV_FILE path to a .env file with the above vars
 *
 * Run via `npm run test:integration:dev` (or `tsx scripts/test-integration-dev.ts`).
 * NOT part of the every-push CI gate — invoke manually before releases or
 * after touching transport / auth lifecycle code paths.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import {
  createLyntariClient,
  InMemoryStorage,
  type AuthEvent,
} from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Zero-config fallback when `LYNTARI_SDK_TEST_ENV_FILE` isn't set. */
const DEFAULT_ENV_FILE = path.resolve(__dirname, '..', '.env.local');

interface RequiredEnv {
  LYNTARI_BASE_URL: string;
  LYNTARI_API_KEY: string;
  LYNTARI_HMAC_KEY: string;
  LYNTARI_TEST_EMAIL: string;
  LYNTARI_TEST_PASSWORD: string;
}

type VarSource = 'process.env' | `env-file:${string}`;

interface ResolvedVar {
  value: string;
  source: VarSource;
}

interface EnvResolution {
  env: RequiredEnv;
  sources: Record<keyof RequiredEnv, VarSource>;
}

interface LoadedEnvFile {
  loaded: boolean;
  path: string | null;
  vars: Record<string, string | undefined>;
}

function loadEnvFile(): LoadedEnvFile {
  const explicit = process.env.LYNTARI_SDK_TEST_ENV_FILE;
  if (explicit) {
    const resolved = path.resolve(process.cwd(), explicit);
    if (!existsSync(resolved)) {
      console.error(`[env] LYNTARI_SDK_TEST_ENV_FILE points at ${resolved} but no file exists there.`);
      process.exit(1);
    }
    // Load into an isolated object so we don't pollute process.env. The
    // resolveVar layer below applies the precedence (process.env wins).
    // `quiet: true` suppresses dotenv's "injected env (N) from <path>" line.
    const parsed = loadDotenv({ path: resolved, processEnv: {}, quiet: true });
    return { loaded: !parsed.error, path: resolved, vars: parsed.parsed ?? {} };
  }

  if (existsSync(DEFAULT_ENV_FILE)) {
    const parsed = loadDotenv({ path: DEFAULT_ENV_FILE, processEnv: {}, quiet: true });
    return { loaded: !parsed.error, path: DEFAULT_ENV_FILE, vars: parsed.parsed ?? {} };
  }

  return { loaded: false, path: null, vars: {} };
}

function resolveVar(key: string, envFile: LoadedEnvFile): ResolvedVar | null {
  const fromProcess = process.env[key];
  if (fromProcess) return { value: fromProcess, source: 'process.env' };
  if (envFile.loaded && envFile.path) {
    const fromFile = envFile.vars[key];
    if (fromFile) return { value: fromFile, source: `env-file:${envFile.path}` };
  }
  return null;
}

function resolveEnv(): EnvResolution {
  const envFile = loadEnvFile();
  if (envFile.loaded && envFile.path) {
    console.log(`[env] loaded ${envFile.path}`);
  } else {
    console.log('[env] no env file loaded (set LYNTARI_SDK_TEST_ENV_FILE or drop a .env.local in the SDK repo root)');
  }

  const baseUrl = resolveVar('LYNTARI_BASE_URL', envFile);
  const apiKey = resolveVar('LYNTARI_API_KEY', envFile);
  const hmacKey = resolveVar('LYNTARI_HMAC_KEY', envFile);
  const email = resolveVar('LYNTARI_TEST_EMAIL', envFile);
  const password = resolveVar('LYNTARI_TEST_PASSWORD', envFile);

  const missing: string[] = [];
  if (!baseUrl) missing.push('LYNTARI_BASE_URL');
  if (!apiKey) missing.push('LYNTARI_API_KEY');
  if (!hmacKey) missing.push('LYNTARI_HMAC_KEY');
  if (!email) missing.push('LYNTARI_TEST_EMAIL');
  if (!password) missing.push('LYNTARI_TEST_PASSWORD');

  if (missing.length > 0) {
    console.error('\nMissing required env vars:');
    for (const m of missing) console.error(`  - ${m}`);
    console.error('\nProvide them via either:');
    console.error('  - shell env (export LYNTARI_BASE_URL=... LYNTARI_API_KEY=... etc.), OR');
    console.error('  - a .env file: set LYNTARI_SDK_TEST_ENV_FILE=path/to/file, OR');
    console.error(`  - a .env.local in the SDK repo root (${DEFAULT_ENV_FILE})`);
    process.exit(1);
  }

  return {
    env: {
      LYNTARI_BASE_URL: baseUrl!.value,
      LYNTARI_API_KEY: apiKey!.value,
      LYNTARI_HMAC_KEY: hmacKey!.value,
      LYNTARI_TEST_EMAIL: email!.value,
      LYNTARI_TEST_PASSWORD: password!.value,
    },
    sources: {
      LYNTARI_BASE_URL: baseUrl!.source,
      LYNTARI_API_KEY: apiKey!.source,
      LYNTARI_HMAC_KEY: hmacKey!.source,
      LYNTARI_TEST_EMAIL: email!.source,
      LYNTARI_TEST_PASSWORD: password!.source,
    },
  };
}

function shortToken(token: string | null): string {
  if (!token) return '(none)';
  return `${token.slice(0, 12)}…`;
}

async function main(): Promise<void> {
  const { env, sources } = resolveEnv();

  console.log('[env] resolved sources:');
  for (const key of Object.keys(sources) as Array<keyof RequiredEnv>) {
    console.log(`  ${key}: ${sources[key]}`);
  }
  console.log('');

  const storage = new InMemoryStorage();
  const events: AuthEvent[] = [];

  const client = createLyntariClient({
    baseUrl: env.LYNTARI_BASE_URL,
    apiKey: env.LYNTARI_API_KEY,
    hmacSecret: env.LYNTARI_HMAC_KEY,
    auth: {
      storage,
      onEvent: (e) => {
        events.push(e);
        console.log(`  [event] ${e.type}`);
      },
    },
  });

  console.log('1. init (no stored auth)');
  const init = await client.auth.init!();
  console.log(`   restored: ${init.restored}`);
  if (init.restored) {
    throw new Error('Expected no stored auth on a fresh InMemoryStorage');
  }

  console.log('2. login');
  const login = await client.auth.login({
    email: env.LYNTARI_TEST_EMAIL,
    password: env.LYNTARI_TEST_PASSWORD,
  });
  console.log(`   token: ${shortToken(login.token)}`);
  console.log(`   state: ${JSON.stringify(client.auth.state)}`);
  const storedAccess = await storage.get('authToken');
  const storedRefresh = await storage.get('refreshToken');
  if (storedAccess !== login.token) throw new Error('authToken not persisted');
  if (storedRefresh !== login.refresh_token) throw new Error('refreshToken not persisted');

  console.log('3. forceRefresh');
  const refreshed = await client.auth.forceRefresh!();
  console.log(`   new token: ${shortToken(refreshed.access_token)}`);
  console.log(`   state: ${JSON.stringify(client.auth.state)}`);
  if (refreshed.access_token === login.token) {
    throw new Error('Expected token rotation across refresh');
  }
  if ((await storage.get('authToken')) !== refreshed.access_token) {
    throw new Error('Rotated access token not persisted');
  }
  if ((await storage.get('refreshToken')) !== refreshed.refresh_token) {
    throw new Error('Rotated refresh token not persisted');
  }

  console.log('4. clear');
  await client.auth.clear!();
  if (client.getAccessToken() !== null) throw new Error('clear() left in-memory token');
  if ((await storage.get('authToken')) !== null) throw new Error('clear() left stored authToken');

  const tokenRefreshedCount = events.filter((e) => e.type === 'tokenRefreshed').length;
  console.log(`\nOK — ${events.length} lifecycle events (${tokenRefreshedCount} × tokenRefreshed)`);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
