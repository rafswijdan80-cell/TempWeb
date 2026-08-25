// config.js - Konfigurasi Utama TempEmailNih
// Catatan: Tidak menggunakan .env sesuai spesifikasi

const config = {
  // Port aplikasi (Port 3000 wajib untuk environment)
  PORT: process.env.PORT || 3000,
  HOST: '0.0.0.0',

  // Mail.tm API Base URL
  MAILTM_BASE_URL: process.env.MAILTM_API_URL || process.env.MAILTM_BASE_URL || 'https://api.mail.tm',

  // Database JSON file path (menggunakan /tmp pada environment serverless Vercel)
  DB_FILE_PATH: process.env.VERCEL ? '/tmp/tempemail.json' : (process.env.DB_FILE_PATH || './database/tempemail.json'),

  // Polling / Auto-refresh interval (millisecond)
  AUTO_REFRESH_INTERVAL_MS: 10000, // 10 detik

  // Request timeout (millisecond)
  REQUEST_TIMEOUT_MS: 15000,

  // PutzPay Payment Gateway Config
  PUTZPAY_BASE_URL: process.env.PUTZPAY_BASE_URL || 'https://putzpay.biz.id',
  PUTZPAY_API_KEY: process.env.PUTZPAY_API_KEY || 'YOUR_API_KEY',

  // Nama Brand Aplikasi
  APP_NAME: 'TempEmailNih',
  APP_DESCRIPTION: 'Layanan Temporary Email bergaya Gmail dengan Mail.tm API',
  VERSION: '1.0.0'
};

export default config;
