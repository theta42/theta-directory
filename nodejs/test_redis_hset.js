const { createClient } = require('redis');
async function run() {
  const client = createClient();
  await client.connect();
  try {
    await client.HSET('AuthToken_uuid', 'key', true); // boolean is not string
  } catch (e) {
    console.error(e.stack);
  }
  process.exit(0);
}
run();
