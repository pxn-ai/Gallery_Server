const express = require('express');
const path = require('path');
const apiRoutes = require('./src/routes/api');
const { scanMedia } = require('./src/scanner');
const aiIndexer = require('./src/ai/indexer');

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';

const app = express();

// Middleware
app.use(express.json());

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
}));

// API routes
app.use('/api', apiRoutes);

// SPA fallback — serve index.html for unknown routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, HOST, async () => {
  const hostname = require('os').hostname();
  const localUrl = `http://${hostname}.local:${PORT}`;

  console.log(`
  ╔══════════════════════════════════════════════════════╗
  ║           🖼️  Gallery Server v2 Running               ║
  ╠══════════════════════════════════════════════════════╣
  ║                                                      ║
  ║  Local:   http://localhost:${PORT}                     ║
  ║  Network: ${localUrl.padEnd(40)}║
  ║  IP:      http://${getLocalIP()}:${PORT}                  ║
  ║                                                      ║
  ║  Open the Network URL on your phone to browse! 📱    ║
  ╚══════════════════════════════════════════════════════╝
  `);

  // Run initial scan in background
  console.log('🔍 Starting initial media scan...\n');
  try {
    await scanMedia();
  } catch (err) {
    console.error('Initial scan failed:', err.message);
  }

  // Start AI face indexer as persistent background task
  console.log('🧠 Starting AI face indexer (background)...\n');
  aiIndexer.start();
});

/**
 * Get local network IP address
 */
function getLocalIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}
