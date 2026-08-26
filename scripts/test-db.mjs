// Usage: node scripts/test-db.mjs up|down
// Starts/stops a throwaway Postgres for integration tests (port 54329).
const [,, cmd] = process.argv;
const { execFileSync } = await import('node:child_process');
if (cmd === 'up') {
  execFileSync('docker', ['run', '-d', '--rm', '--name', 'quire-test-db',
    '-e', 'POSTGRES_USER=quire', '-e', 'POSTGRES_PASSWORD=quire',
    '-e', 'POSTGRES_DB=quire_test', '-p', '54329:5432', 'postgres:16-alpine'], { stdio: 'inherit' });
} else if (cmd === 'down') {
  execFileSync('docker', ['rm', '-f', 'quire-test-db'], { stdio: 'inherit' });
} else {
  console.error(`Unknown command: ${cmd ?? '(none)'}\nUsage: node scripts/test-db.mjs up|down`);
  process.exit(1);
}
