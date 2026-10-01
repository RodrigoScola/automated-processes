// Written by the integration test's script step, so the test can check the task environment.
const fs = require('fs');
const path = require('path');
fs.writeFileSync(
	path.join(__dirname, 'env-output.json'),
	JSON.stringify({ DATABASE_URL: process.env.DATABASE_URL, FIXTURE_ONLY: process.env.FIXTURE_ONLY, SCRIPT_VAR: process.env.SCRIPT_VAR }),
);
