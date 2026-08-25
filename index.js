// ==============================================================================
// index.js — Backend Utama TempWeb / TempEmailNih
// Menggabungkan seluruh logic Database, Mail.tm API, Gateway, dan Express Server
// Kompatibel 100% untuk Vercel Serverless dan VPS / Local Standalone
// ==============================================================================

import express from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import cookieParser from 'cookie-parser';

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
  PUTZPAY_BASE_URL: process.env.PUTZPAY_BASE_URL || 'https://putzpay.biz.id',
  PUTZPAY_API_KEY: process.env.PUTZPAY_API_KEY || 'YOUR_API_KEY',
  APP_NAME: 'TempEmailNih',
  APP_DESCRIPTION: 'Layanan Temporary Email bergaya Gmail dengan Mail.tm API',
  VERSION: '1.0.0'
};

// ==============================================================================
// 2. STORAGE & DATABASE LAYER (JSON File + In-Memory Fallback)
// ==============================================================================
class Database {
  constructor() {
    this.dbPath = path.resolve(config.DB_FILE_PATH);
    this.dirPath = path.dirname(this.dbPath);
    this.locks = new Set();
    this.memoryCache = null;
    this.init();
  }

  init() {
    try {
      if (!fs.existsSync(this.dirPath)) {
        fs.mkdirSync(this.dirPath, { recursive: true });
      }

      if (!fs.existsSync(this.dbPath)) {
        // Coba seed dari database/tempemail.json jika ada
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
      // Fallback ke memory cache
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

  acquireLock(key) {
    if (this.locks.has(key)) return false;
    this.locks.add(key);
    return true;
  }

  releaseLock(key) {
    this.locks.delete(key);
  }

  // --- Operasi Mailbox ---
  saveMailbox(mailbox) {
    const data = this.readData();
    const now = new Date().toISOString();
    if (!data.mailboxes) data.mailboxes = {};

    data.mailboxes[mailbox.id] = {
      id: mailbox.id,
      email: mailbox.email,
      providerAccountId: mailbox.providerAccountId || mailbox.id,
      providerPassword: mailbox.providerPassword,
      providerToken: mailbox.providerToken,
      providerStatus: mailbox.providerStatus || 'active',
      createdAt: mailbox.createdAt || now,
      updatedAt: now
    };

    this.writeData(data);
    return data.mailboxes[mailbox.id];
  }

  getMailbox(id) {
    if (!id) return null;
    const data = this.readData();
    return data.mailboxes ? data.mailboxes[id] || null : null;
  }

  getMailboxByEmail(email) {
    if (!email) return null;
    const data = this.readData();
    if (!data.mailboxes) return null;
    const lower = email.toLowerCase();
    for (const key in data.mailboxes) {
      if (data.mailboxes[key].email && data.mailboxes[key].email.toLowerCase() === lower) {
        return data.mailboxes[key];
      }
    }
    return null;
  }

  getAllMailboxes() {
    const data = this.readData();
    if (!data.mailboxes) return [];
    return Object.values(data.mailboxes).map(m => ({
      id: m.id,
      email: m.email,
      providerStatus: m.providerStatus,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt
    }));
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

  deleteMailbox(id) {
    const data = this.readData();
    if (data.mailboxes && data.mailboxes[id]) {
      delete data.mailboxes[id];
      if (data.messageStates) {
        for (const key in data.messageStates) {
          if (data.messageStates[key].mailboxId === id) {
            delete data.messageStates[key];
          }
        }
      }
      this.writeData(data);
      return true;
    }
    return false;
  }

  // --- Operasi Status Pesan (Read, Star, Delete) ---
  getMessageState(mailboxId, messageId) {
    if (!mailboxId || !messageId) return { isRead: false, isStarred: false, isDeleted: false };
    const data = this.readData();
    const key = `${mailboxId}:${messageId}`;
    return (data.messageStates && data.messageStates[key]) || {
      mailboxId,
      messageId,
      isRead: false,
      isStarred: false,
      isDeleted: false
    };
  }

  setMessageRead(mailboxId, messageId, isRead = true) {
    const data = this.readData();
    if (!data.messageStates) data.messageStates = {};
    const key = `${mailboxId}:${messageId}`;
    data.messageStates[key] = {
      ...(data.messageStates[key] || {}),
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
    const key = `${mailboxId}:${messageId}`;
    data.messageStates[key] = {
      ...(data.messageStates[key] || {}),
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
    const key = `${mailboxId}:${messageId}`;
    data.messageStates[key] = {
      ...(data.messageStates[key] || {}),
      mailboxId,
      messageId,
      isDeleted: Boolean(isDeleted),
      updatedAt: new Date().toISOString()
    };
    this.writeData(data);
    return data.messageStates[key];
  }

  // --- Operasi Donasi / Traktir Server ---
  saveDonation(donation) {
    const data = this.readData();
    if (!data.donations) data.donations = {};
    const now = new Date().toISOString();

    const record = {
      id: donation.id || donation.invoice_id,
      invoice_id: donation.invoice_id,
      display_name: donation.display_name || 'Anonymous',
      message: donation.message || '',
      amount: Number(donation.amount),
      fee: Number(donation.fee || 0),
      total: Number(donation.total || donation.amount),
      status: donation.status || 'pending',
      qris_image: donation.qris_image || '',
      expired_at: donation.expired_at || null,
      created_at: donation.created_at || now,
      paid_at: donation.paid_at || null,
      updated_at: now
    };

    data.donations[donation.invoice_id] = record;
    this.writeData(data);
    return record;
  }

  getDonation(invoiceId) {
    if (!invoiceId) return null;
    const data = this.readData();
    return data.donations ? data.donations[invoiceId] || null : null;
  }

  updateDonationStatus(invoiceId, status, paidAt = null) {
    if (!invoiceId) return null;
    const data = this.readData();
    if (data.donations && data.donations[invoiceId]) {
      data.donations[invoiceId].status = status;
      if (status === 'paid') {
        data.donations[invoiceId].paid_at = paidAt || new Date().toISOString();
      }
      data.donations[invoiceId].updated_at = new Date().toISOString();
      this.writeData(data);
      return data.donations[invoiceId];
    }
    return null;
  }

  getPublicDonations(limit = 50) {
    const data = this.readData();
    if (!data.donations) return [];

    return Object.values(data.donations)
      .filter(d => d.status === 'paid')
      .sort((a, b) => {
        const timeA = new Date(a.paid_at || a.created_at).getTime();
        const timeB = new Date(b.paid_at || b.created_at).getTime();
        return timeB - timeA;
      })
      .slice(0, limit)
      .map(d => ({
        display_name: d.display_name,
        message: d.message,
        amount: d.amount,
        paid_at: d.paid_at || d.created_at,
        created_at: d.created_at
      }));
  }
}

const db = new Database();

// ==============================================================================
// 3. MAIL.TM SERVICE ENGINE & REQUEST HELPER
// ==============================================================================
let cachedDomains = [];
let lastDomainsFetchTime = 0;

class MailService {
  constructor() {
    this.baseUrl = config.MAILTM_BASE_URL;
  }

  // Request helper internal dengan timeout & error handling
  async fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...(options.headers || {})
        }
      });
      clearTimeout(timeoutId);
      return response;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error('Server email sedang lambat. Silakan coba lagi.');
      }
      throw new Error(`Koneksi Mail.tm gagal: ${err.message}`);
    }
  }

