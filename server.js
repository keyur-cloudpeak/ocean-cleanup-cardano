import net from 'node:net';
import app from './src/app.js';
import { env } from './src/config/env.js';

const HOST = process.env.HOST || '0.0.0.0';

export function findAvailablePort(startPort, host = HOST) {
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
  const requestedPort = Number(env.port);
  const port = await findAvailablePort(requestedPort, HOST);

  const server = app.listen(port, HOST, () => {
    if (port !== requestedPort) {
      console.warn(`Warning: Port ${requestedPort} was in use. Using next available port.`);
    }
    console.log(`listening on http://${HOST}:${port}`);
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
