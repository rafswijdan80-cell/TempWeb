// index.js - Server Utama TempEmailNih (Express + Static Public)
import express from 'express';
import path from 'path';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import config from './config.js';
import mailboxRoutes from './routes/mailbox.js';
import messagesRoutes from './routes/messages.js';
import donationRoutes from './routes/donation.js';
import mailService from './mailService.js';
import { getMailboxFromRequest } from './routes/mailbox.js';

const app = express();
const PORT = config.PORT || 3000;
const HOST = '0.0.0.0';

// Middleware keamanan & parser
app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sajikan file statis dari folder public
const publicPath = path.join(process.cwd(), 'public');
app.use(express.static(publicPath));

// API Routes
app.use('/api/mailbox', mailboxRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/donation', donationRoutes);

// Route khusus halaman traktir
app.get('/traktir', (req, res) => {
  res.sendFile(path.join(publicPath, 'traktir.html'));
});

// Endpoint refresh cepat
app.post('/api/refresh', async (req, res) => {
  try {
    const mailbox = getMailboxFromRequest(req);
    if (!mailbox) {
      return res.status(404).json({ success: false, error: 'Mailbox belum tersedia.' });
    }
    const inboxData = await mailService.getNormalizedInbox(mailbox);
    res.json({ success: true, ...inboxData });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Gagal merefresh email' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: config.APP_NAME,
    version: config.VERSION,
    time: new Date().toISOString()
  });
});

// Route fallback untuk navigasi HTML
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Error handling terpusat (tanpa membocorkan stack trace ke frontend)
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.message);
  res.status(500).json({
    success: false,
    error: 'Terjadi kesalahan pada server. Silakan coba beberapa saat lagi.'
  });
});

// Jalankan server standalone hanya saat tidak berjalan di environment serverless Vercel
if (!process.env.VERCEL) {
  app.listen(PORT, HOST, () => {
    console.log(`=========================================`);
    console.log(`🚀 ${config.APP_NAME} berjalan pada:`);
    console.log(`👉 http://${HOST}:${PORT}`);
    console.log(`=========================================`);
  });
}

// Export app untuk Vercel Serverless Function & testing
export default app;
