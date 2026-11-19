const fs = require('fs');
const path = require('path');

const hasDist = fs.existsSync(path.join(__dirname, 'dist', 'server.cjs'));

module.exports = {
  apps: [
    {
      name: 'ecns',
      script: hasDist ? 'dist/server.cjs' : 'node_modules/tsx/dist/cli.mjs',
      args: hasDist ? undefined : 'server.ts',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      autorestart: true,
      max_memory_restart: '1G',
      windowsHide: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        AZURE_AUTH_ENABLED: process.env.AZURE_AUTH_ENABLED || 'false',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3001,
        FORCE_HTTPS: 'false',
        AZURE_AUTH_ENABLED: process.env.AZURE_AUTH_ENABLED || 'false',
      },
    },
  ],
};