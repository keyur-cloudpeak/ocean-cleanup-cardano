import app from './src/app.js';
import { env } from './src/config/env.js';
import { validateWalletSetup } from './src/config/wallet.js';
import indexerService from './src/services/indexerService.js';

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

    // Background sweep: confirm pending proof transactions and retry any
    // approved activities that somehow never got a proof submitted.
    // Runs every five minutes. Skips silently if wallet/Blockfrost isn't
    // configured (e.g. dev without a seed phrase).
    const syncProofs = async () => {
      try {
        const summary = await indexerService.sync();
        if (summary.checkedConfirmations > 0 || summary.retriedMissing > 0) {
          console.log(
            `[onchainProof] sweep: confirmed=${summary.checkedConfirmations} retried=${summary.retriedMissing}`
          );
        }
      } catch (err) {
        console.warn('[onchainProof] monitor sweep error:', err.message);
      }
    };

    // Reconcile immediately after startup, then on the regular interval.
    syncProofs();
    setInterval(syncProofs, 5 * 60_000);
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
