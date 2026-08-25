// routes/donation.js - Endpoint Traktir Server & Donasi PutzPay
import express from 'express';
import putzpayService from '../services/putzpayService.js';
import db from '../database.js';

const router = express.Router();

// Helper sanitasi teks sederhana
function sanitizeText(str = '', maxLength = 300) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/[<>]/g, '') // Hapus karakter HTML mencurigakan
    .trim()
    .slice(0, maxLength);
}

// 1. Buat Invoice Donasi / Traktir Server
router.post('/create', async (req, res) => {
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
    if (!cleanName || cleanName.length === 0) {
      cleanName = 'Anonymous';
    }

    const cleanMessage = sanitizeText(message, 300);

    // Panggil PutzPay Gateway
    const qrisData = await putzpayService.createQris(numAmount);

    // Simpan ke database lokal
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

    // Kembalikan data aman ke frontend (TANPA API KEY)
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

// 2. Cek Status Pembayaran Donasi
router.post('/status', async (req, res) => {
  try {
    const { invoice_id } = req.body || {};

    if (!invoice_id) {
      return res.status(400).json({
        success: false,
        error: 'Parameter invoice_id wajib diisi.'
      });
    }

    let donation = db.getDonation(invoice_id);
    if (!donation) {
      return res.status(404).json({
        success: false,
        error: 'Invoice donasi tidak ditemukan.'
      });
    }

    // Jika sudah paid di database lokal, langsung kembalikan
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

    // Jika masih pending, cek ke PutzPay Gateway
    const gatewayStatus = await putzpayService.checkInvoiceStatus(invoice_id);

    if (gatewayStatus && gatewayStatus.status) {
      const normalizedStatus = gatewayStatus.status.toLowerCase();
      if (normalizedStatus === 'paid' || normalizedStatus === 'success' || normalizedStatus === 'settled') {
        donation = db.updateDonationStatus(invoice_id, 'paid');
      } else if (normalizedStatus === 'expired') {
        donation = db.updateDonationStatus(invoice_id, 'expired');
      } else if (normalizedStatus === 'cancelled' || normalizedStatus === 'canceled') {
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
    res.status(500).json({
      success: false,
      error: err.message || 'Gagal mengecek status pembayaran.'
    });
  }
});

// 3. Batalkan Pembayaran Donasi
router.post('/cancel', async (req, res) => {
  try {
    const { invoice_id } = req.body || {};

    if (!invoice_id) {
      return res.status(400).json({
        success: false,
        error: 'Parameter invoice_id wajib diisi.'
      });
    }

    const donation = db.getDonation(invoice_id);
    if (!donation) {
      return res.status(404).json({
        success: false,
        error: 'Invoice donasi tidak ditemukan.'
      });
    }

    if (donation.status === 'paid') {
      return res.status(400).json({
        success: false,
        error: 'Pembayaran yang sudah berhasil tidak dapat dibatalkan.'
      });
    }

    // Panggil cancel ke PutzPay
    await putzpayService.cancelInvoice(invoice_id);

    // Update status di database
    const updated = db.updateDonationStatus(invoice_id, 'cancelled');

    res.json({
      success: true,
      message: 'Pembayaran donasi berhasil dibatalkan.',
      invoice_id: updated.invoice_id,
      status: 'cancelled'
    });
  } catch (err) {
    console.error('[Donation Cancel Error]', err.message);
    res.status(500).json({
      success: false,
      error: err.message || 'Gagal membatalkan pembayaran.'
    });
  }
});

// 4. Ambil Daftar Pesan Dukungan Publik (Hanya yang berstatus 'paid')
router.get('/messages', (req, res) => {
  try {
    const donations = db.getPublicDonations(50);
    res.json({
      success: true,
      donations: donations || []
    });
  } catch (err) {
    console.error('[Donation Messages Error]', err.message);
    res.status(500).json({
      success: false,
      error: 'Gagal memuat pesan dukungan.'
    });
  }
});

// 5. Endpoint Simulasi Sukses (Hanya aktif untuk demo/testing cepat jika diperlukan)
router.post('/simulate-paid', (req, res) => {
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

export default router;
