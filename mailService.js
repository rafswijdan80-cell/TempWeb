// mailService.js - Layanan Komunikasi Mail.tm API & Pengolah Email Cerdas
import config from './config.js';
import db from './database.js';

class MailService {
  constructor() {
    this.baseUrl = config.MAILTM_BASE_URL;
  }

  // Helper fetch internal dengan timeout & error handling
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
        throw new Error('Server email sedang lambat. Coba lagi.');
      }
      throw new Error(`Koneksi Mail.tm gagal: ${err.message}`);
    }
  }

  // 1. Ambil domain aktif Mail.tm
  async getActiveDomains() {
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/domains`);
      if (!res.ok) {
        throw new Error(`Gagal mengambil domain: status ${res.status}`);
      }
      const data = await res.json();
      const domains = (data['hydra:member'] || data.member || data || [])
        .filter(d => d.isActive !== false)
        .map(d => d.domain);
      
      if (!domains.length) {
        throw new Error('Tidak ada domain aktif yang tersedia dari Mail.tm');
      }
      return domains;
    } catch (err) {
      console.error('[MailService] getActiveDomains error:', err.message);
      throw err;
    }
  }

  // Generate string acak aman untuk username & password
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

  // 3. Buat email custom
  async createCustomEmail(customUsername, customDomain) {
    const domains = await this.getActiveDomains();
    const domain = customDomain && domains.includes(customDomain) ? customDomain : domains[0];
    
    // Sanitasi username: hanya huruf kecil, angka, titik, strip
    const cleanUsername = customUsername
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

  // 4. Daftar akun & langsung login (POST /accounts lalu POST /token)
  async createAccountAndLogin(address, password) {
    const lockKey = `create_${address}`;
    if (!db.acquireLock(lockKey)) {
      throw new Error('Permintaan pembuatan akun sedang diproses.');
    }

    try {
      // Step A: POST /accounts
      const registerRes = await this.fetchWithTimeout(`${this.baseUrl}/accounts`, {
        method: 'POST',
        body: JSON.stringify({ address, password })
      });

      if (!registerRes.ok && registerRes.status !== 422) {
        const errJson = await registerRes.json().catch(() => ({}));
        throw new Error(errJson.message || `Gagal mendaftarkan email (${registerRes.status})`);
      }

      const accountData = await registerRes.json().catch(() => ({}));
      const accountId = accountData.id || `acc_${Date.now()}`;

      // Step B: POST /token
      const token = await this.obtainToken(address, password);

      // Step C: Validasi akun dengan GET /me
      const meInfo = await this.verifyTokenWithMe(token);

      // Simpan ke DB secara aman (tidak dikirimkan password/token ke klien frontend)
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

  // 5. POST /token untuk otentikasi
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

  // 6. Validasi token menggunakan GET /me
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

  // 7. Refresh token otomatis jika expired
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

  // 8. Pastikan token aktif sebelum request
  async ensureValidToken(mailbox) {
    if (!mailbox) throw new Error('Mailbox tidak ditemukan');
    
    if (mailbox.providerToken) {
      try {
        await this.verifyTokenWithMe(mailbox.providerToken);
        return mailbox.providerToken;
      } catch (err) {
        // Token mungkin expired, coba refresh
      }
    }

    return await this.refreshToken(mailbox);
  }

  // 9. Ambil daftar pesan (GET /messages) dan normalisasi
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
        // Coba sekali lagi dengan token baru
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

  // Pemrosesan daftar pesan & overlay state database
  processMessagesList(data, mailboxId) {
    const rawList = data['hydra:member'] || data.member || data || [];
    const totalCount = data['hydra:totalItems'] || rawList.length;

    const messages = rawList.map(msg => {
      const msgState = db.getMessageState(mailboxId, msg.id);
      
      // Deteksi cepat OTP dari intro/subject
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
    }).filter(msg => !msg.isDeleted); // Sembunyikan yang telah dihapus

    return {
      messages,
      total: totalCount,
      unreadCount: messages.filter(m => !m.isRead).length
    };
  }

  // 10. Ambil detail email tunggal (GET /messages/{id})
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

  // 11. Ambil detail email dengan Smart Link & OTP Detection
  async getMessageDetailWithLinks(mailbox, messageId) {
    const rawMsg = await this.getMessageDetail(mailbox, messageId);
    
    // Otomatis tandai sebagai sudah dibaca
    db.setMessageRead(mailbox.id, messageId, true);
    const msgState = db.getMessageState(mailbox.id, messageId);

    const htmlContent = Array.isArray(rawMsg.html) ? rawMsg.html.join('') : (rawMsg.html || '');
    const textContent = rawMsg.text || '';
    const subject = rawMsg.subject || '(Tanpa Subjek)';
    const intro = rawMsg.intro || '';

    // Ekstraksi Link Cerdas
    const smartLinks = this.extractEmailLinks(htmlContent, textContent);

    // Deteksi Kode Verifikasi / OTP Cerdas
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

  // 12. Ekstraksi Link Cerdas dari HTML & Teks Email
  extractEmailLinks(html = '', text = '') {
    const links = [];
    const seenUrls = new Set();

    // 1. Ekstrak dari Tag HTML <a>
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

    // 2. Ekstrak URL polos dari teks jika belum ada
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

    // Sort agar aksi utama (Primary) selalu berada di depan
    return links.sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0)).slice(0, 8);
  }

  // Validasi URL aksi yang pantas ditampilkan
  isValidActionUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.startsWith('mailto:') || url.startsWith('tel:') || url.startsWith('javascript:')) return false;
    if (url.includes('unsubscribe') || url.includes('opt-out') || url.includes('privacy-policy')) return false;
    return url.startsWith('http://') || url.startsWith('https://');
  }

  // Tentukan apakah link merupakan tombol aksi utama
  isPrimaryAction(text = '', url = '') {
    const combined = `${text} ${url}`.toLowerCase();
    return /verif|confirm|sign\s*in|login|masuk|aktiv|activate|reset|auth|claim|lanjutkan/i.test(combined);
  }

  // 13. Smart URL Label generator
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

  // 14. Detektor OTP Cerdas dan Kontekstual
  detectGenericVerificationCode(subject = '', text = '', intro = '', html = '') {
    // Gabungkan teks untuk pencarian konteks
    const fullText = `${subject}\n${intro}\n${text}\n${html ? html.replace(/<[^>]+>/g, ' ') : ''}`;
    
    // Kata kunci kontekstual yang mengindikasikan kode keamanan
    const contextKeywords = [
      'otp', 'code', 'kode', 'verification', 'verifikasi', 'verify',
      'security code', 'passcode', 'pin', 'login', 'sign in', 'confirmation',
      'konfirmasi', 'auth', 'two-factor', '2fa', 'authenticator'
    ];

    const lowerText = fullText.toLowerCase();
    const hasContext = contextKeywords.some(kw => lowerText.includes(kw));

    if (!hasContext) return null;

    // Pattern 1: Pola eksplisit dengan kata kunci, e.g. "code is: 123456", "OTP: 839-102", "kode: 928 102"
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

    // Pattern 2: Cari angka mandiri 4-8 digit dalam konteks dekat kata kunci
    const lines = fullText.split(/[\r\n]+/);
    for (const line of lines) {
      const lineLower = line.toLowerCase();
      if (contextKeywords.some(kw => lineLower.includes(kw))) {
        // Cari angka 4-8 digit di baris ini
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

  // Validasi keaslian format OTP (bukan tahun, tanggal, jam, nominal, dll)
  isValidOtpCode(code) {
    if (!code) return false;
    const cleanDigits = code.replace(/[-\s]/g, '');
    
    // Harus 4 sampai 8 digit angka murni
    if (!/^\d{4,8}$/.test(cleanDigits)) return false;

    const num = parseInt(cleanDigits, 10);

    // Filter tahun saat ini dan sekitar (2020-2035)
    if (cleanDigits.length === 4 && num >= 2020 && num <= 2035) {
      return false;
    }

    // Filter tanggal jam seperti 0000, 1111, dll jika repetitive
    if (/^(\d)\1+$/.test(cleanDigits) && cleanDigits.length >= 6) {
      return false;
    }

    // Filter port umum
    if ([3000, 8080, 8000, 5000, 4000, 8443].includes(num)) {
      return false;
    }

    return true;
  }

  // 15. Hapus pesan (DELETE /messages/{id})
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
      console.warn('[MailService] Delete remote message failed, updating local state:', err.message);
    }

    // Selalu tandai terhapus di database lokal
    db.setMessageDeleted(mailbox.id, messageId, true);
    return true;
  }
}

const mailService = new MailService();
export default mailService;
