// Stand-in "server" for the integration test: records its environment, then keeps running.
const fs = require('fs');
const path = require('path');
fs.writeFileSync(
	path.join(__dirname, 'server-output.json'),
	JSON.stringify({ DATABASE_URL: process.env.DATABASE_URL, pid: process.pid }),
);
setInterval(() => undefined, 1000);
