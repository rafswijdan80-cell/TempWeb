// ==============================================================================
// index.js — Backend Utama TempWeb / TempEmailNih
// Menggabungkan seluruh logic Database, Mail.tm API Gateway, PutzPay, dan Express
// Kompatibel 100% untuk Vercel Serverless dan VPS / Local Standalone
// ==============================================================================

import express from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';

// ==============================================================================
// 1. KONFIGURASI APLIKASI
// ==============================================================================
const config = {
  PORT: process.env.PORT || 3000,
  HOST: '0.0.0.0',
  MAILTM_BASE_URL: process.env.MAILTM_API_URL || process.env.MAILTM_BASE_URL || 'https://api.mail.tm',
  DB_FILE_PATH: process.env.VERCEL ? '/tmp/tempemail.json' : (process.env.DB_FILE_PATH || './database/tempemail.json'),
  AUTO_REFRESH_INTERVAL_MS: 10000,
  REQUEST_TIMEOUT_MS: 15000,
  SESSION_SECRET: process.env.SESSION_SECRET || 'tempweb_ultra_secure_session_secret_key_2026!',
  PUTZPAY_BASE_URL: process.env.PUTZPAY_BASE_URL || 'https://putzpay.biz.id',
  PUTZPAY_API_KEY: process.env.PUTZPAY_API_KEY || 'YOUR_API_KEY',
  APP_NAME: 'TempEmailNih',
  APP_DESCRIPTION: 'Layanan Temporary Email bergaya Gmail dengan Mail.tm API',
  VERSION: '1.2.0'
};

// Derive 32-byte encryption key for AES-256-GCM stateless serverless sessions
const SESSION_ENC_KEY = crypto.createHash('sha256').update(config.SESSION_SECRET).digest();

// ==============================================================================
// 2. STATELESS SESSION CRYPTO LAYER (Untuk Sinkronisasi Multi-Instance Vercel)
// ==============================================================================
function createSessionToken(mailbox) {
  if (!mailbox || !mailbox.id || !mailbox.email || !mailbox.providerPassword) {
    return null;
  }
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', SESSION_ENC_KEY, iv);
    const payload = JSON.stringify({
      id: mailbox.id,
      email: mailbox.email,
      providerAccountId: mailbox.providerAccountId || mailbox.id,
      providerPassword: mailbox.providerPassword,
      providerToken: mailbox.providerToken || null,
      providerStatus: mailbox.providerStatus || 'active',
      createdAt: mailbox.createdAt || new Date().toISOString()
    });
    let encrypted = cipher.update(payload, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');
    return `${iv.toString('base64')}.${authTag}.${encrypted}`;
  } catch (err) {
    console.error('[SessionCrypto] Gagal membuat session token:', err.message);
    return null;
  }
}

