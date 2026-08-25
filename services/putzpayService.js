// services/putzpayService.js - Integrasi PutzPay Gateway
import config from '../config.js';

class PutzpayService {
  constructor() {
    this.baseUrl = config.PUTZPAY_BASE_URL || 'https://putzpay.biz.id';
    this.apiKey = config.PUTZPAY_API_KEY || 'YOUR_API_KEY';
    this.timeout = config.REQUEST_TIMEOUT_MS || 15000;
  }

  getHeaders() {
    return {
      'x-apikey': this.apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  // 1. Buat Invoice QRIS
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

      // Jika PutzPay mengembalikan pesan error
      const errorMsg = data?.message || data?.error || `Gagal membuat QRIS (Status: ${response.status})`;
      console.warn('[PutzPay API Warning]', errorMsg);

      // Fallback generator jika API Key default / testing
      if (this.apiKey === 'YOUR_API_KEY' || response.status === 401 || response.status === 403) {
        console.log('[PutzPay] Menggunakan mode fallback QRIS untuk testing/pengembangan.');
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

      throw new Error(errorMsg);
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('Koneksi ke PutzPay timeout. Silakan coba kembali.');
      }
      throw err;
    }
  }

  // 2. Cek Status Invoice
  async checkInvoiceStatus(invoiceId) {
    if (!invoiceId) {
      throw new Error('Invoice ID diperlukan.');
    }

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

      return {
        success: false,
        status: 'pending',
        message: data?.message || 'Gagal memeriksa status invoice'
      };
    } catch (err) {
      console.warn('[PutzPay Status Error]', err.message);
      return {
        success: false,
        status: 'pending',
        error: err.message
      };
    }
  }

  // 3. Batalkan Invoice
  async cancelInvoice(invoiceId) {
    if (!invoiceId) {
      throw new Error('Invoice ID diperlukan.');
    }

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

      if (response.ok && data) {
        return {
          success: true,
          message: data.message || 'Invoice berhasil dibatalkan'
        };
      }

      return {
        success: true,
        message: 'Invoice ditandai batal'
      };
    } catch (err) {
      console.warn('[PutzPay Cancel Error]', err.message);
      return {
        success: true,
        message: 'Invoice dibatalkan di sistem lokal'
      };
    }
  }
}

const putzpayService = new PutzpayService();
export default putzpayService;
