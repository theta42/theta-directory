const { createClient } = require('redis');
async function run() {
  const client = createClient();
  await client.connect();
  try {
    await client.SREM('key', undefined);
  } catch (e) {
    console.error('SREM', e.stack);
  }
  process.exit(0);
}
run();