function verifySessionToken(tokenStr) {
  if (!tokenStr || typeof tokenStr !== 'string') return null;
  try {
    const parts = tokenStr.split('.');
    if (parts.length !== 3) return null;
    const [ivB64, tagB64, encB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', SESSION_ENC_KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encB64, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (err) {
    return null;
  }
}

// ==============================================================================
// 3. STORAGE & DATABASE LAYER (JSON File + In-Memory + KV Support)
// ==============================================================================
class Database {
  constructor() {
    this.dbPath = path.resolve(config.DB_FILE_PATH);
    this.dirPath = path.dirname(this.dbPath);
    this.memoryCache = null;
    this.locks = new Set();
    this.init();
  }

  init() {
    try {
      if (!fs.existsSync(this.dirPath)) {
        fs.mkdirSync(this.dirPath, { recursive: true });
      }

      if (!fs.existsSync(this.dbPath)) {
        // Coba salin seed awal dari ./database/tempemail.json jika ada
        const seedPath = path.resolve('./database/tempemail.json');
        if (seedPath !== this.dbPath && fs.existsSync(seedPath)) {
          try {
            const seedContent = fs.readFileSync(seedPath, 'utf-8');
            fs.writeFileSync(this.dbPath, seedContent, 'utf-8');
            this.memoryCache = JSON.parse(seedContent);
            return;
          } catch (e) {
            // Lanjut ke inisialisasi default jika gagal membaca seed
          }
        }

        const initialData = {
          mailboxes: {},
          messageStates: {},
          donations: {},
          settings: {
            createdAt: new Date().toISOString()
          }
        };
        fs.writeFileSync(this.dbPath, JSON.stringify(initialData, null, 2), 'utf-8');
        this.memoryCache = initialData;
      }
    } catch (err) {
      if (!this.memoryCache) {
        this.memoryCache = { mailboxes: {}, messageStates: {}, donations: {}, settings: {} };
      }
    }
  }

  readData() {
    try {
      if (!fs.existsSync(this.dbPath)) {
        this.init();
      }
      if (fs.existsSync(this.dbPath)) {
        const raw = fs.readFileSync(this.dbPath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.memoryCache = parsed;
        return parsed;
      }
    } catch (err) {
      // Fallback ke memoryCache jika disk I/O terhalang di Serverless
    }
    return this.memoryCache || { mailboxes: {}, messageStates: {}, donations: {}, settings: {} };
  }

  writeData(data) {
    this.memoryCache = data;
    try {
      if (!fs.existsSync(this.dirPath)) {
        fs.mkdirSync(this.dirPath, { recursive: true });
      }
      const tempPath = `${this.dbPath}.tmp.${Date.now()}`;
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tempPath, this.dbPath);
      return true;
    } catch (err) {
      try {
        fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 2), 'utf-8');
        return true;
      } catch (writeErr) {
        return true;
      }
    }
  }

  // --- Operasi Mailbox ---
  saveMailbox(mailbox) {
    if (!mailbox || !mailbox.id) return null;
    const data = this.readData();
    const now = new Date().toISOString();
    if (!data.mailboxes) data.mailboxes = {};

    data.mailboxes[mailbox.id] = {
      id: mailbox.id,
      email: mailbox.email,
      providerAccountId: mailbox.providerAccountId || mailbox.id,
      providerPassword: mailbox.providerPassword || (data.mailboxes[mailbox.id]?.providerPassword),
      providerToken: mailbox.providerToken || (data.mailboxes[mailbox.id]?.providerToken),
      providerStatus: mailbox.providerStatus || 'active',
      createdAt: mailbox.createdAt || (data.mailboxes[mailbox.id]?.createdAt) || now,
      updatedAt: now
    };

    this.writeData(data);
    return data.mailboxes[mailbox.id];
  }

  getMailbox(id) {
    if (!id) return null;
    const data = this.readData();
    return data.mailboxes?.[id] || null;
  }

  getMailboxByEmail(email) {
    if (!email) return null;
    const data = this.readData();
    const cleanEmail = email.toLowerCase().trim();
    for (const id in (data.mailboxes || {})) {
      if (data.mailboxes[id].email?.toLowerCase() === cleanEmail) {
        return data.mailboxes[id];
      }
    }
    return null;
  }

  getAllMailboxes() {
    const data = this.readData();
    return Object.values(data.mailboxes || {}).map(m => ({
      id: m.id,
      email: m.email,
      providerStatus: m.providerStatus || 'active',
      createdAt: m.createdAt
    }));
  }

  deleteMailbox(id) {
    if (!id) return false;
    const data = this.readData();
    if (data.mailboxes && data.mailboxes[id]) {
      delete data.mailboxes[id];
      this.writeData(data);
      return true;
    }
    return false;
  }

  updateMailboxToken(id, token, status = 'active') {
    const data = this.readData();
    if (data.mailboxes && data.mailboxes[id]) {
      data.mailboxes[id].providerToken = token;
      data.mailboxes[id].providerStatus = status;
      data.mailboxes[id].updatedAt = new Date().toISOString();
      this.writeData(data);
      return data.mailboxes[id];
    }
    return null;
  }

  // --- Operasi Status Pesan (Read / Star / Delete) ---
  getMessageStateKey(mailboxId, messageId) {
    return `${mailboxId}:${messageId}`;
  }

  getMessageState(mailboxId, messageId) {
    const data = this.readData();
    const key = this.getMessageStateKey(mailboxId, messageId);
    return data.messageStates?.[key] || { isRead: false, isStarred: false, isDeleted: false };
  }

  setMessageRead(mailboxId, messageId, isRead = true) {
    const data = this.readData();
    if (!data.messageStates) data.messageStates = {};
    const key = this.getMessageStateKey(mailboxId, messageId);
    const existing = data.messageStates[key] || {};

    data.messageStates[key] = {
      ...existing,
      mailboxId,
      messageId,
      isRead: Boolean(isRead),
      updatedAt: new Date().toISOString()
    };

    this.writeData(data);
    return data.messageStates[key];
  }

  setMessageStarred(mailboxId, messageId, isStarred = true) {
    const data = this.readData();
    if (!data.messageStates) data.messageStates = {};
    const key = this.getMessageStateKey(mailboxId, messageId);
    const existing = data.messageStates[key] || {};

    data.messageStates[key] = {
      ...existing,
      mailboxId,
      messageId,
      isStarred: Boolean(isStarred),
      updatedAt: new Date().toISOString()
    };

    this.writeData(data);
    return data.messageStates[key];
  }

  setMessageDeleted(mailboxId, messageId, isDeleted = true) {
    const data = this.readData();
    if (!data.messageStates) data.messageStates = {};
    const key = this.getMessageStateKey(mailboxId, messageId);
    const existing = data.messageStates[key] || {};

    data.messageStates[key] = {
      ...existing,
      mailboxId,
      messageId,
      isDeleted: Boolean(isDeleted),
      updatedAt: new Date().toISOString()
    };

    this.writeData(data);
    return data.messageStates[key];
  }

  // --- Operasi Donasi PutzPay ---
  saveDonation(donation) {
    const data = this.readData();
    if (!data.donations) data.donations = {};
    const invoiceId = donation.invoice_id;
    if (!invoiceId) return null;

    data.donations[invoiceId] = {
      id: invoiceId,
      invoice_id: invoiceId,
      display_name: donation.display_name || 'Anonymous',
      message: donation.message || '',
      amount: donation.amount || 0,
      fee: donation.fee || 0,
      total: donation.total || donation.amount,
      status: donation.status || 'pending',
      qris_image: donation.qris_image || '',
      expired_at: donation.expired_at,
      created_at: donation.created_at || new Date().toISOString(),
      paid_at: donation.paid_at || null,
      updated_at: new Date().toISOString()
    };

    this.writeData(data);
    return data.donations[invoiceId];
  }

  getDonation(invoiceId) {
    if (!invoiceId) return null;
    const data = this.readData();
    return data.donations?.[invoiceId] || null;
  }

  updateDonationStatus(invoiceId, status, paidAt = null) {
    const data = this.readData();
    if (data.donations && data.donations[invoiceId]) {
      data.donations[invoiceId].status = status;
      data.donations[invoiceId].updated_at = new Date().toISOString();
      if (paidAt) data.donations[invoiceId].paid_at = paidAt;
      this.writeData(data);
      return data.donations[invoiceId];
    }
    return null;
  }

  getRecentDonations(limit = 10) {
    const data = this.readData();
    const list = Object.values(data.donations || {});
    return list
      .filter(d => d.status === 'paid')
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
      .slice(0, limit);
  }
}

const db = new Database();

// ==============================================================================
// 4. MAIL.TM API SERVICE LAYER
// ==============================================================================
class MailTmService {
  constructor() {
    this.baseUrl = config.MAILTM_BASE_URL;
    this.timeout = config.REQUEST_TIMEOUT_MS;
    this.domainCache = null;
    this.domainCacheExpiry = 0;
  }

