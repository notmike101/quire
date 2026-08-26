import { execSync } from 'node:child_process';

export default async function globalTeardown(): Promise<void> {
  execSync('docker compose -f ../docker-compose.yml -f ../docker-compose.e2e.yml down -v', {
    stdio: 'inherit',
    // The base compose file interpolates ${POSTGRES_PASSWORD:?...}, ${QUIRE_API_KEY:?...}
    // and ${UNLOCK_SECRET:?...} at parse time, so all three must be exported for the
    // compose command (the override's literal values still win at runtime).
    env: {
      ...process.env,
      POSTGRES_PASSWORD: 'e2e',
      QUIRE_API_KEY: 'e2e-test-key-0000000000000000000000',
      UNLOCK_SECRET: 'e2e-unlock-secret-0000000000000000',
    },
    timeout: 120_000,
  });
}