  // 1. Ambil domain aktif Mail.tm (dengan fallback caching untuk cegah error 500)
  async getActiveDomains() {
  const CACHE_TIME = 10 * 60 * 1000;
  const MAX_RETRIES = 3;

  // Gunakan cache jika masih valid
  if (
    cachedDomains.length > 0 &&
    Date.now() - lastDomainsFetchTime < CACHE_TIME
  ) {
    return cachedDomains;
  }

  const urls = [
    `${this.baseUrl}/domains?page=1`,
    `${this.baseUrl}/domains`
  ];

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    for (const url of urls) {
      try {
        console.log(
          `[MailService] Mengambil domain Mail.tm (percobaan ${attempt}/${MAX_RETRIES}): ${url}`
        );

        const res = await this.fetchWithTimeout(url);

        const text = await res.text();

        let data = {};

        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          data = {};
        }

        if (!res.ok) {
          lastError = new Error(
            `Mail.tm mengembalikan HTTP ${res.status}`
          );

          console.warn(
            `[MailService] Domain request gagal: HTTP ${res.status}`
          );

          continue;
        }

        const members =
          Array.isArray(data?.['hydra:member'])
            ? data['hydra:member']
            : Array.isArray(data?.member)
              ? data.member
              : Array.isArray(data)
                ? data
                : [];

        const domains = members
          .filter(domain => {
            return (
              domain &&
              typeof domain.domain === 'string' &&
              domain.domain.trim() &&
              domain.isActive !== false
            );
          })
          .map(domain =>
            domain.domain
              .trim()
              .toLowerCase()
          )
          .filter(Boolean);

        const uniqueDomains = [
          ...new Set(domains)
        ];

        if (uniqueDomains.length > 0) {
          cachedDomains = uniqueDomains;
          lastDomainsFetchTime = Date.now();

          console.log(
            '[MailService] ✅ Active domains:',
            cachedDomains
          );

          return cachedDomains;
        }

        lastError = new Error(
          'Mail.tm tidak mengembalikan domain aktif.'
        );

      } catch (err) {
        lastError = err;

        console.error(
          `[MailService] Domain request error (attempt ${attempt}):`,
          err.message
        );
      }
    }