  async fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...(options.headers || {})
      };

      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      return response;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error(`Permintaan ke Mail.tm timeout setelah ${this.timeout}ms`);
      }
      throw err;
    }
  }

  // 1. Ambil daftar domain aktif dari Mail.tm
  async getActiveDomains() {
    const now = Date.now();
    if (this.domainCache && this.domainCacheExpiry > now) {
      return this.domainCache;
    }

    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/domains?page=1`);
      if (!res.ok) {
        throw new Error(`Mail.tm domains error: ${res.status}`);
      }

      const data = await res.json();
      const rawList = data['hydra:member'] || data.member || data || [];
      const domains = rawList
        .filter(d => d.isActive !== false)
        .map(d => (d.domain || d).replace(/^@/, ''))
        .filter(Boolean);

      if (domains.length > 0) {
        this.domainCache = domains;
        this.domainCacheExpiry = now + 5 * 60 * 1000; // Cache 5 menit
        return domains;
      }
    } catch (err) {
      console.warn('[MailTmService] Gagal mengambil domain Mail.tm secara dinamis:', err.message);
    }

    // Fallback domain default jika API Mail.tm sedang sibuk
    return this.domainCache || ['emalupe.com', 'mextly.com', 'greencafe24.com', 'biscutt.com'];
  }

  // 2. Generator nama acak & password yang kuat
  generateRandomUsername(prefix = 'nih') {
    const cleanPrefix = prefix.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'nih';
    const randPart = Math.random().toString(36).substring(2, 8);
    const randNum = Math.floor(10 + Math.random() * 90);
    return `${cleanPrefix}_${randPart}${randNum}`;
  }

  generateStrongPassword() {
    const alphaNum = Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 6);
    return `Tmp_${alphaNum}!`;
  }

  // 3. POST /accounts untuk membuat akun baru di Mail.tm
  async createAccount(address, password) {
    const cleanAddress = address.toLowerCase().trim();
    const res = await this.fetchWithTimeout(`${this.baseUrl}/accounts`, {
      method: 'POST',
      body: JSON.stringify({ address: cleanAddress, password })
    });

    const data = await res.json().catch(() => ({}));

    if (res.status === 201) {
      return {
        id: String(data.id || data['@id']?.split('/').pop() || cleanAddress),
        address: data.address || cleanAddress,
        createdAt: data.createdAt || new Date().toISOString()
      };
    }

    if (res.status === 422) {
      const errDetail = data?.message || data?.['hydra:description'] || 'Akun sudah terdaftar';
      const err = new Error(errDetail);
      err.status = 422;
      err.code = 'ACCOUNT_EXISTS';
      throw err;
    }

    throw new Error(data.message || `Gagal mendaftarkan akun di Mail.tm (HTTP ${res.status})`);
  }

  // 4. POST /token untuk otentikasi dan mengambil JWT token
  async obtainToken(address, password) {
    const cleanAddress = address.toLowerCase().trim();
    const res = await this.fetchWithTimeout(`${this.baseUrl}/token`, {
      method: 'POST',
      body: JSON.stringify({ address: cleanAddress, password })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(`Autentikasi gagal (Status ${res.status}): ${errData.message || 'Kredensial tidak valid'}`);
    }

    const data = await res.json();
    if (!data.token) {
      throw new Error('Token tidak ditemukan dalam respons otentikasi Mail.tm');
    }
    return data.token;
  }

  // 5. Validasi token dengan GET /me
  async verifyTokenWithMe(token) {
    if (!token) throw new Error('Token kosong');
    const res = await this.fetchWithTimeout(`${this.baseUrl}/me`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!res.ok) {
      throw new Error(`Token tidak valid (Status ${res.status})`);
    }

    return await res.json();
  }

  // 6. Refresh token menggunakan email & providerPassword
  async refreshToken(mailbox) {
    if (!mailbox || !mailbox.email || !mailbox.providerPassword) {
      console.warn('[MailTmService] Gagal refresh token: data akun tidak lengkap.');
      throw new Error('REAUTH_REQUIRED');
    }

    try {
      console.log(`[MailTmService] Memperbarui token untuk: ${mailbox.email}`);
      const newToken = await this.obtainToken(mailbox.email, mailbox.providerPassword);
      mailbox.providerToken = newToken;
      mailbox.providerStatus = 'active';
      db.updateMailboxToken(mailbox.id, newToken, 'active');
      return newToken;
    } catch (err) {
      console.error(`[MailTmService] Re-auth gagal untuk ${mailbox.email}:`, err.message);
      db.updateMailboxToken(mailbox.id, null, 'expired');
      throw new Error('REAUTH_REQUIRED');
    }
  }

  // 7. Pastikan token aktif sebelum melakukan panggilan API
  async ensureValidToken(mailbox) {
    if (!mailbox) {
      throw new Error('Mailbox tidak ditemukan');
    }

    // Safe debugging log (tidak mengekspos token/password mentah)
    console.log('[MailTmService] Verifikasi token mailbox:', {
      id: mailbox.id,
      email: mailbox.email,
      hasToken: Boolean(mailbox.providerToken),
      hasPassword: Boolean(mailbox.providerPassword)
    });

    if (!mailbox.email || !mailbox.providerPassword) {
      throw new Error('REAUTH_REQUIRED');
    }

    // Jika token sudah ada, uji validitasnya dengan GET /me
    if (mailbox.providerToken) {
      try {
        await this.verifyTokenWithMe(mailbox.providerToken);
        return mailbox.providerToken;
      } catch (err) {
        console.warn(`[MailTmService] Token saat ini invalid/expired untuk ${mailbox.email}, melakukan login ulang...`);
      }
    }

    // Jika token tidak ada atau sudah expired, lakukan login ulang
    return await this.refreshToken(mailbox);
  }

  // 8. Buat Email Otomatis (Auto Generator)
  async createAutoEmail(prefix = 'nih') {
    const domains = await this.getActiveDomains();
    if (!domains || domains.length === 0) {
      throw new Error('Tidak ada domain Mail.tm yang tersedia.');
    }

    let attempts = 0;
    const maxAttempts = 5;

    while (attempts < maxAttempts) {
      attempts++;
      const randomDomain = domains[Math.floor(Math.random() * domains.length)];
      const randomUser = this.generateRandomUsername(prefix);
      const email = `${randomUser}@${randomDomain}`;
      const password = this.generateStrongPassword();

      try {
        const account = await this.createAccount(email, password);
        const token = await this.obtainToken(email, password);
        const me = await this.verifyTokenWithMe(token);

        const mailboxRecord = {
          id: account.id || me.id || `mb_${Date.now()}`,
          email: account.address || email,
          providerAccountId: account.id || me.id,
          providerPassword: password,
          providerToken: token,
          providerStatus: 'active',
          createdAt: new Date().toISOString()
        };

        db.saveMailbox(mailboxRecord);
        console.log(`[MailTmService] Sukses membuat mailbox otomatis: ${mailboxRecord.email}`);

        return mailboxRecord;
      } catch (err) {
        if (err.code === 'ACCOUNT_EXISTS' && attempts < maxAttempts) {
          continue; // Coba nama lain
        }
        if (attempts >= maxAttempts) {
          throw new Error(`Gagal membuat akun Mail.tm setelah ${maxAttempts} percobaan: ${err.message}`);
        }
      }
    }

    throw new Error('Gagal menginisialisasi mailbox baru di Mail.tm');
  }

  // 9. Buat Email Kustom (Custom Username & Domain)
  async createCustomEmail(customUsername, customDomain) {
    if (!customUsername || typeof customUsername !== 'string') {
      throw new Error('Username email wajib diisi.');
    }

    const cleanUsername = customUsername
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9._-]/g, '')
      .slice(0, 32);

    if (cleanUsername.length < 3) {
      throw new Error('Username minimal 3 karakter (hanya huruf, angka, titik, atau strip).');
    }

    const domains = await this.getActiveDomains();
    let selectedDomain = customDomain ? customDomain.replace(/^@/, '').trim().toLowerCase() : domains[0];

    if (!domains.includes(selectedDomain)) {
      selectedDomain = domains[0];
    }

    const email = `${cleanUsername}@${selectedDomain}`;
    const password = this.generateStrongPassword();

    try {
      const account = await this.createAccount(email, password);
      const token = await this.obtainToken(email, password);
      const me = await this.verifyTokenWithMe(token);

      const mailboxRecord = {
        id: account.id || me.id || `mb_${Date.now()}`,
        email: account.address || email,
        providerAccountId: account.id || me.id,
        providerPassword: password,
        providerToken: token,
        providerStatus: 'active',
        createdAt: new Date().toISOString()
      };

      db.saveMailbox(mailboxRecord);
      console.log(`[MailTmService] Sukses membuat mailbox kustom: ${mailboxRecord.email}`);

      return mailboxRecord;
    } catch (err) {
      if (err.code === 'ACCOUNT_EXISTS' || err.status === 422) {
        throw new Error(`Alamat email ${email} sudah digunakan di Mail.tm. Silakan pilih username lain.`);
      }
      throw new Error(`Gagal membuat email kustom: ${err.message}`);
    }
  }

  // 10. Ambil Inbox Pesan (dengan auto-retry saat 401)
  async getNormalizedInbox(mailbox, { page = 1 } = {}) {
    let token = await this.ensureValidToken(mailbox);

    let res = await this.fetchWithTimeout(`${this.baseUrl}/messages?page=${page}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    // Jika 401 Unauthorized, refresh token 1 kali dan coba ulang
    if (res.status === 401) {
      console.warn(`[MailTmService] Mendapatkan 401 dari /messages untuk ${mailbox.email}, melakukan refresh token...`);
      try {
        token = await this.refreshToken(mailbox);
        res = await this.fetchWithTimeout(`${this.baseUrl}/messages?page=${page}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
      } catch (refreshErr) {
        throw new Error('REAUTH_REQUIRED');
      }
    }

    if (!res.ok) {
      if (res.status === 401) {
        throw new Error('REAUTH_REQUIRED');
      }
      throw new Error(`Gagal mengambil kotak masuk dari Mail.tm (HTTP ${res.status})`);
    }

    const data = await res.json();
    return this.processMessagesList(data, mailbox.id);
  }

  processMessagesList(data, mailboxId) {
    const rawList = data['hydra:member'] || data.member || data || [];
    const totalCount = data['hydra:totalItems'] || (Array.isArray(rawList) ? rawList.length : 0);

    const messages = (Array.isArray(rawList) ? rawList : []).map(msg => {
      const msgState = db.getMessageState(mailboxId, msg.id);
      const quickOtp = this.detectGenericVerificationCode(msg.subject || '', msg.intro || '');

      return {
        id: String(msg.id),
        from: {
          name: msg.from?.name || (msg.from?.address ? msg.from.address.split('@')[0] : 'Pengirim'),
          address: msg.from?.address || ''
        },
        to: (msg.to || []).map(t => ({ name: t.name || '', address: t.address || '' })),
        subject: msg.subject || '(Tanpa Subjek)',
        intro: msg.intro || '',
        createdAt: msg.createdAt || new Date().toISOString(),
        hasAttachments: Boolean(msg.hasAttachments),
        isRead: Boolean(msgState.isRead || msg.seen),
        isStarred: Boolean(msgState.isStarred),
        isDeleted: Boolean(msgState.isDeleted),
        quickOtp: quickOtp || null
      };
    }).filter(msg => !msg.isDeleted);

    return {
      messages,
      total: totalCount,
      unreadCount: messages.filter(m => !m.isRead).length
    };
  }

  // 11. Ambil detail email tunggal
  async getMessageDetail(mailbox, messageId) {
    if (!messageId) throw new Error('ID pesan tidak valid');
    let token = await this.ensureValidToken(mailbox);
    const safeId = encodeURIComponent(messageId);

    let res = await this.fetchWithTimeout(`${this.baseUrl}/messages/${safeId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (res.status === 401) {
      token = await this.refreshToken(mailbox);
      res = await this.fetchWithTimeout(`${this.baseUrl}/messages/${safeId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
    }

    if (!res.ok) {
      if (res.status === 404) throw new Error('Email tidak ditemukan atau sudah dihapus di Mail.tm.');
      if (res.status === 401) throw new Error('REAUTH_REQUIRED');
      throw new Error('Gagal mengambil isi email.');
    }

    return await res.json();
  }

  // 12. Ambil detail email lengkap dengan Smart Links & OTP
  async getMessageDetailWithLinks(mailbox, messageId) {
    const rawMsg = await this.getMessageDetail(mailbox, messageId);

    db.setMessageRead(mailbox.id, messageId, true);
    const msgState = db.getMessageState(mailbox.id, messageId);

    const htmlContent = Array.isArray(rawMsg.html) ? rawMsg.html.join('') : (rawMsg.html || '');
    const textContent = rawMsg.text || '';
    const subject = rawMsg.subject || '(Tanpa Subjek)';
    const intro = rawMsg.intro || '';

    const smartLinks = this.extractEmailLinks(htmlContent, textContent);
    const detectedOtp = this.detectGenericVerificationCode(subject, textContent, intro, htmlContent);

    return {
      id: String(rawMsg.id),
      from: {
        name: rawMsg.from?.name || (rawMsg.from?.address ? rawMsg.from.address.split('@')[0] : 'Pengirim'),
        address: rawMsg.from?.address || ''
      },
      to: (rawMsg.to || []).map(t => ({ name: t.name || '', address: t.address || '' })),
      subject,
      intro,
      createdAt: rawMsg.createdAt || new Date().toISOString(),
      html: htmlContent,
      text: textContent,
      hasAttachments: Boolean(rawMsg.hasAttachments),
      attachments: (rawMsg.attachments || []).map(att => ({
        id: att.id,
        filename: att.filename || 'attachment',
        contentType: att.contentType || 'application/octet-stream',
        size: att.size || 0,
        downloadUrl: att.downloadUrl ? `${this.baseUrl}${att.downloadUrl}` : null
      })),
      isRead: true,
      isStarred: Boolean(msgState.isStarred),
      smartLinks,
      detectedOtp
    };
  }

  // 13. Hapus email di Mail.tm dan local state
  async deleteMessage(mailbox, messageId) {
    if (!messageId) throw new Error('ID pesan tidak valid');
    db.setMessageDeleted(mailbox.id, messageId, true);

    try {
      const token = await this.ensureValidToken(mailbox);
      const safeId = encodeURIComponent(messageId);
      await this.fetchWithTimeout(`${this.baseUrl}/messages/${safeId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
    } catch (err) {
      console.warn(`[MailTmService] Gagal menghapus pesan ${messageId} dari Mail.tm:`, err.message);
    }

    return true;
  }

  // 14. Ekstraksi tautan/Smart Links dari konten email
  extractEmailLinks(html = '', text = '') {
    const links = [];
    const seenUrls = new Set();

    if (html) {
      const anchorRegex = /<a\s+(?:[^>]*?\s+)?href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;
      let match;
      while ((match = anchorRegex.exec(html)) !== null) {
        const rawUrl = match[1]?.trim();
        const anchorText = match[2]?.replace(/<[^>]+>/g, '').trim() || '';

        if (rawUrl && this.isValidActionUrl(rawUrl) && !seenUrls.has(rawUrl)) {
          seenUrls.add(rawUrl);
          links.push({
            url: rawUrl,
            text: anchorText || this.getSmartUrlLabel(anchorText, rawUrl),
            label: this.getSmartUrlLabel(anchorText, rawUrl),
            isPrimary: this.isPrimaryAction(anchorText, rawUrl)
          });
        }
      }
    }

    if (text) {
      const urlRegex = /(https?:\/\/[^\s<>"'()]+)/gi;
      let textMatch;
      while ((textMatch = urlRegex.exec(text)) !== null) {
        const rawUrl = textMatch[1]?.trim();
        if (rawUrl && this.isValidActionUrl(rawUrl) && !seenUrls.has(rawUrl)) {
          seenUrls.add(rawUrl);
          links.push({
            url: rawUrl,
            text: 'Buka Link',
            label: this.getSmartUrlLabel('', rawUrl),
            isPrimary: this.isPrimaryAction('', rawUrl)
          });
        }
      }
    }

    return links.sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0)).slice(0, 8);
  }

  isValidActionUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('javascript:')) return false;
    if (url.includes('unsubscribe') || url.includes('opt-out') || url.includes('privacy-policy')) return false;
    return url.startsWith('http://') || url.startsWith('https://');
  }

  isPrimaryAction(text = '', url = '') {
    const combined = `${text} ${url}`.toLowerCase();
    return /verif|confirm|sign\s*in|login|masuk|aktiv|activate|reset|auth|claim|lanjutkan/i.test(combined);
  }

  getSmartUrlLabel(anchorText = '', url = '') {
    const text = anchorText.trim();
    if (text && text.length > 2 && text.length < 50 && !text.startsWith('http')) {
      return text;
    }
    const lower = `${text} ${url}`.toLowerCase();
    if (/verify|verifikasi|confirm|konfirmasi/i.test(lower)) return 'Verifikasi Akun';
    if (/reset|password|sandi/i.test(lower)) return 'Atur Ulang Sandi';
    if (/login|masuk|signin|sign-in/i.test(lower)) return 'Masuk ke Akun';
    if (/activate|aktivasi/i.test(lower)) return 'Aktivasi Layanan';
    return 'Buka Tautan';
  }

  // 15. Deteksi Kode OTP & Kode Verifikasi Otomatis
  detectGenericVerificationCode(subject = '', text = '', intro = '', html = '') {
    const fullContent = `${subject}\n${intro}\n${text}\n${html.replace(/<[^>]+>/g, ' ')}`;

    // Pola 1: Konteks OTP/Kode Spesifik
    const contextPatterns = [
      /(?:kode\s+verifikasi|verification\s+code|otp\s+code|security\s+code|login\s+code|confirmation\s+code|kode\s+keamanan|kode\s+otp|pin\s+anda)[^\d\n\r:]{0,30}[:\s-]{1,5}([0-9]{4,8})/i,
      /(?:is|adalah|yaitu)\s+([0-9]{4,8})(?:\s+for|\s+untuk|\s*\.|\s*,|\s*$)/i,
      /(?:code|kode|otp)\s*#?\s*[:=]\s*([0-9]{4,8})/i,
      /<(?:b|strong|h[1-6]|span)[^>]*>\s*([0-9]{4,8})\s*<\/(?:b|strong|h[1-6]|span)>/i
    ];

    for (const pattern of contextPatterns) {
      const match = fullContent.match(pattern);
      if (match && match[1]) {
        const code = match[1].trim();
        if (this.isValidOtpCode(code)) {
          return { code, type: 'NUMERIC_OTP', confidence: 'HIGH' };
        }
      }
    }

    // Pola 2: Angka 4-8 digit berdiri sendiri pada baris terpisah
    const isolatedDigitMatch = fullContent.match(/(?:^|[\r\n\s])([0-9]{4,8})(?:[\r\n\s]|$)/);
    if (isolatedDigitMatch && isolatedDigitMatch[1]) {
      const candidate = isolatedDigitMatch[1].trim();
      if (this.isValidOtpCode(candidate)) {
        return { code: candidate, type: 'NUMERIC_OTP', confidence: 'MEDIUM' };
      }
    }

    return null;
  }

  isValidOtpCode(code) {
    if (!code || typeof code !== 'string') return false;
    if (code.length < 4 || code.length > 8) return false;
    const year = new Date().getFullYear();
    if (code === String(year) || code === String(year - 1) || code === String(year + 1)) return false;
    if (/^(.)\1+$/.test(code)) return false; // Abaikan 0000, 1111, 9999
    return true;
  }
}

const mailService = new MailTmService();

// ==============================================================================
// 5. PUTZPAY SERVICE LAYER (QRIS Donation Gateway)
// ==============================================================================
class PutzpayService {
  constructor() {
    this.baseUrl = config.PUTZPAY_BASE_URL;
    this.apiKey = config.PUTZPAY_API_KEY;
    this.timeout = config.REQUEST_TIMEOUT_MS;
  }

  getHeaders() {
    return {
      'x-apikey': this.apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  async createQris(amount) {
    const numAmount = parseInt(amount, 10);
    if (!numAmount || isNaN(numAmount) || numAmount < 1000) {
      throw new Error('Nominal minimal traktir adalah Rp 1.000');
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.baseUrl}/api/create/qris`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ amount: numAmount }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      const data = await response.json().catch(() => ({}));

      if (response.ok && data && (data.success || data.invoice_id)) {
        return {
          success: true,
          invoice_id: data.invoice_id || `ord_${Date.now()}`,
          amount: data.amount || numAmount,
          fee: data.fee !== undefined ? data.fee : 0,
          total: data.total || (numAmount + (data.fee || 0)),
          qris_image: data.qris_image || '',
          expired_at: data.expired_at || new Date(Date.now() + 15 * 60 * 1000).toISOString()
        };
      }

      // Fallback QRIS jika mode development atau API key placeholder
      if (this.apiKey === 'YOUR_API_KEY' || response.status === 401 || response.status === 403) {
        const mockInvoiceId = 'ord' + Math.random().toString(36).substring(2, 10);
        const fee = 250;
        const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=00020101021226590014ID.LINKAJA.WWW0118936009140000000000520458125303360540${numAmount + fee}5802ID5912TEMPEMAILNIH6007JAKARTA62070703A016304`;

        return {
          success: true,
          invoice_id: mockInvoiceId,
          amount: numAmount,
          fee: fee,
          total: numAmount + fee,
          qris_image: qrCodeUrl,
          expired_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          is_mock: true
        };
      }

      const errorMsg = data?.message || data?.error || `Gagal membuat QRIS (HTTP ${response.status})`;
      throw new Error(errorMsg);
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('Koneksi ke PutzPay timeout. Silakan coba beberapa saat lagi.');
      }
      throw err;
    }
  }

  async checkInvoiceStatus(invoiceId) {
    if (!invoiceId) throw new Error('Invoice ID diperlukan.');

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.baseUrl}/api/invoice/status`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ invoice_id: invoiceId }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      const data = await response.json().catch(() => ({}));

      if (response.ok && data) {
        return {
          success: true,
          invoice_id: data.invoice_id || invoiceId,
          amount: data.amount,
          fee: data.fee,
          total: data.total,
          status: (data.status || 'pending').toLowerCase(),
          qris_image: data.qris_image,
          expired_at: data.expired_at,
          created_at: data.created_at
        };
      }

      return { success: false, status: 'pending', message: data?.message || 'Gagal mengecek status invoice' };
    } catch (err) {
      return { success: false, status: 'pending', error: err.message };
    }
  }

  async cancelInvoice(invoiceId) {
    if (!invoiceId) throw new Error('Invoice ID diperlukan.');

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(`${this.baseUrl}/api/invoice/cancel`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ id: invoiceId }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      const data = await response.json().catch(() => ({}));
      return { success: true, message: data?.message || 'Invoice berhasil dibatalkan' };
    } catch (err) {
      return { success: true, message: 'Invoice ditandai batal' };
    }
  }
}

const putzpayService = new PutzpayService();

// ==============================================================================
// 6. EXPRESS APP SETUP & MIDDLEWARE
// ==============================================================================
const app = express();
const PORT = config.PORT || 3000;
const HOST = config.HOST || '0.0.0.0';

app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sajikan file statis dari folder public & assets
const publicPath = path.join(process.cwd(), 'public');
app.use(express.static(publicPath));

if (fs.existsSync(path.join(process.cwd(), 'assets'))) {
  app.use('/assets', express.static(path.join(process.cwd(), 'assets')));
}

// Anti-cache middleware untuk seluruh API endpoints
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  next();
});

// Helper: Ambil Mailbox dari Session Cookie Terenkripsi (Vercel Multi-Instance Recovery)
function getMailboxFromSessionCookie(req) {
  const sessionToken = req.cookies?.mb_session || req.headers['x-mailbox-session'];
  if (!sessionToken) return null;

  const sessionData = verifySessionToken(sessionToken);
  if (sessionData && sessionData.id && sessionData.email && sessionData.providerPassword) {
    return sessionData;
  }
  return null;
}

// Helper: Ambil Mailbox Aktif dari Request dengan Prioritas Ketat
function getMailboxFromRequest(req) {
  const headerId = req.headers['x-mailbox-id'];
  const cookieId = req.cookies?.mailbox_id;
  const queryId = req.query?.mailboxId;

  // 1. Tentukan ID yang diminta secara eksplisit
  const requestedId = headerId || cookieId || queryId;

  if (requestedId) {
    // Cari di database lokal
    const found = db.getMailbox(requestedId);
    if (found) return found;

    // Jika tidak ada di DB (misal cold instance Vercel), pulihkan dari session cookie terenkripsi
    const sessionMb = getMailboxFromSessionCookie(req);
    if (sessionMb && sessionMb.id === requestedId) {
      db.saveMailbox(sessionMb); // Simpan kembali ke memory DB container ini
      return sessionMb;
    }

    // Jika ID diminta secara eksplisit TETAPI tidak ditemukan sama sekali,
    // KEMBALIKAN NULL (Jangan sembarangan fallback ke mailbox lain!)
    return null;
  }

  // 2. Jika TIDAK ADA ID yang diminta sama sekali (first load tanpa parameter):
  // Coba ambil dari session cookie terenkripsi
  const sessionMb = getMailboxFromSessionCookie(req);
  if (sessionMb) {
    db.saveMailbox(sessionMb);
    return sessionMb;
  }

  // Fallback ke mailbox terakhir di DB jika memang ada data sebelumnya
  const all = db.getAllMailboxes();
  if (all.length > 0) {
    return db.getMailbox(all[all.length - 1].id);
  }

  return null;
}

// Helper: Set Cookie Mailbox ID dan Stateless Session
function setMailboxCookies(res, mailbox) {
  if (!mailbox || !mailbox.id) return;

  const isProd = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

  // Cookie 1: Mailbox ID publik (dapat dibaca oleh app.js)
  res.cookie('mailbox_id', mailbox.id, {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: false,
    secure: isProd,
    sameSite: 'lax',
    path: '/'
  });

  // Cookie 2: Stateless Encrypted Session (HttpOnly, aman untuk Vercel Serverless)
  const sessionToken = createSessionToken(mailbox);
  if (sessionToken) {
    res.cookie('mb_session', sessionToken, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/'
    });
  }
}

function sanitizeText(str = '', maxLength = 300) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>]/g, '').trim().slice(0, maxLength);
}

// ==============================================================================
// 7. API ROUTES
// ==============================================================================

// --- [A] MAILBOX & DOMAIN ENDPOINTS ---

// 1. Ambil domain aktif Mail.tm (/api/mailbox/domains & alias /api/domains)
async function handleGetDomains(req, res) {
  try {
    const domains = await mailService.getActiveDomains();
    res.json({ success: true, domains });
  } catch (err) {
    console.error('[API Domains Error]', err.message);
    res.status(500).json({ success: false, error: err.message || 'Gagal mengambil domain dari Mail.tm' });
  }
}
app.get('/api/mailbox/domains', handleGetDomains);
app.get('/api/domains', handleGetDomains);

// 2. Ambil mailbox saat ini (atau buat baru jika belum ada)
app.get('/api/mailbox/current', async (req, res) => {
  try {
    let mailbox = getMailboxFromRequest(req);

    // Jika mailbox belum ada atau sesi lama tidak ditemukan, buat mailbox baru
    if (!mailbox) {
      console.log('[API] Mailbox tidak ditemukan untuk request ini, membuat mailbox otomatis baru...');
      mailbox = await mailService.createAutoEmail();
    }

    setMailboxCookies(res, mailbox);

    res.json({
      success: true,
      mailbox: {
        id: mailbox.id,
        email: mailbox.email,
        createdAt: mailbox.createdAt
      }
    });
  } catch (err) {
    console.error('[API /api/mailbox/current Error]', err.message);
    res.status(500).json({ success: false, error: err.message || 'Gagal memuat mailbox' });
  }
});

// 3. Buat mailbox baru (Auto / Custom) (/api/mailbox/create & alias /api/create)
async function handleCreateMailbox(req, res) {
  try {
    const { type, username, domain } = req.body || {};
    let result;

    if (type === 'custom' && username) {
      result = await mailService.createCustomEmail(username, domain);
    } else {
      result = await mailService.createAutoEmail();
    }

    setMailboxCookies(res, result);

    res.json({
      success: true,
      mailbox: {
        id: result.id,
        email: result.email,
        createdAt: result.createdAt
      }
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || 'Gagal membuat email sementara' });
  }
}
app.post('/api/mailbox/create', handleCreateMailbox);
app.post('/api/create', handleCreateMailbox);

// 4. Ambil daftar semua mailbox
app.get('/api/mailbox/list', (req, res) => {
  try {
    const mailboxes = db.getAllMailboxes();
    res.json({ success: true, mailboxes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Ganti mailbox aktif
app.post('/api/mailbox/switch', (req, res) => {
  try {
    const { id } = req.body || {};
    let mailbox = db.getMailbox(id);

    if (!mailbox) {
      const sessionMb = getMailboxFromSessionCookie(req);
      if (sessionMb && sessionMb.id === id) {
        mailbox = sessionMb;
      }
    }

    if (!mailbox) {
      return res.status(404).json({ success: false, error: 'Mailbox tidak ditemukan.' });
    }

    setMailboxCookies(res, mailbox);

    res.json({
      success: true,
      mailbox: {
        id: mailbox.id,
        email: mailbox.email,
        createdAt: mailbox.createdAt
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Hapus mailbox
app.delete('/api/mailbox/:id', (req, res) => {
  try {
    const { id } = req.params;
    const deleted = db.deleteMailbox(id);

    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Mailbox tidak ditemukan' });
    }

    res.json({ success: true, message: 'Mailbox berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- [B] MESSAGES & INBOX ENDPOINTS ---

// 1. Ambil daftar email (dengan folder & search filter)
app.get('/api/messages', async (req, res) => {
  try {
    const mailbox = getMailboxFromRequest(req);
    if (!mailbox) {
      return res.status(401).json({
        success: false,
        error: 'REAUTH_REQUIRED',
        message: 'Mailbox belum tersedia atau sesi telah berakhir.'
      });
    }

    const { folder = 'inbox', search = '', page = 1 } = req.query;
    const data = await mailService.getNormalizedInbox(mailbox, { page: Number(page) || 1 });
    let messages = data.messages || [];

    if (folder === 'starred') {
      messages = messages.filter(m => m.isStarred);
    } else if (folder === 'recent') {
      messages = messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      messages = messages.filter(m => {
        const fromName = (m.from?.name || '').toLowerCase();
        const fromAddr = (m.from?.address || '').toLowerCase();
        const subject = (m.subject || '').toLowerCase();
        const intro = (m.intro || '').toLowerCase();
        const otp = (m.quickOtp || '').toLowerCase();

        return fromName.includes(q) ||
               fromAddr.includes(q) ||
               subject.includes(q) ||
               intro.includes(q) ||
               otp.includes(q);
      });
    }

    // Refresh cookie session jika token baru saja diperbarui
    setMailboxCookies(res, mailbox);

    res.json({
      success: true,
      messages,
      unreadCount: data.unreadCount,
      total: messages.length,
      currentFolder: folder
    });
  } catch (err) {
    if (err.message === 'REAUTH_REQUIRED') {
      return res.status(401).json({
        success: false,
        error: 'REAUTH_REQUIRED',
        message: 'Sesi akun email telah berakhir, silakan muat ulang atau pilih akun baru.'
      });
    }
    console.error('[API /api/messages Error]', err.message);
    res.status(500).json({ success: false, error: err.message || 'Gagal memuat pesan.' });
  }
});

// 2. Ambil detail satu email (dengan smart links & OTP)
app.get('/api/messages/:id', async (req, res) => {
  try {
    const mailbox = getMailboxFromRequest(req);
    if (!mailbox) {
      return res.status(401).json({ success: false, error: 'REAUTH_REQUIRED', message: 'Mailbox tidak valid' });
    }

    const { id } = req.params;
    const messageDetail = await mailService.getMessageDetailWithLinks(mailbox, id);

    setMailboxCookies(res, mailbox);

    res.json({
      success: true,
      message: messageDetail
    });
  } catch (err) {
    if (err.message === 'REAUTH_REQUIRED') {
      return res.status(401).json({ success: false, error: 'REAUTH_REQUIRED' });
    }
    res.status(500).json({ success: false, error: err.message || 'Gagal memuat detail email.' });
  }
});

// 3. Tandai sudah dibaca / belum dibaca
app.post('/api/messages/:id/read', (req, res) => {
  try {
    const mailbox = getMailboxFromRequest(req);
    if (!mailbox) {
      return res.status(401).json({ success: false, error: 'REAUTH_REQUIRED' });
    }

    const { id } = req.params;
    const { isRead = true } = req.body || {};
    const updated = db.setMessageRead(mailbox.id, id, Boolean(isRead));

    res.json({ success: true, state: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Beri bintang / hapus bintang
app.post('/api/messages/:id/star', (req, res) => {
  try {
    const mailbox = getMailboxFromRequest(req);
    if (!mailbox) {
      return res.status(401).json({ success: false, error: 'REAUTH_REQUIRED' });
    }

    const { id } = req.params;
    const { isStarred = true } = req.body || {};
    const updated = db.setMessageStarred(mailbox.id, id, Boolean(isStarred));

    res.json({ success: true, state: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Hapus email
app.delete('/api/messages/:id', async (req, res) => {
  try {
    const mailbox = getMailboxFromRequest(req);
    if (!mailbox) {
      return res.status(401).json({ success: false, error: 'REAUTH_REQUIRED' });
    }

    const { id } = req.params;
    await mailService.deleteMessage(mailbox, id);

    res.json({ success: true, message: 'Email berhasil dihapus.' });
  } catch (err) {
    if (err.message === 'REAUTH_REQUIRED') {
      return res.status(401).json({ success: false, error: 'REAUTH_REQUIRED' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Quick Refresh Inbox Endpoint
app.post('/api/refresh', async (req, res) => {
  try {
    const mailbox = getMailboxFromRequest(req);
    if (!mailbox) {
      return res.status(401).json({ success: false, error: 'REAUTH_REQUIRED', message: 'Mailbox belum tersedia.' });
    }
    const inboxData = await mailService.getNormalizedInbox(mailbox);
    setMailboxCookies(res, mailbox);
    res.json({ success: true, ...inboxData });
  } catch (err) {
    if (err.message === 'REAUTH_REQUIRED') {
      return res.status(401).json({ success: false, error: 'REAUTH_REQUIRED' });
    }
    res.status(500).json({ success: false, error: err.message || 'Gagal merefresh email' });
  }
});

// --- [C] DONATION & TRAKTIR SERVER (PutzPay QRIS) ENDPOINTS ---

// 1. Buat invoice donasi
app.post('/api/donation/create', async (req, res) => {
  try {
    const { amount, display_name, message, is_anonymous } = req.body || {};

    const numAmount = parseInt(amount, 10);
    if (!numAmount || isNaN(numAmount) || numAmount < 1000) {
      return res.status(400).json({
        success: false,
        error: 'Nominal traktir minimal Rp 1.000'
      });
    }

    if (numAmount > 10000000) {
      return res.status(400).json({
        success: false,
        error: 'Nominal maksimal adalah Rp 10.000.000'
      });
    }

    let cleanName = is_anonymous ? 'Anonymous' : sanitizeText(display_name, 50);
    if (!cleanName || cleanName.length === 0) cleanName = 'Anonymous';
    const cleanMessage = sanitizeText(message, 300);

    const qrisData = await putzpayService.createQris(numAmount);

    const donationRecord = db.saveDonation({
      invoice_id: qrisData.invoice_id,
      display_name: cleanName,
      message: cleanMessage,
      amount: qrisData.amount,
      fee: qrisData.fee,
      total: qrisData.total,
      status: 'pending',
      qris_image: qrisData.qris_image,
      expired_at: qrisData.expired_at,
      created_at: new Date().toISOString()
    });

    res.json({
      success: true,
      invoice_id: donationRecord.invoice_id,
      amount: donationRecord.amount,
      fee: donationRecord.fee,
      total: donationRecord.total,
      qris_image: donationRecord.qris_image,
      expired_at: donationRecord.expired_at
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Gagal membuat tagihan QRIS' });
  }
});

// 2. Cek status invoice donasi
app.get('/api/donation/status/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const donation = db.getDonation(invoiceId);

    if (!donation) {
      return res.status(404).json({ success: false, error: 'Invoice tidak ditemukan' });
    }

    // Jika sudah status final (paid / cancelled), langsung kembalikan
    if (donation.status === 'paid' || donation.status === 'cancelled') {
      return res.json({
        success: true,
        invoice_id: donation.invoice_id,
        status: donation.status,
        amount: donation.amount,
        total: donation.total,
        paid_at: donation.paid_at
      });
    }

    // Cek ke gateway PutzPay
    const gatewayStatus = await putzpayService.checkInvoiceStatus(invoiceId);

    if (gatewayStatus.success && gatewayStatus.status) {
      const newStatus = gatewayStatus.status.toLowerCase();
      if (newStatus !== donation.status) {
        const paidAt = newStatus === 'paid' ? new Date().toISOString() : null;
        db.updateDonationStatus(invoiceId, newStatus, paidAt);
        donation.status = newStatus;
        if (paidAt) donation.paid_at = paidAt;
      }
    }

    res.json({
      success: true,
      invoice_id: donation.invoice_id,
      status: donation.status,
      amount: donation.amount,
      total: donation.total,
      paid_at: donation.paid_at
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Gagal mengecek status donasi' });
  }
});

// 3. Batalkan invoice donasi
app.post('/api/donation/cancel/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const donation = db.getDonation(invoiceId);

    if (!donation) {
      return res.status(404).json({ success: false, error: 'Invoice tidak ditemukan' });
    }

    if (donation.status === 'paid') {
      return res.status(400).json({ success: false, error: 'Invoice yang sudah dibayar tidak dapat dibatalkan' });
    }

    await putzpayService.cancelInvoice(invoiceId);
    db.updateDonationStatus(invoiceId, 'cancelled');

    res.json({ success: true, message: 'Invoice berhasil dibatalkan' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Ambil daftar donasi terbaru
app.get('/api/donation/recent', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 10;
    const donations = db.getRecentDonations(Math.min(limit, 50));
    res.json({ success: true, donations });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- [D] HEALTH CHECK & UTILITY ENDPOINTS ---
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: config.APP_NAME,
    version: config.VERSION,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: process.env.VERCEL ? 'vercel-serverless' : 'standalone-node'
  });
});

// --- [E] STATIC ROUTE FALLBACKS ---
// Rute khusus halaman /traktir
app.get('/traktir', (req, res) => {
  const traktirFile = path.join(publicPath, 'traktir.html');
  if (fs.existsSync(traktirFile)) {
    return res.sendFile(traktirFile);
  }
  res.redirect('/');
});

// Fallback SPA ke public/index.html atau public/app.html
app.get('*', (req, res) => {
  const indexHtml = path.join(publicPath, 'index.html');
  const appHtml = path.join(publicPath, 'app.html');

  if (fs.existsSync(indexHtml)) {
    return res.sendFile(indexHtml);
  }
  if (fs.existsSync(appHtml)) {
    return res.sendFile(appHtml);
  }
  res.status(404).send('Halaman tidak ditemukan');
});

// ==============================================================================
// 8. SERVER BOOTSTRAP (Vercel Export & Standalone Listen)
// ==============================================================================

// Jalankan standalone server jika bukan di lingkungan Vercel Serverless
if (!process.env.VERCEL) {
  app.listen(PORT, HOST, () => {
    console.log(`=======================================================`);
    console.log(`🚀 ${config.APP_NAME} v${config.VERSION} berjalan di: http://${HOST}:${PORT}`);
    console.log(`📦 Mail.tm Base URL: ${config.MAILTM_BASE_URL}`);
    console.log(`💾 Database Path: ${config.DB_FILE_PATH}`);
    console.log(`=======================================================`);
  });
}

// Export default app untuk Vercel Serverless Function
export default app;
