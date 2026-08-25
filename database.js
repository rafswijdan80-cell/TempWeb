// database.js - Persistent Storage Layer untuk TempEmailNih
import fs from 'fs';
import path from 'path';
import config from './config.js';

class Database {
  constructor() {
    this.dbPath = path.resolve(config.DB_FILE_PATH);
    this.dirPath = path.dirname(this.dbPath);
    this.locks = new Set();
    this.memoryCache = null;
    this.init();
  }

  // Inisialisasi struktur database
  init() {
    try {
      if (!fs.existsSync(this.dirPath)) {
        fs.mkdirSync(this.dirPath, { recursive: true });
      }

      if (!fs.existsSync(this.dbPath)) {
        // Jika di serverless/tmp, coba seed dari database/tempemail.json jika ada
        const seedPath = path.resolve('./database/tempemail.json');
        if (seedPath !== this.dbPath && fs.existsSync(seedPath)) {
          try {
            const seedContent = fs.readFileSync(seedPath, 'utf-8');
            fs.writeFileSync(this.dbPath, seedContent, 'utf-8');
            this.memoryCache = JSON.parse(seedContent);
            return;
          } catch (e) {
            // lanjut buat default
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
      console.warn('[DB] Inisialisasi filesystem notice (menggunakan memory fallback):', err.message);
      if (!this.memoryCache) {
        this.memoryCache = { mailboxes: {}, messageStates: {}, donations: {}, settings: {} };
      }
    }
  }

  // Membaca seluruh data dengan penanganan error & fallback memory
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
      console.warn('[DB] Gagal membaca filesystem, menggunakan memory fallback:', err.message);
    }
    return this.memoryCache || { mailboxes: {}, messageStates: {}, donations: {}, settings: {} };
  }

  // Menyimpan data secara atomic dengan fallback memory
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
      // Pada Vercel / serverless jika filesystem read-only, fallback ke memory cache
      try {
        fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 2), 'utf-8');
        return true;
      } catch (writeErr) {
        console.warn('[DB] Write file notice (data disimpan di memory):', writeErr.message);
        return true;
      }
    }
  }

  // --- MAILBOX LOCK (Mencegah Race Condition) ---
  acquireLock(key) {
    if (this.locks.has(key)) {
      return false;
    }
    this.locks.add(key);
    return true;
  }

  releaseLock(key) {
    this.locks.delete(key);
  }

  // --- OPERASI MAILBOX ---
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
      if (data.mailboxes[key].email.toLowerCase() === lower) {
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
      
      // Hapus status pesan yang terkait dengan mailbox ini
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

  // --- OPERASI STATUS PESAN (Read, Star, Delete) ---
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

  // --- OPERASI DONASI & TRAKTIR SERVER (PutzPay) ---
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

  getAllDonations() {
    const data = this.readData();
    if (!data.donations) return [];
    return Object.values(data.donations);
  }
}

const db = new Database();
export default db;
