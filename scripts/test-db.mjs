// Usage: node scripts/test-db.mjs up|down
// Starts/stops a throwaway Postgres for integration tests (port 54329).
const [,, cmd] = process.argv;
const args =
  cmd === 'up'
    ? ['run', '-d', '--rm', '--name', 'quire-test-db',
       '-e', 'POSTGRES_USER=quire', '-e', 'POSTGRES_PASSWORD=quire',
       '-e', 'POSTGRES_DB=quire_test', '-p', '54329:5432', 'postgres:16-alpine']
    : ['rm', '-f', 'quire-test-db'];
const { execFileSync } = await import('node:child_process');
execFileSync('docker', args, { stdio: 'inherit' });
