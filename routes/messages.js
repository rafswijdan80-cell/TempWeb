// routes/messages.js - Endpoint Manajemen Email (Inbox, Detail, Star, Read, Delete)
import express from 'express';
import mailService from '../mailService.js';
import db from '../database.js';
import { getMailboxFromRequest } from './mailbox.js';

const router = express.Router();

// Middleware no-cache untuk semua rute pesan email
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  next();
});

// 1. Ambil daftar email (dengan folder & filter search)
router.get('/', async (req, res) => {
  try {
    const mailbox = getMailboxFromRequest(req);
    if (!mailbox) {
      return res.status(404).json({ success: false, error: 'Mailbox belum tersedia' });
    }

    const { folder = 'inbox', search = '', page = 1 } = req.query;

    const data = await mailService.getNormalizedInbox(mailbox, { page: Number(page) || 1 });
    let messages = data.messages || [];

    // Filter folder
    if (folder === 'starred') {
      messages = messages.filter(m => m.isStarred);
    } else if (folder === 'recent') {
      // Urutkan berdasarkan waktu paling baru
      messages = messages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    // Filter search jika ada query
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

// 2. Ambil detail satu email (dengan smart links & OTP detection)
router.get('/:id', async (req, res) => {
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

// 3. Update status Read / Unread
router.post('/:id/read', (req, res) => {
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

// 4. Update status Star / Unstar
router.post('/:id/star', (req, res) => {
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
router.delete('/:id', async (req, res) => {
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

export default router;
