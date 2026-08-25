// public/app.js — Controller Frontend TempEmailNih
// Pure Vanilla JavaScript, Anti-Cross-Origin DOM Email Renderer, Real-Time Polling & Neobrutalist UI

(function () {
  'use strict';

  // --- STATE APLIKASI ---
  const state = {
    mailbox: null,
    mailboxesList: [],
    messages: [],
    previousMessageIds: new Set(),
    selectedMessageId: null,
    selectedMessageDetail: null,
    currentTab: 'inbox', // 'inbox' | 'recent' | 'starred'
    searchQuery: '',
    availableDomains: [],
    theme: localStorage.getItem('tempemail_theme') || 'light',
    activeDetailTab: 'html', // 'html' | 'text'
    isFetching: false,
    refreshCountdown: 10,
    countdownInterval: null
  };

  // --- DOM CACHE ---
  const el = {
    // Header
    themeToggleBtn: document.getElementById('btn-toggle-theme'),
    themeIcon: document.getElementById('theme-icon'),
    searchInput: document.getElementById('search-input'),
    btnClearSearch: document.getElementById('btn-clear-search'),
    
    // Card 1: Generator
    activeEmailText: document.getElementById('active-email-text'),
    emailDisplayBox: document.getElementById('email-display-box'),
    btnCopyEmail: document.getElementById('btn-copy-email'),
    copyBtnText: document.getElementById('copy-btn-text'),
    btnNewEmail: document.getElementById('btn-new-email'),
    btnAddDomain: document.getElementById('btn-add-domain'),
    btnRefreshInbox: document.getElementById('btn-refresh-inbox'),
    refreshCountdown: document.getElementById('refresh-countdown'),
    mailboxStatusBadge: document.getElementById('mailbox-status-badge'),
    
    // Card 2: Inbox
    inboxEmailTitle: document.getElementById('inbox-email-title'),
    btnExpandInbox: document.getElementById('btn-expand-inbox'),
    inboxCountBadge: document.getElementById('inbox-count-badge'),
    tabsRow: document.getElementById('inbox-tabs-row'),
    btnOpenMultiAccount: document.getElementById('btn-open-multi-account'),
    
    // Inbox Body Views
    skeletonLoader: document.getElementById('skeleton-loader'),
    emptyState: document.getElementById('empty-state'),
    emailListWrap: document.getElementById('email-list-wrap'),
    emailList: document.getElementById('email-list'),
    emailDetailContainer: document.getElementById('email-detail-container'),
    
    // Modals
    modalCustomDomain: document.getElementById('modal-custom-domain'),
    inputCustomUsername: document.getElementById('input-custom-username'),
    selectDomain: document.getElementById('select-domain'),
    btnSubmitCreateMailbox: document.getElementById('btn-submit-create-mailbox'),
    btnRandomCreateMailbox: document.getElementById('btn-random-create-mailbox'),
    modalManageMailbox: document.getElementById('modal-manage-mailbox'),
    mailboxesContainer: document.getElementById('mailboxes-container'),
    
    // Toast Container
    toastContainer: document.getElementById('toast-container')
  };

  // --- HELPER: TOAST NOTIFIKASI ---
  function showToast(message, icon = '🔔', duration = 3000) {
    if (!el.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = 'toast-box';
    toast.innerHTML = `<span>${icon}</span> <span>${escapeHtml(message)}</span>`;
    el.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      setTimeout(() => toast.remove(), 250);
    }, duration);
  }

  // --- TEMA: LIGHT / DARK ---
  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('tempemail_theme', theme);
    if (el.themeIcon) {
      el.themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
    }
  }

  // --- INISIALISASI UTAMA ---
  async function init() {
    applyTheme(state.theme);
    setupEventListeners();

    // 1. Muat domain yang tersedia dari Mail.tm
    await loadDomains();

    // 2. Ambil mailbox aktif saat ini
    await loadCurrentMailbox();

    // 3. Muat pesan masuk awal
    await fetchMessages();

    // 4. Mulai auto refresh countdown
    startCountdown();
  }

  // --- SETUP EVENT LISTENERS ---
  function setupEventListeners() {
    // Toggle tema
    if (el.themeToggleBtn) {
      el.themeToggleBtn.addEventListener('click', () => {
        applyTheme(state.theme === 'dark' ? 'light' : 'dark');
      });
    }

    // Salin email saat klik tombol salin atau kotak email
    if (el.btnCopyEmail) el.btnCopyEmail.addEventListener('click', copyEmailAddress);
    if (el.emailDisplayBox) el.emailDisplayBox.addEventListener('click', copyEmailAddress);

    // Buat email baru cepat
    if (el.btnNewEmail) el.btnNewEmail.addEventListener('click', () => openCustomDomainModal());
    if (el.btnAddDomain) el.btnAddDomain.addEventListener('click', () => openCustomDomainModal());

    // Refresh inbox
    if (el.btnRefreshInbox) {
      el.btnRefreshInbox.addEventListener('click', () => {
        state.refreshCountdown = 10;
        fetchMessages(false, true);
      });
    }
    if (el.btnExpandInbox) {
      el.btnExpandInbox.addEventListener('click', () => {
        state.refreshCountdown = 10;
        fetchMessages(false, true);
      });
    }

    // Tab filter inbox (Semua, Terbaru, Berbintang)
    if (el.tabsRow) {
      el.tabsRow.querySelectorAll('.neo-tab[data-tab]').forEach(tab => {
        tab.addEventListener('click', () => {
          const targetTab = tab.getAttribute('data-tab');
          if (targetTab) switchTab(targetTab);
        });
      });
    }

    // Kelola multi-account modal
    if (el.btnOpenMultiAccount) {
      el.btnOpenMultiAccount.addEventListener('click', openManageMailboxModal);
    }

    // Form buat email kustom & acak
    if (el.btnSubmitCreateMailbox) {
      el.btnSubmitCreateMailbox.addEventListener('click', handleCustomMailboxSubmit);
    }
    if (el.btnRandomCreateMailbox) {
      el.btnRandomCreateMailbox.addEventListener('click', handleRandomMailboxSubmit);
    }

    // Search input
    let searchTimer;
    if (el.searchInput) {
      el.searchInput.addEventListener('input', (e) => {
        state.searchQuery = e.target.value;
        if (el.btnClearSearch) {
          el.btnClearSearch.classList.toggle('visible', state.searchQuery.length > 0);
        }
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          fetchMessages(true);
        }, 300);
      });
    }

    if (el.btnClearSearch) {
      el.btnClearSearch.addEventListener('click', () => {
        if (el.searchInput) el.searchInput.value = '';
        state.searchQuery = '';
        el.btnClearSearch.classList.remove('visible');
        fetchMessages(true);
      });
    }

    // Tutup modal saat klik luar atau tombol tutup
    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.classList.remove('active');
      });
    });

    document.querySelectorAll('.btn-close-modal').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.remove('active'));
      });
    });
  }

  // --- SALIN ALAMAT EMAIL KE CLIPBOARD ---
  async function copyEmailAddress() {
    if (!state.mailbox?.email) return;
    try {
      await navigator.clipboard.writeText(state.mailbox.email);
      showToast('Alamat email berhasil disalin!', '📋');
      if (el.copyBtnText) {
        const prev = el.copyBtnText.textContent;
        el.copyBtnText.textContent = 'TERSELIN!';
        setTimeout(() => el.copyBtnText.textContent = prev, 1500);
      }
    } catch (err) {
      const fallback = document.createElement('input');
      fallback.value = state.mailbox.email;
      document.body.appendChild(fallback);
      fallback.select();
      document.execCommand('copy');
      document.body.removeChild(fallback);
      showToast('Alamat email disalin!', '📋');
    }
  }

  // --- AMBIL DAFTAR DOMAIN ---
  async function loadDomains() {
    try {
      const res = await fetch('/api/mailbox/domains');
      const data = await res.json();
      if (data.success && Array.isArray(data.domains)) {
        state.availableDomains = data.domains;
        if (el.selectDomain) {
          el.selectDomain.innerHTML = data.domains
            .map(d => `<option value="${d}">@${d}</option>`)
            .join('');
        }
      }
    } catch (err) {
      console.warn('Gagal memuat domain:', err);
    }
  }

  // --- AMBIL MAILBOX SAAT INI ---
  async function loadCurrentMailbox() {
    try {
      const headers = {};
      const savedId = localStorage.getItem('tempemail_active_id');
      if (savedId) headers['x-mailbox-id'] = savedId;

      const res = await fetch('/api/mailbox/current', { headers });
      const data = await res.json();

      if (data.success && data.mailbox) {
        state.mailbox = data.mailbox;
        localStorage.setItem('tempemail_active_id', data.mailbox.id);
        updateMailboxUI();
      }
    } catch (err) {
      console.error('Gagal memuat mailbox:', err);
    }
  }

  // Update Tampilan Alamat Email
  function updateMailboxUI() {
    if (!state.mailbox) return;
    if (el.activeEmailText) el.activeEmailText.textContent = state.mailbox.email;
    if (el.inboxEmailTitle) el.inboxEmailTitle.textContent = state.mailbox.email;
    if (el.mailboxStatusBadge) {
      el.mailboxStatusBadge.textContent = 'EMAIL APPROVED';
      el.mailboxStatusBadge.style.backgroundColor = 'var(--accent-mint-bg)';
    }
  }

  // --- GANTI TAB FILTER (Semua / Terbaru / Berbintang) ---
  function switchTab(tabName) {
    state.currentTab = tabName;
    if (el.tabsRow) {
      el.tabsRow.querySelectorAll('.neo-tab[data-tab]').forEach(tab => {
        tab.classList.toggle('active', tab.getAttribute('data-tab') === tabName);
      });
    }
    // Jika sedang di detail view, kembali ke list view
    closeEmailDetail();
    fetchMessages();
  }

  // --- FETCH PESAN DARI BACKEND MAIL.TM ---
  async function fetchMessages(silent = false, spin = false) {
    if (state.isFetching) return;
    state.isFetching = true;

    if (spin && el.btnRefreshInbox) {
      const icon = el.btnRefreshInbox.querySelector('.refresh-icon');
      if (icon) {
        icon.classList.add('spinning');
        setTimeout(() => icon.classList.remove('spinning'), 1000);
      }
    }

    if (!silent && !state.selectedMessageId) {
      if (el.skeletonLoader) el.skeletonLoader.style.display = 'flex';
      if (el.emptyState) el.emptyState.style.display = 'none';
      if (el.emailListWrap) el.emailListWrap.style.display = 'none';
    }

    try {
      const params = new URLSearchParams({
        folder: state.currentTab,
        search: state.searchQuery
      });

      const headers = {};
      if (state.mailbox?.id) headers['x-mailbox-id'] = state.mailbox.id;

      const res = await fetch(`/api/messages?${params.toString()}`, { headers });
      const data = await res.json();

      if (data.success) {
        const msgs = data.messages || [];

        // Deteksi pesan baru masuk
        if (state.previousMessageIds.size > 0) {
          const fresh = msgs.filter(m => !state.previousMessageIds.has(m.id));
          if (fresh.length > 0) {
            const topMsg = fresh[0];
            showToast(`Email baru dari ${topMsg.from?.name || 'Pengirim'}!`, '📬', 5000);
            playBeep();
          }
        }

        state.previousMessageIds = new Set(msgs.map(m => m.id));
        state.messages = msgs;

        // Update Badge Count
        if (el.inboxCountBadge) {
          el.inboxCountBadge.textContent = `${msgs.length} PESAN`;
        }

        // Render hanya jika tidak sedang membuka detail
        if (!state.selectedMessageId) {
          renderEmailList();
        }
      } else if (data.error === 'REAUTH_REQUIRED') {
        await loadCurrentMailbox();
        await fetchMessages(true);
      }
    } catch (err) {
      console.error('Fetch messages error:', err);
    } finally {
      state.isFetching = false;
      if (el.skeletonLoader) el.skeletonLoader.style.display = 'none';
    }
  }

  // --- RENDER DAFTAR EMAIL (NEOBRUTALIST ROW) ---
  function renderEmailList() {
    if (!el.emailListWrap || !el.emailList) return;

    if (state.messages.length === 0) {
      el.emailListWrap.style.display = 'none';
      if (el.emptyState) el.emptyState.style.display = 'flex';
      return;
    }

    if (el.emptyState) el.emptyState.style.display = 'none';
    el.emailListWrap.style.display = 'block';
    el.emailList.innerHTML = '';

    state.messages.forEach(msg => {
      const senderName = msg.from?.name || msg.from?.address || 'Pengirim';
      const initial = senderName.charAt(0).toUpperCase();
      const timeStr = formatEmailTime(msg.createdAt);

      const li = document.createElement('li');
      li.className = `email-item-row ${!msg.isRead ? 'unread' : ''}`;
      li.setAttribute('data-id', msg.id);

      li.innerHTML = `
        <div class="row-avatar">${initial}</div>
        <div class="row-main-content">
          <div class="row-header-line">
            <span class="row-sender-name">${escapeHtml(senderName)}</span>
            <span class="row-date-badge">${timeStr}</span>
          </div>
          <div class="row-subject-text">${escapeHtml(msg.subject || '(Tanpa Subjek)')}</div>
          <div class="row-snippet-text">${escapeHtml(msg.intro || '')}</div>
          <div class="row-tags-line">
            ${msg.quickOtp ? `<span class="row-otp-tag">🔑 OTP: ${escapeHtml(msg.quickOtp)}</span>` : ''}
            ${msg.hasAttachments ? `<span>📎</span>` : ''}
          </div>
        </div>
        <button class="btn-star-row ${msg.isStarred ? 'starred' : ''}" data-id="${msg.id}" title="Bintang" onclick="event.stopPropagation()">
          ${msg.isStarred ? '★' : '☆'}
        </button>
      `;

      // Event Klik Baris -> Buka Detail
      li.addEventListener('click', () => openEmailDetail(msg.id));

      // Event Star
      const starBtn = li.querySelector('.btn-star-row');
      starBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleStar(msg.id, !msg.isStarred);
      });

      el.emailList.appendChild(li);
    });
  }

  // --- BUKA DETAIL EMAIL (GET /api/messages/:id) ---
  async function openEmailDetail(messageId) {
    state.selectedMessageId = messageId;

    if (el.emptyState) el.emptyState.style.display = 'none';
    if (el.emailListWrap) el.emailListWrap.style.display = 'none';
    if (el.emailDetailContainer) {
      el.emailDetailContainer.style.display = 'flex';
      el.emailDetailContainer.innerHTML = `
        <div style="padding: 30px; text-align: center; color: var(--text-tertiary);">
          <p class="spinning" style="font-size: 24px; display: inline-block;">⏳</p>
          <p style="font-weight: 700; margin-top: 8px;">Memuat isi email...</p>
        </div>
      `;
    }

    try {
      const headers = {};
      if (state.mailbox?.id) headers['x-mailbox-id'] = state.mailbox.id;

      const res = await fetch(`/api/messages/${encodeURIComponent(messageId)}`, { headers });
      const data = await res.json();

      if (data.success && data.message) {
        state.selectedMessageDetail = data.message;
        renderEmailDetailContent(data.message);

        // Tandai terbaca lokal
        const local = state.messages.find(m => m.id === messageId);
        if (local) local.isRead = true;
      } else {
        throw new Error(data.error || 'Gagal memuat email');
      }
    } catch (err) {
      if (el.emailDetailContainer) {
        el.emailDetailContainer.innerHTML = `
          <div style="padding: 24px; text-align: center;">
            <p style="color: var(--accent-coral); font-weight: 800;">${escapeHtml(err.message)}</p>
            <button class="btn-neo btn-white" id="btn-back-from-error" style="margin-top: 14px;">← Kembali</button>
          </div>
        `;
        document.getElementById('btn-back-from-error')?.addEventListener('click', closeEmailDetail);
      }
    }
  }

  // --- RENDER DETAIL EMAIL KONTEN SECARA AMAN (IN-DOM, ZERO IFRAME) ---
  function renderEmailDetailContent(msg) {
    if (!el.emailDetailContainer) return;

    const senderName = msg.from?.name || msg.from?.address || 'Pengirim';
    const senderAddress = msg.from?.address || '';
    const initial = senderName.charAt(0).toUpperCase();
    const formattedDate = new Date(msg.createdAt).toLocaleString('id-ID', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    // 1. OTP Hero Box
    let otpHtml = '';
    if (msg.detectedOtp) {
      otpHtml = `
        <div class="otp-hero-box">
          <div class="otp-left-col">
            <div class="otp-title-text">🔐 Kode Verifikasi / OTP Terdeteksi:</div>
            <div class="otp-code-display" id="detail-otp-value">${escapeHtml(msg.detectedOtp)}</div>
          </div>
          <button class="btn-copy-otp-action" id="btn-copy-otp-code">
            📋 SALIN KODE
          </button>
        </div>
      `;
    }

    // 2. Smart Action Links
    let smartLinksHtml = '';
    if (msg.smartLinks && msg.smartLinks.length > 0) {
      const linkBtns = msg.smartLinks.map(l => `
        <a href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer" class="smart-action-btn-link">
          🔗 ${escapeHtml(l.label || l.text || 'Buka Tautan')}
        </a>
      `).join('');

      smartLinksHtml = `
        <div class="smart-actions-banner">
          <div class="smart-actions-title">⚡ Tautan Cepat Terdeteksi:</div>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">${linkBtns}</div>
        </div>
      `;
    }

    // 3. Attachments
    let attachmentsHtml = '';
    if (msg.attachments && msg.attachments.length > 0) {
      const atts = msg.attachments.map(att => `
        <a href="${escapeHtml(att.downloadUrl || '#')}" target="_blank" class="attachment-chip">
          📎 ${escapeHtml(att.filename)} (${formatBytes(att.size)})
        </a>
      `).join('');

      attachmentsHtml = `
        <div class="detail-attachments-box">
          <div style="font-size: 11.5px; font-weight: 800;">Lampiran (${msg.attachments.length}):</div>
          <div style="display: flex; flex-wrap: wrap; gap: 6px;">${atts}</div>
        </div>
      `;
    }

    el.emailDetailContainer.innerHTML = `
      <div class="detail-nav-bar">
        <button class="btn-neo-small btn-white" id="btn-back-inbox">
          <span>← KEMBALI</span>
        </button>
        <div style="display: flex; gap: 6px;">
          <button class="btn-neo-small btn-white" id="btn-detail-star">
            ${msg.isStarred ? '★ BERBINTANG' : '☆ BINTANG'}
          </button>
          <button class="btn-neo-small btn-white" id="btn-detail-delete" style="color: var(--accent-coral);">
            🗑 HAPUS
          </button>
        </div>
      </div>

      <h2 class="detail-subject-header">${escapeHtml(msg.subject || '(Tanpa Subjek)')}</h2>

      <div class="detail-sender-box">
        <div class="sender-avatar-large">${initial}</div>
        <div class="sender-meta-col">
          <span class="sender-name-bold">${escapeHtml(senderName)}</span>
          <span class="sender-address-sub">&lt;${escapeHtml(senderAddress)}&gt; • ${formattedDate}</span>
        </div>
      </div>

      ${otpHtml}
      ${smartLinksHtml}

      <!-- Konten Email Body -->
      <div class="detail-body-container">
        <div class="body-tabs-bar">
          <button class="tab-body-btn ${state.activeDetailTab === 'html' ? 'active' : ''}" id="tab-html-btn">Tampilan HTML</button>
          <button class="tab-body-btn ${state.activeDetailTab === 'text' ? 'active' : ''}" id="tab-text-btn">Teks Polos</button>
        </div>
        <div class="detail-rendered-content" id="detail-body-content">
          <!-- Injeksi Sanitized Content -->
        </div>
      </div>

      ${attachmentsHtml}
    `;

    // Render body pertama kali
    updateDetailBodyRender(msg);

    // Event tombol kembali
    document.getElementById('btn-back-inbox')?.addEventListener('click', closeEmailDetail);

    // Event Star
    document.getElementById('btn-detail-star')?.addEventListener('click', async () => {
      await toggleStar(msg.id, !msg.isStarred);
      msg.isStarred = !msg.isStarred;
      const starBtn = document.getElementById('btn-detail-star');
      if (starBtn) starBtn.innerHTML = msg.isStarred ? '★ BERBINTANG' : '☆ BINTANG';
    });

    // Event Delete
    document.getElementById('btn-detail-delete')?.addEventListener('click', async () => {
      await deleteMessage(msg.id);
      closeEmailDetail();
    });

    // Event Copy OTP
    const copyOtpBtn = document.getElementById('btn-copy-otp-code');
    if (copyOtpBtn && msg.detectedOtp) {
      copyOtpBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(msg.detectedOtp);
        copyOtpBtn.textContent = '✅ DISALIN!';
        showToast(`Kode OTP ${msg.detectedOtp} disalin!`, '🔐');
        setTimeout(() => copyOtpBtn.textContent = '📋 SALIN KODE', 1800);
      });
    }

    // Event Tabs HTML / Text
    document.getElementById('tab-html-btn')?.addEventListener('click', () => {
      state.activeDetailTab = 'html';
      document.getElementById('tab-html-btn').classList.add('active');
      document.getElementById('tab-text-btn').classList.remove('active');
      updateDetailBodyRender(msg);
    });

    document.getElementById('tab-text-btn')?.addEventListener('click', () => {
      state.activeDetailTab = 'text';
      document.getElementById('tab-text-btn').classList.add('active');
      document.getElementById('tab-html-btn').classList.remove('active');
      updateDetailBodyRender(msg);
    });
  }

  // --- RENDER ISI EMAIL (AMAN & SANITIZED) ---
  function updateDetailBodyRender(msg) {
    const box = document.getElementById('detail-body-content');
    if (!box) return;

    if (state.activeDetailTab === 'html' && msg.html) {
      const cleanHtml = sanitizeHtmlContent(msg.html);
      box.innerHTML = cleanHtml;
    } else {
      const text = msg.text || msg.intro || '(Tidak ada isi teks)';
      box.innerHTML = `<pre style="white-space: pre-wrap; font-family: inherit; font-size: 13px;">${escapeHtml(text)}</pre>`;
    }
  }

  // --- HTML SANITIZER UNTUK EMAIL ---
  function sanitizeHtmlContent(rawHtml) {
    if (!rawHtml) return '';
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(rawHtml, 'text/html');

      // Hapus elemen berbahaya & iframe
      const forbidden = ['script', 'noscript', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button'];
      forbidden.forEach(tag => {
        doc.querySelectorAll(tag).forEach(el => el.remove());
      });

      // Bersihkan attribute
      doc.querySelectorAll('*').forEach(el => {
        Array.from(el.attributes).forEach(attr => {
          const name = attr.name.toLowerCase();
          const val = attr.value || '';
          if (name.startsWith('on') || name === 'srcdoc') {
            el.removeAttribute(attr.name);
          }
          if ((name === 'href' || name === 'src') && val.trim().toLowerCase().startsWith('javascript:')) {
            el.removeAttribute(attr.name);
          }
        });

        if (el.tagName.toLowerCase() === 'a') {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
        if (el.tagName.toLowerCase() === 'img') {
          el.setAttribute('loading', 'lazy');
          el.setAttribute('referrerpolicy', 'no-referrer');
        }
      });

      return doc.body.innerHTML;
    } catch (e) {
      return escapeHtml(rawHtml);
    }
  }

  // --- KEMBALI DARI DETAIL VIEW ---
  function closeEmailDetail() {
    state.selectedMessageId = null;
    state.selectedMessageDetail = null;
    if (el.emailDetailContainer) el.emailDetailContainer.style.display = 'none';
    renderEmailList();
  }

  // --- TOGGLE STAR EMAIL ---
  async function toggleStar(messageId, isStarred) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (state.mailbox?.id) headers['x-mailbox-id'] = state.mailbox.id;

      await fetch(`/api/messages/${encodeURIComponent(messageId)}/star`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ isStarred })
      });

      const item = state.messages.find(m => m.id === messageId);
      if (item) item.isStarred = isStarred;
      renderEmailList();
      showToast(isStarred ? 'Email diberi bintang ⭐' : 'Bintang dihapus', '⭐', 1500);
    } catch (e) {
      console.error(e);
    }
  }

  // --- HAPUS EMAIL ---
  async function deleteMessage(messageId) {
    try {
      const headers = {};
      if (state.mailbox?.id) headers['x-mailbox-id'] = state.mailbox.id;

      await fetch(`/api/messages/${encodeURIComponent(messageId)}`, {
        method: 'DELETE',
        headers
      });

      state.messages = state.messages.filter(m => m.id !== messageId);
      renderEmailList();
      showToast('Email dihapus.', '🗑');
    } catch (e) {
      console.error(e);
    }
  }

  // --- MODAL: BUAT EMAIL KUSTOM & ADD DOMAIN ---
  function openCustomDomainModal() {
    if (el.modalCustomDomain) el.modalCustomDomain.classList.add('active');
    if (el.inputCustomUsername) el.inputCustomUsername.value = '';
  }

  async function handleCustomMailboxSubmit() {
    const username = el.inputCustomUsername?.value.trim();
    const domain = el.selectDomain?.value;

    if (!username || username.length < 3) {
      showToast('Username minimal 3 karakter', '⚠️');
      return;
    }

    if (el.btnSubmitCreateMailbox) {
      el.btnSubmitCreateMailbox.disabled = true;
      el.btnSubmitCreateMailbox.textContent = 'MEMBUAT...';
    }

    try {
      const res = await fetch('/api/mailbox/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'custom', username, domain })
      });
      const data = await res.json();

      if (data.success && data.mailbox) {
        state.mailbox = data.mailbox;
        localStorage.setItem('tempemail_active_id', data.mailbox.id);
        updateMailboxUI();
        el.modalCustomDomain.classList.remove('active');
        showToast(`Email baru aktif: ${data.mailbox.email}`, '🎉', 4000);
        await fetchMessages(false, true);
      } else {
        showToast(data.error || 'Gagal membuat email', '⚠️');
      }
    } catch (err) {
      showToast('Terjadi kesalahan jaringan', '⚠️');
    } finally {
      if (el.btnSubmitCreateMailbox) {
        el.btnSubmitCreateMailbox.disabled = false;
        el.btnSubmitCreateMailbox.textContent = 'BUAT EMAIL INI';
      }
    }
  }

  async function handleRandomMailboxSubmit() {
    if (el.btnRandomCreateMailbox) {
      el.btnRandomCreateMailbox.disabled = true;
      el.btnRandomCreateMailbox.textContent = 'MEMBUAT...';
    }

    try {
      const res = await fetch('/api/mailbox/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'auto' })
      });
      const data = await res.json();

      if (data.success && data.mailbox) {
        state.mailbox = data.mailbox;
        localStorage.setItem('tempemail_active_id', data.mailbox.id);
        updateMailboxUI();
        el.modalCustomDomain.classList.remove('active');
        showToast(`Email acak aktif: ${data.mailbox.email}`, '🎉', 4000);
        await fetchMessages(false, true);
      } else {
        showToast(data.error || 'Gagal membuat email acak', '⚠️');
      }
    } catch (err) {
      showToast('Koneksi gagal', '⚠️');
    } finally {
      if (el.btnRandomCreateMailbox) {
        el.btnRandomCreateMailbox.disabled = false;
        el.btnRandomCreateMailbox.textContent = '🎲 BUAT ACAK OTOMATIS';
      }
    }
  }

  // --- MODAL: KELOLA BANYAK MAILBOX ---
  async function openManageMailboxModal() {
    if (el.modalManageMailbox) el.modalManageMailbox.classList.add('active');
    if (!el.mailboxesContainer) return;

    el.mailboxesContainer.innerHTML = '<p style="text-align: center; padding: 16px; font-weight: 700;">Memuat daftar akun...</p>';

    try {
      const res = await fetch('/api/mailbox/list');
      const data = await res.json();

      if (data.success && data.mailboxes) {
        state.mailboxesList = data.mailboxes;
        el.mailboxesContainer.innerHTML = '';

        if (data.mailboxes.length === 0) {
          el.mailboxesContainer.innerHTML = '<p style="text-align: center; color: var(--text-tertiary); padding: 16px;">Belum ada akun lain.</p>';
          return;
        }

        data.mailboxes.forEach(m => {
          const isActive = state.mailbox?.id === m.id;
          const card = document.createElement('div');
          card.className = `mailbox-list-card ${isActive ? 'active' : ''}`;
          card.innerHTML = `
            <div style="min-width: 0;">
              <div style="font-family: var(--font-mono); font-weight: 800; font-size: 13px; word-break: break-all;">${escapeHtml(m.email)}</div>
              <div style="font-size: 11px; color: var(--text-tertiary); margin-top: 2px;">${isActive ? '🟢 Sedang Aktif' : 'Tersimpan'}</div>
            </div>
            <div style="display: flex; gap: 6px; flex-shrink: 0; margin-left: 8px;">
              ${!isActive ? `<button class="btn-neo-small btn-cyan btn-switch-mb" data-id="${m.id}">GANTI</button>` : ''}
              <button class="btn-neo-small btn-white btn-del-mb" data-id="${m.id}" style="color: var(--accent-coral);">HAPUS</button>
            </div>
          `;

          card.querySelector('.btn-switch-mb')?.addEventListener('click', () => switchMailbox(m.id));
          card.querySelector('.btn-del-mb')?.addEventListener('click', () => deleteMailbox(m.id));

          el.mailboxesContainer.appendChild(card);
        });
      }
    } catch (e) {
      el.mailboxesContainer.innerHTML = '<p style="color: var(--accent-coral); text-align: center;">Gagal memuat.</p>';
    }
  }

  async function switchMailbox(id) {
    try {
      const res = await fetch('/api/mailbox/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      const data = await res.json();
      if (data.success && data.mailbox) {
        state.mailbox = data.mailbox;
        localStorage.setItem('tempemail_active_id', data.mailbox.id);
        updateMailboxUI();
        el.modalManageMailbox?.classList.remove('active');
        showToast(`Beralih ke: ${data.mailbox.email}`, '🔄');
        await fetchMessages(false, true);
      }
    } catch (e) {
      showToast('Gagal beralih akun', '⚠️');
    }
  }

  async function deleteMailbox(id) {
    if (!confirm('Yakin ingin menghapus mailbox ini?')) return;
    try {
      await fetch(`/api/mailbox/${id}`, { method: 'DELETE' });
      showToast('Mailbox dihapus.', '🗑');
      if (state.mailbox?.id === id) {
        await loadCurrentMailbox();
        await fetchMessages(false, true);
      }
      openManageMailboxModal();
    } catch (e) {
      showToast('Gagal menghapus mailbox', '⚠️');
    }
  }

  // --- AUTO REFRESH COUNTDOWN TIMER ---
  function startCountdown() {
    if (state.countdownInterval) clearInterval(state.countdownInterval);
    state.refreshCountdown = 10;

    state.countdownInterval = setInterval(() => {
      state.refreshCountdown--;
      if (el.refreshCountdown) {
        el.refreshCountdown.textContent = `${state.refreshCountdown} DETIK`;
      }
      if (state.refreshCountdown <= 0) {
        state.refreshCountdown = 10;
        fetchMessages(true, false);
      }
    }, 1000);
  }

  // --- AUDIO BEEP NOTIFIKASI ---
  function playBeep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    } catch (e) {}
  }

  // --- HELPER FORMAT WAKTU & TEXT ---
  function formatEmailTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
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

  // Jalankan saat DOM siap
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
