import { randomBytes } from 'node:crypto';

export async function runSetup(): Promise<void> {
  const apiKey = randomBytes(32).toString('hex');
  const unlockSecret = randomBytes(32).toString('hex');
  console.log(`Add these to your server's .env:\n\n  QUIRE_API_KEY=${apiKey}\n  UNLOCK_SECRET=${unlockSecret}\n`);
  console.log('And point the CLI at your server:\n\n  export QUIRE_SERVER_URL=https://<your-host>\n  export QUIRE_API_KEY=<the key above>\n');
  console.log('Or write ~/.quire/config.json: { "serverUrl": "https://<your-host>", "apiKey": "<key>" }');
}
