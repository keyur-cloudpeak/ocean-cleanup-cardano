import app from './src/app.js';
import { env } from './src/config/env.js';
import { validateWalletSetup } from './src/config/wallet.js';

const SERVER_HOST = process.env.SERVER_HOST || '0.0.0.0';

const startServer = async () => {
  try {
    // Validate wallet configuration during startup
    validateWalletSetup();
  } catch (walletError) {
    console.error('❌ Wallet setup validation failed:', walletError.message);
    process.exit(1);
  }

  const port = Number(env.port);

  const server = app.listen(port, SERVER_HOST, () => {
    // Use localhost for a nicer development URL
    const displayHost =
      SERVER_HOST === '0.0.0.0' ? 'localhost' : SERVER_HOST;

    console.log(`🚀 Server running at http://${displayHost}:${port}`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`❌ Port ${port} is already in use.`);
      console.error(`👉 Stop the process using port ${port} and try again.`);
      process.exit(1);
    }

    console.error('❌ Server failed to start:', error);
    process.exit(1);
  });

  return server;
};

if (process.env.NODE_ENV !== 'test') {
  startServer().catch((error) => {
    console.error('❌ Server failed to start:', error);
    process.exit(1);
  });
}

export { startServer };