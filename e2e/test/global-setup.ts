import { execSync } from 'node:child_process';

const COMPOSE = 'docker compose -f ../docker-compose.yml -f ../docker-compose.e2e.yml';

export default async function globalSetup(): Promise<void> {
  // The base compose file interpolates ${POSTGRES_PASSWORD:?...}, ${QUIRE_API_KEY:?...}
  // and ${UNLOCK_SECRET:?...} at parse time, so all three must be exported for the
  // compose command (the override's literal values still win at runtime).
  execSync(`${COMPOSE} up -d --build`, {
    stdio: 'inherit',
    env: {
      ...process.env,
      POSTGRES_PASSWORD: 'e2e',
      QUIRE_API_KEY: 'e2e-test-key-0000000000000000000000',
      UNLOCK_SECRET: 'e2e-unlock-secret-0000000000000000',
    },
    timeout: 600_000,
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:8790/healthz');
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error('E2E stack did not become healthy within 120s');
}
