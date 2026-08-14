import net from 'node:net';
import app from './src/app.js';
import { env } from './src/config/env.js';
import { validateWalletSetup } from './src/config/wallet.js';

const SERVER_HOST = process.env.SERVER_HOST || '0.0.0.0';

export function findAvailablePort(startPort, host = SERVER_HOST) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        resolve(findAvailablePort(startPort + 1, host));
        return;
      }

      reject(error);
    });

    probe.once('listening', () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });

    probe.listen(startPort, host);
  });
}

const startServer = async () => {
  try {
    // Validate wallet configuration during startup
    validateWalletSetup();
  } catch (walletError) {
    console.error('❌ Wallet setup validation failed:', walletError.message);
    process.exit(1);
  }

  const requestedPort = Number(env.port);
  const port = await findAvailablePort(requestedPort, SERVER_HOST);

  const server = app.listen(port, SERVER_HOST, () => {
    if (port !== requestedPort) {
      console.warn(`Warning: Port ${requestedPort} was in use. Using next available port.`);
    }
    console.log(`listening on http://${SERVER_HOST}:${port}`);
  });

  server.on('error', (error) => {
    console.error('Server failed to start:', error);
    process.exit(1);
  });

  return server;
};

if (process.env.NODE_ENV !== 'test') {
  startServer().catch((error) => {
    console.error('Server failed to start:', error);
    process.exit(1);
  });
}

export { startServer };
