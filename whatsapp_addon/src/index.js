'use strict';

const { createWhatsAppServer } = require('./server');

async function main() {
  const port = Number(process.env.PORT) || 8099;
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
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error starting WhatsApp Add-on:', err);
    process.exit(1);
  });
}

module.exports = { main };
