// routes/mailbox.js - Endpoint Manajemen Mailbox TempEmailNih
import express from 'express';
import mailService from '../mailService.js';
import db from '../database.js';

const router = express.Router();

// Middleware no-cache untuk semua rute mailbox
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  next();
});

// Helper untuk mendapatkan mailbox aktif dari request
export function getMailboxFromRequest(req) {
  const mailboxId = req.headers['x-mailbox-id'] || req.cookies?.mailbox_id || req.query.mailboxId;
  if (mailboxId) {
    const found = db.getMailbox(mailboxId);
    if (found) return found;
  }

  // Fallback ke mailbox terakhir yang tersimpan di DB
  const all = db.getAllMailboxes();
  if (all.length > 0) {
    return db.getMailbox(all[all.length - 1].id);
  }

  return null;
}

// 1. Ambil domain yang aktif
router.get('/domains', async (req, res) => {
  try {
    const domains = await mailService.getActiveDomains();
    res.json({ success: true, domains });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Ambil mailbox saat ini (atau buat baru jika belum ada)
router.get('/current', async (req, res) => {
  try {
    let mailbox = getMailboxFromRequest(req);
    
    if (!mailbox) {
      // Buat mailbox baru otomatis jika belum ada
      mailbox = await mailService.createAutoEmail();
    }

    // Set cookie untuk persistensi sesi
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

// 3. Buat mailbox baru (Auto / Custom)
router.post('/create', async (req, res) => {
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
});

// 4. Ambil daftar semua mailbox yang pernah dibuat di sesi ini
router.get('/list', (req, res) => {
  try {
    const mailboxes = db.getAllMailboxes();
    res.json({ success: true, mailboxes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Ganti mailbox aktif
router.post('/switch', (req, res) => {
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
router.delete('/:id', (req, res) => {
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

export default router;
