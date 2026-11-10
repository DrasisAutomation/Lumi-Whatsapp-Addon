'use strict';

const { createWhatsAppServer } = require('./server');

async function main() {
  const port = Number(process.env.PORT) || 8653;
  const instance = await createWhatsAppServer();
  const { server, logger, close } = instance;

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Home Assistant Lumi Whatsapp Add-on server listening');
  });

  const shutdown = async (signal) => {
    logger.info({ signal }, 'Shutting down Lumi Whatsapp Add-on gracefully...');
    try {
      await close();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Global Unhandled Rejection Guard: prevents Home Assistant / s6 container crash loops
  // caused by background Baileys query timeouts (408 Boom), socket closures, or DNS/network blips
  process.on('unhandledRejection', (reason, promise) => {
    const isBaileysOrNetwork =
      reason?.message === 'Timed Out' ||
      reason?.output?.statusCode === 408 ||
      reason?.data?.output?.statusCode === 408 ||
      reason?.code === 'ECONNRESET' ||
      reason?.code === 'ETIMEDOUT' ||
      reason?.code === 'EPIPE' ||
      reason?.code === 'EAI_AGAIN' ||
      (reason?.stack && (
        reason.stack.includes('@whiskeysockets/baileys') ||
        reason.stack.includes('generics.js') ||
        reason.stack.includes('socket.js') ||
        reason.stack.includes('noise-handler')
      ));

    if (isBaileysOrNetwork) {
      logger.warn(
        {
          message: reason?.message,
          code: reason?.code || reason?.output?.statusCode || reason?.data?.output?.statusCode,
          source: 'baileys/network',
        },
        'Handled background WhatsApp/Baileys timeout or network glitch safely (prevented container restart)'
      );
      return;
    }

    logger.error({ reason: reason?.stack || reason }, 'Unhandled Promise Rejection in Lumi Whatsapp Add-on');
  });

  // Global Uncaught Exception Guard: absorbs transient socket/crypto glitches
  process.on('uncaughtException', (err) => {
    const isNetworkOrBaileys =
      err?.message === 'Timed Out' ||
      err?.code === 'ECONNRESET' ||
      err?.code === 'ETIMEDOUT' ||
      err?.code === 'EPIPE' ||
      err?.code === 'EAI_AGAIN' ||
      (err?.stack && (
        err.stack.includes('@whiskeysockets/baileys') ||
        err.stack.includes('generics.js') ||
        err.stack.includes('socket.js') ||
        err.stack.includes('noise-handler')
      ));

    if (isNetworkOrBaileys) {
      logger.warn(
        { message: err.message, code: err.code, source: 'baileys/network' },
        'Handled background network/Baileys exception safely (prevented container restart)'
      );
      return;
    }

    logger.fatal({ err: err?.stack || err }, 'Fatal uncaught exception in Lumi Whatsapp Add-on');
    process.exit(1);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error starting WhatsApp Add-on:', err);
    process.exit(1);
  });
}

module.exports = { main };
