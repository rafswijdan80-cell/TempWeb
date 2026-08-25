// public/traktir.js - Controller untuk Halaman Traktir Server & PutzPay Gateway
(function () {
  'use strict';

  // --- STATE ---
  let selectedAmount = 10000;
  let activeInvoice = null;
  let pollInterval = null;
  let countdownInterval = null;

  // --- DOM ELEMENTS ---
  const presetGrid = document.getElementById('preset-grid');
  const groupCustomAmount = document.getElementById('group-custom-amount');
  const inputCustomAmount = document.getElementById('input-custom-amount');
  const inputDonorName = document.getElementById('input-donor-name');
  const checkAnonymous = document.getElementById('check-anonymous');
  const inputDonorMessage = document.getElementById('input-donor-message');
  const charCounter = document.getElementById('char-counter');
  const btnSubmitDonation = document.getElementById('btn-submit-donation');
  const btnSubmitText = document.getElementById('btn-submit-text');

  const sectionDonationForm = document.getElementById('section-donation-form');
  const sectionPayment = document.getElementById('section-payment');
  const sectionSuccess = document.getElementById('section-success');
  const sectionWall = document.getElementById('section-wall');

  const paymentStatusBadge = document.getElementById('payment-status-badge');
  const paymentStatusText = document.getElementById('payment-status-text');
  const qrisImage = document.getElementById('qris-image');
  const summaryAmount = document.getElementById('summary-amount');
  const summaryFee = document.getElementById('summary-fee');
  const summaryTotal = document.getElementById('summary-total');
  const invoiceIdText = document.getElementById('invoice-id-text');
  const btnCopyInvoice = document.getElementById('btn-copy-invoice');
  const countdownTimer = document.getElementById('countdown-timer');
  const btnManualCheck = document.getElementById('btn-manual-check');
  const btnCancelDonation = document.getElementById('btn-cancel-donation');
  const demoSimulateContainer = document.getElementById('demo-simulate-container');
  const btnSimulatePaid = document.getElementById('btn-simulate-paid');

  const successAmount = document.getElementById('success-amount');
  const successMessage = document.getElementById('success-message');
  const btnDonateAgain = document.getElementById('btn-donate-again');

  const wallList = document.getElementById('wall-list');
  const wallCount = document.getElementById('wall-count');
  const toastContainer = document.getElementById('toast-container');
  const btnThemeToggle = document.getElementById('btn-theme-toggle');

  // --- UTILS ---
  function formatRupiah(number) {
    return 'Rp ' + Number(number || 0).toLocaleString('id-ID');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function showToast(message, type = 'default') {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    if (type === 'success') toast.style.backgroundColor = 'var(--accent-mint)';
    if (type === 'error') toast.style.backgroundColor = 'var(--accent-coral)';

    toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      setTimeout(() => toast.remove(), 200);
    }, 2800);
  }

  // --- TEMA (DARK / LIGHT) ---
  function initTheme() {
    const saved = localStorage.getItem('tempemail_theme') || 'light';
    document.documentElement.setAttribute('data-theme', saved);

    if (btnThemeToggle) {
      btnThemeToggle.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('tempemail_theme', next);
      });
    }
  }

  // --- NOMINAL SELECTION ---
  function updateButtonLabel() {
    let currentAmount = selectedAmount;
    if (selectedAmount === 'custom') {
      currentAmount = parseInt(inputCustomAmount.value, 10) || 0;
    }
    if (currentAmount > 0) {
      btnSubmitText.textContent = `TRAKTIR SEKARANG (${formatRupiah(currentAmount).toUpperCase()})`;
    } else {
      btnSubmitText.textContent = 'TRAKTIR SEKARANG';
    }
  }

  function setupNominalEvents() {
    if (!presetGrid) return;

    presetGrid.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-preset');
      if (!btn) return;

      presetGrid.querySelectorAll('.btn-preset').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      const amountVal = btn.dataset.amount;
      if (amountVal === 'custom') {
        selectedAmount = 'custom';
        groupCustomAmount.style.display = 'flex';
        inputCustomAmount.focus();
      } else {
        selectedAmount = parseInt(amountVal, 10);
        groupCustomAmount.style.display = 'none';
      }
      updateButtonLabel();
    });

    if (inputCustomAmount) {
      inputCustomAmount.addEventListener('input', () => {
        updateButtonLabel();
      });
    }

    if (checkAnonymous && inputDonorName) {
      checkAnonymous.addEventListener('change', () => {
        if (checkAnonymous.checked) {
          inputDonorName.disabled = true;
          inputDonorName.value = 'Anonymous';
        } else {
          inputDonorName.disabled = false;
          inputDonorName.value = '';
          inputDonorName.focus();
        }
      });
    }

    if (inputDonorMessage && charCounter) {
      inputDonorMessage.addEventListener('input', () => {
        const length = inputDonorMessage.value.length;
        charCounter.textContent = `${length}/300`;
      });
    }
  }

  // --- 1. BUAT PEMBAYARAN DONASI (POST /api/donation/create) ---
  async function handleCreateDonation() {
    let amount = selectedAmount;
    if (amount === 'custom') {
      amount = parseInt(inputCustomAmount.value, 10);
    }

    if (!amount || isNaN(amount) || amount < 1000) {
      showToast('Nominal minimal adalah Rp 1.000', 'error');
      if (selectedAmount === 'custom') inputCustomAmount.focus();
      return;
    }

    const isAnonymous = checkAnonymous.checked;
    const displayName = isAnonymous ? 'Anonymous' : (inputDonorName.value.trim() || 'Anonymous');
    const message = inputDonorMessage.value.trim();

    btnSubmitDonation.disabled = true;
    btnSubmitText.textContent = 'MENGHUBUNGI GATEWAY...';

    try {
      const res = await fetch('/api/donation/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount,
          display_name: displayName,
          message,
          is_anonymous: isAnonymous
        })
      });

      const data = await res.json();

      if (!data.success) {
        throw new Error(data.error || 'Gagal membuat QRIS pembayaran.');
      }

      // Berhasil membuat invoice
      activeInvoice = data;
      showPaymentCard(data);
      startPolling(data.invoice_id);
      startCountdown(data.expired_at);

      if (data.is_mock && demoSimulateContainer) {
        demoSimulateContainer.style.display = 'block';
      }
    } catch (err) {
      showToast(err.message || 'Terjadi kesalahan saat memproses traktir.', 'error');
    } finally {
      btnSubmitDonation.disabled = false;
      updateButtonLabel();
    }
  }

  // --- TAMPILKAN KARTU PEMBAYARAN QRIS ---
  function showPaymentCard(data) {
    sectionDonationForm.style.display = 'none';
    sectionSuccess.style.display = 'none';
    sectionPayment.style.display = 'flex';

    paymentStatusBadge.className = 'status-badge status-pending';
    paymentStatusText.textContent = 'MENUNGGU PEMBAYARAN';

    qrisImage.src = data.qris_image;
    summaryAmount.textContent = formatRupiah(data.amount);
    summaryFee.textContent = formatRupiah(data.fee);
    summaryTotal.textContent = formatRupiah(data.total);
    invoiceIdText.textContent = data.invoice_id;

    window.scrollTo({ top: sectionPayment.offsetTop - 80, behavior: 'smooth' });
  }

  // --- POLLING STATUS PEMBAYARAN (5 Detik Sekali) ---
  function startPolling(invoiceId) {
    stopPolling();
    pollInterval = setInterval(async () => {
      await checkStatus(invoiceId, false);
    }, 5000);
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  // --- COUNTDOWN TIMER ---
  function startCountdown(expiredAt) {
    stopCountdown();
    if (!expiredAt) return;

    const expiryTime = new Date(expiredAt).getTime();

    function update() {
      const now = Date.now();
      const distance = expiryTime - now;

      if (distance <= 0) {
        countdownTimer.textContent = 'KADALUARSA';
        stopCountdown();
        stopPolling();
        paymentStatusBadge.className = 'status-badge status-expired';
        paymentStatusText.textContent = 'KADALUARSA';
        showToast('Invoice telah kadaluarsa. Silakan buat baru.', 'error');
        return;
      }

      const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((distance % (1000 * 60)) / 1000);
      countdownTimer.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    update();
    countdownInterval = setInterval(update, 1000);
  }

  function stopCountdown() {
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }

  // --- CEK STATUS PEMBAYARAN (POST /api/donation/status) ---
  async function checkStatus(invoiceId, isManual = false) {
    if (!invoiceId) return;

    if (isManual && btnManualCheck) {
      btnManualCheck.disabled = true;
      btnManualCheck.innerHTML = '<span>MENGECEK...</span>';
    }

    try {
      const res = await fetch('/api/donation/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: invoiceId })
      });

      const data = await res.json();

      if (data.success && data.status) {
        const status = data.status.toLowerCase();

        if (status === 'paid') {
          handlePaymentSuccess(data);
        } else if (status === 'cancelled') {
          handlePaymentCancelled();
        } else if (status === 'expired') {
          handlePaymentExpired();
        } else if (isManual) {
          showToast('Status: Belum ada pembayaran masuk. Silakan selesaikan scan QRIS.');
        }
      }
    } catch (err) {
      if (isManual) showToast('Gagal mengecek status pembayaran.', 'error');
    } finally {
      if (isManual && btnManualCheck) {
        btnManualCheck.disabled = false;
        btnManualCheck.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M23 4v6h-6"></path>
            <path d="M1 20v-6h6"></path>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
          </svg>
          <span>CEK STATUS SEKARANG</span>
        `;
      }
    }
  }

  // --- PEMBAYARAN BERHASIL ---
  function handlePaymentSuccess(data) {
    stopPolling();
    stopCountdown();

    paymentStatusBadge.className = 'status-badge status-paid';
    paymentStatusText.textContent = 'PEMBAYARAN BERHASIL';

    sectionPayment.style.display = 'none';
    sectionSuccess.style.display = 'flex';

    successAmount.textContent = formatRupiah(data.total || data.amount);
    successMessage.textContent = data.message ? `"${escapeHtml(data.message)}"` : `"${escapeHtml(activeInvoice?.message || '-')}"`;

    showToast('🎉 Terima kasih! Pembayaran traktir berhasil.', 'success');
    loadPublicDonations();

    window.scrollTo({ top: sectionSuccess.offsetTop - 80, behavior: 'smooth' });
  }

  function handlePaymentCancelled() {
    stopPolling();
    stopCountdown();
    showToast('Pembayaran dibatalkan.', 'default');
    resetToForm();
  }

  function handlePaymentExpired() {
    stopPolling();
    stopCountdown();
    paymentStatusBadge.className = 'status-badge status-expired';
    paymentStatusText.textContent = 'KADALUARSA';
    showToast('Waktu pembayaran telah habis.', 'error');
  }

  // --- BATALKAN PEMBAYARAN (POST /api/donation/cancel) ---
  async function handleCancelDonation() {
    if (!activeInvoice || !activeInvoice.invoice_id) {
      resetToForm();
      return;
    }

    if (!confirm('Apakah kamu yakin ingin membatalkan pembayaran ini?')) {
      return;
    }

    btnCancelDonation.disabled = true;
    try {
      const res = await fetch('/api/donation/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: activeInvoice.invoice_id })
      });

      const data = await res.json();
      if (data.success) {
        showToast('Pembayaran berhasil dibatalkan.');
      }
    } catch (err) {
      console.warn('Gagal membatalkan di server:', err.message);
    } finally {
      btnCancelDonation.disabled = false;
      stopPolling();
      stopCountdown();
      resetToForm();
    }
  }

  // --- SIMULASI PEMBAYARAN SUKSES (MODE DEMO) ---
  async function handleSimulatePaid() {
    if (!activeInvoice || !activeInvoice.invoice_id) return;

    try {
      const res = await fetch('/api/donation/simulate-paid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: activeInvoice.invoice_id })
      });
      const data = await res.json();
      if (data.success) {
        handlePaymentSuccess(data.donation || activeInvoice);
      }
    } catch (err) {
      showToast('Gagal simulasi pembayaran', 'error');
    }
  }

  function resetToForm() {
    activeInvoice = null;
    sectionPayment.style.display = 'none';
    sectionSuccess.style.display = 'none';
    sectionDonationForm.style.display = 'flex';
    if (demoSimulateContainer) demoSimulateContainer.style.display = 'none';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // --- SALIN INVOICE ID ---
  function copyInvoiceId() {
    if (!activeInvoice || !activeInvoice.invoice_id) return;
    navigator.clipboard.writeText(activeInvoice.invoice_id).then(() => {
      showToast(`Invoice ID "${activeInvoice.invoice_id}" disalin!`);
    }).catch(() => {
      showToast('Gagal menyalin invoice ID', 'error');
    });
  }

  // --- 4. AMBIL WALL DUKUNGAN PUBLIK (GET /api/donation/messages) ---
  async function loadPublicDonations() {
    if (!wallList) return;

    try {
      const res = await fetch('/api/donation/messages');
      const data = await res.json();

      if (data.success && Array.isArray(data.donations)) {
        renderWall(data.donations);
      }
    } catch (err) {
      console.warn('Gagal memuat wall donasi:', err.message);
      wallList.innerHTML = `
        <div class="empty-wall-state">
          <p>Belum ada pesan yang ditampilkan.</p>
        </div>
      `;
    }
  }

  function renderWall(donations) {
    if (!wallList || !wallCount) return;

    wallCount.textContent = `${donations.length} Pendukung`;

    if (donations.length === 0) {
      wallList.innerHTML = `
        <div class="empty-wall-state">
          <p>🚀 Belum ada traktiran. Jadilah pendukung pertama TempEmailNih!</p>
        </div>
      `;
      return;
    }

    wallList.innerHTML = donations
      .map((item) => {
        const timeStr = item.paid_at
          ? new Date(item.paid_at).toLocaleDateString('id-ID', {
              day: 'numeric',
              month: 'short',
              year: 'numeric'
            })
          : 'Baru saja';

        return `
          <div class="supporter-item">
            <div class="supporter-header">
              <div class="supporter-name-wrap">
                <span>❤️</span>
                <span>${escapeHtml(item.display_name || 'Anonymous')}</span>
              </div>
              <span class="supporter-amount">${formatRupiah(item.amount)}</span>
            </div>
            ${
              item.message
                ? `<p class="supporter-message">"${escapeHtml(item.message)}"</p>`
                : ''
            }
            <span class="supporter-time">${escapeHtml(timeStr)}</span>
          </div>
        `;
      })
      .join('');
  }

  // --- INISIALISASI EVENT LISTENERS ---
  function initEvents() {
    if (btnSubmitDonation) {
      btnSubmitDonation.addEventListener('click', handleCreateDonation);
    }

    if (btnManualCheck) {
      btnManualCheck.addEventListener('click', () => {
        if (activeInvoice && activeInvoice.invoice_id) {
          checkStatus(activeInvoice.invoice_id, true);
        }
      });
    }

    if (btnCancelDonation) {
      btnCancelDonation.addEventListener('click', handleCancelDonation);
    }

    if (btnCopyInvoice) {
      btnCopyInvoice.addEventListener('click', copyInvoiceId);
    }

    if (btnDonateAgain) {
      btnDonateAgain.addEventListener('click', resetToForm);
    }

    if (btnSimulatePaid) {
      btnSimulatePaid.addEventListener('click', handleSimulatePaid);
    }
  }

  // --- STARTUP ---
  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    setupNominalEvents();
    initEvents();
    loadPublicDonations();
  });
})();