    // Kalau belum berhasil, tunggu sebelum retry berikutnya
    if (attempt < MAX_RETRIES) {
      const delay = attempt * 1500;

      console.log(
        `[MailService] Menunggu ${delay}ms sebelum retry...`
      );

      await new Promise(resolve =>
        setTimeout(resolve, delay)
      );
    }
  }

  // Kalau cache lama masih tersedia, gunakan cache tersebut
  if (cachedDomains.length > 0) {
    console.warn(
      '[MailService] ⚠️ Mail.tm gagal, menggunakan cached domains:',
      cachedDomains
    );

    return cachedDomains;
  }

  throw new Error(
    `Mail.tm sedang tidak dapat menyediakan domain. ${
      lastError?.message || 'Silakan coba lagi beberapa saat.'
    }`
  );
}

  generateRandomString(length = 10, alphanumericOnly = true) {
    const chars = alphanumericOnly
      ? 'abcdefghijklmnopqrstuvwxyz0123456789'
      : 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  // 2. Buat email otomatis
  async createAutoEmail() {
    const domains = await this.getActiveDomains();
    const domain = domains[Math.floor(Math.random() * domains.length)];
    const username = `nih_${this.generateRandomString(8)}`;
    const address = `${username}@${domain}`;
    const password = `Tmp_${this.generateRandomString(12, false)}!`;

    return await this.createAccountAndLogin(address, password);
  }

  // 3. Buat email kustom
  async createCustomEmail(customUsername, customDomain) {
    const domains = await this.getActiveDomains();
    const domain = customDomain && domains.includes(customDomain) ? customDomain : domains[0];

    const cleanUsername = (customUsername || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9._-]/g, '')
      .slice(0, 30);

    if (!cleanUsername || cleanUsername.length < 3) {
      throw new Error('Username minimal 3 karakter (hanya huruf, angka, titik, minus).');
    }

    const address = `${cleanUsername}@${domain}`;
    const password = `Tmp_${this.generateRandomString(12, false)}!`;

    return await this.createAccountAndLogin(address, password);
  }

  // 4. Daftarkan akun & peroleh token
  async createAccountAndLogin(address, password) {
  const lockKey = `create_${address}`;

  if (!db.acquireLock(lockKey)) {
    throw new Error(
      'Permintaan pembuatan akun sedang diproses.'
    );
  }

  try {
    console.log(
      '[MailService] Creating account:',
      address
    );

    const registerRes = await this.fetchWithTimeout(
      `${this.baseUrl}/accounts`,
      {
        method: 'POST',
        body: JSON.stringify({
          address,
          password
        })
      }
    );

    const responseText = await registerRes.text();

    let errJson = {};

    try {
      errJson = responseText
        ? JSON.parse(responseText)
        : {};
    } catch {
      errJson = {};
    }

    if (!registerRes.ok && registerRes.status !== 422) {
      console.error(
        '[MailService] Account creation failed:',
        registerRes.status,
        responseText
      );

      throw new Error(
        errJson.message ||
        errJson['hydra:description'] ||
        `Gagal mendaftarkan email (${registerRes.status})`
      );
    }

    if (registerRes.status === 422) {
      console.error(
        '[MailService] Mail.tm rejected address:',
        responseText
      );

      throw new Error(
        errJson.message ||
        errJson['hydra:description'] ||
        'Domain atau alamat email ditolak oleh Mail.tm.'
      );
    }

    const accountData = errJson;

    if (!accountData.id) {
      throw new Error(
        'Mail.tm tidak mengembalikan ID akun.'
      );
    }

    const accountId = accountData.id;

    const token = await this.obtainToken(
      address,
      password
    );

    const meInfo = await this.verifyTokenWithMe(token);

    const mailboxRecord = db.saveMailbox({
      id: accountId,
      email: address,
      providerAccountId: accountId,
      providerPassword: password,
      providerToken: token,
      providerStatus: 'active'
    });

    return {
      id: mailboxRecord.id,
      email: mailboxRecord.email,
      createdAt: mailboxRecord.createdAt,
      quota: meInfo.quota || 0,
      used: meInfo.used || 0
    };

  } finally {
    db.releaseLock(lockKey);
  }
}

  // 5. POST /token untuk autentikasi
  async obtainToken(address, password) {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/token`, {
      method: 'POST',
      body: JSON.stringify({ address, password })
    });

    if (!res.ok) {
      throw new Error(`Autentikasi gagal (status ${res.status})`);
    }

    const data = await res.json();
    if (!data.token) {
      throw new Error('Token tidak ditemukan dalam respon otentikasi.');
    }
    return data.token;
  }

  // 6. Validasi token dengan GET /me
  async verifyTokenWithMe(token) {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/me`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!res.ok) {
      throw new Error('Token tidak valid atau telah kedaluwarsa.');
    }

    return await res.json();
  }

  // 7. Refresh token otomatis
  async refreshToken(mailbox) {
    if (!mailbox || !mailbox.providerPassword) {
      throw new Error('REAUTH_REQUIRED');
    }

    try {
      const newToken = await this.obtainToken(mailbox.email, mailbox.providerPassword);
      db.updateMailboxToken(mailbox.id, newToken, 'active');
      return newToken;
    } catch (err) {
      db.updateMailboxToken(mailbox.id, null, 'expired');
      throw new Error('REAUTH_REQUIRED');
    }
  }

  // 8. Pastikan token aktif sebelum memanggil API
  async ensureValidToken(mailbox) {
    if (!mailbox) throw new Error('Mailbox tidak ditemukan');

    if (mailbox.providerToken) {
      try {
        await this.verifyTokenWithMe(mailbox.providerToken);
        return mailbox.providerToken;
      } catch (err) {
        // Token expired, lanjut refresh
      }
    }

    return await this.refreshToken(mailbox);
  }

  // 9. Ambil inbox pesan
  async getNormalizedInbox(mailbox, { page = 1 } = {}) {
    const token = await this.ensureValidToken(mailbox);

    const res = await this.fetchWithTimeout(`${this.baseUrl}/messages?page=${page}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!res.ok) {
      if (res.status === 401) {
        const freshToken = await this.refreshToken(mailbox);
        const retryRes = await this.fetchWithTimeout(`${this.baseUrl}/messages?page=${page}`, {
          headers: { 'Authorization': `Bearer ${freshToken}` }
        });
        if (!retryRes.ok) throw new Error('Gagal memuat kotak masuk.');
        return this.processMessagesList(await retryRes.json(), mailbox.id);
      }
      throw new Error('Gagal mengambil daftar email dari server.');
    }

    const data = await res.json();
    return this.processMessagesList(data, mailbox.id);
  }

  processMessagesList(data, mailboxId) {
    const rawList = data['hydra:member'] || data.member || data || [];
    const totalCount = data['hydra:totalItems'] || rawList.length;

    const messages = rawList.map(msg => {
      const msgState = db.getMessageState(mailboxId, msg.id);
      const quickOtp = this.detectGenericVerificationCode(msg.subject || '', msg.intro || '');

      return {
        id: String(msg.id),
        from: {
          name: msg.from?.name || (msg.from?.address ? msg.from.address.split('@')[0] : 'Tidak Dikenal'),
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

  // 10. Ambil detail email tunggal
  async getMessageDetail(mailbox, messageId) {
    if (!messageId) throw new Error('ID pesan tidak valid');
    const token = await this.ensureValidToken(mailbox);
    const safeId = encodeURIComponent(messageId);

    const res = await this.fetchWithTimeout(`${this.baseUrl}/messages/${safeId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!res.ok) {
      if (res.status === 404) throw new Error('Email tidak ditemukan atau sudah dihapus.');
      throw new Error('Gagal mengambil isi email.');
    }

    return await res.json();
  }

  // 11. Ambil detail dengan deteksi Smart Links & OTP
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

  // 12. Ekstraksi link email cerdas
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
    if (/verif/i.test(lower)) return 'Verifikasi Akun';
    if (/confirm/i.test(lower)) return 'Konfirmasi Email';
    if (/sign\s*in|login|masuk/i.test(lower)) return 'Login / Masuk';
    if (/reset.*pass|password/i.test(lower)) return 'Reset Password';
    if (/activat|aktivasi/i.test(lower)) return 'Aktivasi Layanan';
    if (/claim|klaim/i.test(lower)) return 'Klaim Hadiah / Bonus';
    if (/download|unduh/i.test(lower)) return 'Unduh Berkas';
    if (/accept|terima/i.test(lower)) return 'Terima Undangan';
    return 'Buka Link';
  }

  // 13. Deteksi OTP cerdas
  detectGenericVerificationCode(subject = '', text = '', intro = '', html = '') {
    const fullText = `${subject}\n${intro}\n${text}\n${html ? html.replace(/<[^>]+>/g, ' ') : ''}`;
    const contextKeywords = [
      'otp', 'code', 'kode', 'verification', 'verifikasi', 'verify',
      'security code', 'passcode', 'pin', 'login', 'sign in', 'confirmation',
      'konfirmasi', 'auth', 'two-factor', '2fa', 'authenticator'
    ];

    const lowerText = fullText.toLowerCase();
    const hasContext = contextKeywords.some(kw => lowerText.includes(kw));
    if (!hasContext) return null;

    const explicitPatterns = [
      /(?:kode|code|otp|pin|passcode|verifikasi|verification)[\s:=—\-–is]*([0-9]{4,8})/i,
      /(?:kode|code|otp|pin|passcode|verifikasi|verification)[\s:=—\-–is]*([0-9]{3}[-\s][0-9]{3})/i,
      /(?:kode|code|otp|pin|passcode|verifikasi|verification)[\s:=—\-–is]*([0-9]{4}[-\s][0-9]{4})/i,
      /\b([0-9]{4,8})\b(?=[\s,.]*(?:adalah|is your|is the|merupakan|untuk|to verify|to confirm))/i
    ];

    for (const pattern of explicitPatterns) {
      const match = fullText.match(pattern);
      if (match && match[1]) {
        const candidate = match[1].trim();
        if (this.isValidOtpCode(candidate)) {
          return candidate;
        }
      }
    }

    const lines = fullText.split(/[\r\n]+/);
    for (const line of lines) {
      const lineLower = line.toLowerCase();
      if (contextKeywords.some(kw => lineLower.includes(kw))) {
        const digitMatches = line.match(/\b([0-9]{4,8}|[0-9]{3}[-\s][0-9]{3})\b/g);
        if (digitMatches) {
          for (const match of digitMatches) {
            if (this.isValidOtpCode(match)) {
              return match.trim();
            }
          }
        }
      }
    }

    return null;
  }

  isValidOtpCode(code) {
    if (!code) return false;
    const cleanDigits = code.replace(/[-\s]/g, '');
    if (!/^\d{4,8}$/.test(cleanDigits)) return false;

    const num = parseInt(cleanDigits, 10);
    if (cleanDigits.length === 4 && num >= 2020 && num <= 2035) return false;
    if (/^(\d)\1+$/.test(cleanDigits) && cleanDigits.length >= 6) return false;
    if ([3000, 8080, 8000, 5000, 4000, 8443].includes(num)) return false;

    return true;
  }

  // 14. Hapus pesan
  async deleteMessage(mailbox, messageId) {
    if (!messageId) throw new Error('ID pesan tidak valid');
    const token = await this.ensureValidToken(mailbox);
    const safeId = encodeURIComponent(messageId);

    try {
      await this.fetchWithTimeout(`${this.baseUrl}/messages/${safeId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
    } catch (err) {
      console.warn('[MailService] Delete remote message notice:', err.message);
    }

    db.setMessageDeleted(mailbox.id, messageId, true);
    return true;
  }
}

const mailService = new MailService();

// ==============================================================================
// 4. PUTZPAY SERVICE (Donasi & Traktir Server QRIS)
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
      throw new Error('Nominal minimal adalah Rp 1.000');
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
      const data = await response.json();

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

      // Fallback QRIS jika mode development atau API Key belum diset
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

      const errorMsg = data?.message || data?.error || `Gagal membuat QRIS (Status: ${response.status})`;
      throw new Error(errorMsg);
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('Koneksi ke PutzPay timeout. Silakan coba kembali.');
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
      const data = await response.json();

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

      return { success: false, status: 'pending', message: data?.message || 'Gagal mengecek status' };
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
      const data = await response.json();
      return { success: true, message: data?.message || 'Invoice berhasil dibatalkan' };
    } catch (err) {
      return { success: true, message: 'Invoice ditandai batal' };
    }
  }
}

const putzpayService = new PutzpayService();

// ==============================================================================
// 5. EXPRESS APP SETUP & MIDDLEWARE
// ==============================================================================
const app = express();
const PORT = config.PORT || 3000;
const HOST = '0.0.0.0';

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

// Anti-cache middleware untuk semua endpoint /api/
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  next();
});

// Helper untuk mendapatkan mailbox aktif dari request (Header, Cookie, Query, atau DB)
function getMailboxFromRequest(req) {
  const mailboxId = req.headers['x-mailbox-id'] || req.cookies?.mailbox_id || req.query.mailboxId;
  if (mailboxId) {
    const found = db.getMailbox(mailboxId);
    if (found) return found;
  }

  const all = db.getAllMailboxes();
  if (all.length > 0) {
    return db.getMailbox(all[all.length - 1].id);
  }

  return null;
}

function sanitizeText(str = '', maxLength = 300) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>]/g, '').trim().slice(0, maxLength);
}

// ==============================================================================
// 6. API ROUTES
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
    if (!mailbox) {
      mailbox = await mailService.createAutoEmail();
    }

    res.cookie('mailbox_id', mailbox.id, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: false,
      sameSite: 'lax'
    });

    res.json({
      success: true,
      mailbox: {
        id: mailbox.id,
        email: mailbox.email,
        createdAt: mailbox.createdAt
      }
    });
  } catch (err) {
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

    res.cookie('mailbox_id', result.id, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: false,
      sameSite: 'lax'
    });

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
    const mailbox = db.getMailbox(id);

    if (!mailbox) {
      return res.status(404).json({ success: false, error: 'Mailbox tidak ditemukan.' });
    }

    res.cookie('mailbox_id', mailbox.id, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: false,
      sameSite: 'lax'
    });

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
      return res.status(404).json({ success: false, error: 'Mailbox belum tersedia' });
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

    res.json({
      success: true,
      messages,
      unreadCount: data.unreadCount,
      total: messages.length,
      currentFolder: folder
    });
  } catch (err) {
    if (err.message === 'REAUTH_REQUIRED') {
      return res.status(401).json({ success: false, error: 'REAUTH_REQUIRED' });
    }
    res.status(500).json({ success: false, error: err.message || 'Gagal memuat pesan.' });
  }
});

// 2. Ambil detail satu email (dengan smart links & OTP)
app.get('/api/messages/:id', async (req, res) => {
  try {
    const mailbox = getMailboxFromRequest(req);
    if (!mailbox) {
      return res.status(404).json({ success: false, error: 'Mailbox belum tersedia' });
    }

    const { id } = req.params;
    const messageDetail = await mailService.getMessageDetailWithLinks(mailbox, id);

    res.json({
      success: true,
      message: messageDetail
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Gagal memuat detail email.' });
  }
});

// 3. Tandai sudah dibaca / belum dibaca
app.post('/api/messages/:id/read', (req, res) => {
  try {
    const mailbox = getMailboxFromRequest(req);
    if (!mailbox) {
      return res.status(404).json({ success: false, error: 'Mailbox tidak valid' });
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
      return res.status(404).json({ success: false, error: 'Mailbox tidak valid' });
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
      return res.status(404).json({ success: false, error: 'Mailbox tidak valid' });
    }

    const { id } = req.params;
    await mailService.deleteMessage(mailbox, id);

    res.json({ success: true, message: 'Email berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Quick Refresh Inbox Endpoint
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
      display_name: donationRecord.display_name,
      message: donationRecord.message,
      amount: donationRecord.amount,
      fee: donationRecord.fee,
      total: donationRecord.total,
      status: donationRecord.status,
      qris_image: donationRecord.qris_image,
      expired_at: donationRecord.expired_at,
      created_at: donationRecord.created_at,
      is_mock: qrisData.is_mock || false
    });
  } catch (err) {
    console.error('[Donation Create Error]', err.message);
    res.status(500).json({
      success: false,
      error: err.message || 'Gagal memproses pembuatan QRIS traktir.'
    });
  }
});

// 2. Cek status donasi
app.post('/api/donation/status', async (req, res) => {
  try {
    const { invoice_id } = req.body || {};
    if (!invoice_id) {
      return res.status(400).json({ success: false, error: 'Parameter invoice_id wajib diisi.' });
    }

    let donation = db.getDonation(invoice_id);
    if (!donation) {
      return res.status(404).json({ success: false, error: 'Invoice donasi tidak ditemukan.' });
    }

    if (donation.status === 'paid') {
      return res.json({
        success: true,
        invoice_id: donation.invoice_id,
        status: 'paid',
        amount: donation.amount,
        fee: donation.fee,
        total: donation.total,
        display_name: donation.display_name,
        message: donation.message,
        paid_at: donation.paid_at
      });
    }

    const gatewayStatus = await putzpayService.checkInvoiceStatus(invoice_id);
    if (gatewayStatus && gatewayStatus.status) {
      const normalizedStatus = gatewayStatus.status.toLowerCase();
      if (['paid', 'success', 'settled'].includes(normalizedStatus)) {
        donation = db.updateDonationStatus(invoice_id, 'paid');
      } else if (normalizedStatus === 'expired') {
        donation = db.updateDonationStatus(invoice_id, 'expired');
      } else if (['cancelled', 'canceled'].includes(normalizedStatus)) {
        donation = db.updateDonationStatus(invoice_id, 'cancelled');
      }
    }

    res.json({
      success: true,
      invoice_id: donation.invoice_id,
      status: donation.status,
      amount: donation.amount,
      fee: donation.fee,
      total: donation.total,
      display_name: donation.display_name,
      message: donation.message,
      paid_at: donation.paid_at
    });
  } catch (err) {
    console.error('[Donation Status Error]', err.message);
    res.status(500).json({ success: false, error: err.message || 'Gagal mengecek status pembayaran.' });
  }
});

// 3. Batalkan donasi
app.post('/api/donation/cancel', async (req, res) => {
  try {
    const { invoice_id } = req.body || {};
    if (!invoice_id) {
      return res.status(400).json({ success: false, error: 'Parameter invoice_id wajib diisi.' });
    }

    const donation = db.getDonation(invoice_id);
    if (!donation) {
      return res.status(404).json({ success: false, error: 'Invoice donasi tidak ditemukan.' });
    }

    if (donation.status === 'paid') {
      return res.status(400).json({ success: false, error: 'Pembayaran yang sudah berhasil tidak dapat dibatalkan.' });
    }

    await putzpayService.cancelInvoice(invoice_id);
    const updated = db.updateDonationStatus(invoice_id, 'cancelled');

    res.json({
      success: true,
      message: 'Pembayaran donasi berhasil dibatalkan.',
      invoice_id: updated.invoice_id,
      status: 'cancelled'
    });
  } catch (err) {
    console.error('[Donation Cancel Error]', err.message);
    res.status(500).json({ success: false, error: err.message || 'Gagal membatalkan pembayaran.' });
  }
});

// 4. Daftar pesan dukungan publik
app.get('/api/donation/messages', (req, res) => {
  try {
    const donations = db.getPublicDonations(50);
    res.json({ success: true, donations: donations || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Gagal memuat pesan dukungan.' });
  }
});

// 5. Simulasi donasi sukses (Demo)
app.post('/api/donation/simulate-paid', (req, res) => {
  try {
    const { invoice_id } = req.body || {};
    if (!invoice_id) {
      return res.status(400).json({ success: false, error: 'Invoice ID wajib diisi.' });
    }

    const donation = db.getDonation(invoice_id);
    if (!donation) {
      return res.status(404).json({ success: false, error: 'Invoice tidak ditemukan.' });
    }

    const updated = db.updateDonationStatus(invoice_id, 'paid');
    res.json({
      success: true,
      message: 'Simulasi pembayaran sukses berhasil diterapkan.',
      donation: updated
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- [D] GENERAL & STATIC HTML ROUTING ---

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: config.APP_NAME,
    version: config.VERSION,
    time: new Date().toISOString()
  });
});

// Route halaman khusus
app.get('/traktir', (req, res) => {
  res.sendFile(path.join(publicPath, 'traktir.html'));
});

// Fallback HTML navigation
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Centralized error handling
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.message);
  res.status(500).json({
    success: false,
    error: 'Terjadi kesalahan pada server. Silakan coba beberapa saat lagi.'
  });
});

// ==============================================================================
// 7. STANDALONE SERVER STARTUP (VPS & Local)
// ==============================================================================
if (!process.env.VERCEL) {
  app.listen(PORT, HOST, () => {
    console.log(`=========================================`);
    console.log(`🚀 ${config.APP_NAME} berjalan pada:`);
    console.log(`👉 http://${HOST}:${PORT}`);
    console.log(`=========================================`);
  });
}

// Export default app untuk Vercel Serverless Function
export default app;
