/**
 * Gallery App — Client-side application
 */
(function () {
  'use strict';

  // ===== State =====
  let currentPage = 1;
  let currentFilter = 'all';
  let isLoading = false;
  let hasMore = true;
  let allItems = [];
  let lightboxIndex = -1;

  // ===== DOM Elements =====
  const gallery = document.getElementById('gallery');
  const loader = document.getElementById('loader');
  const emptyState = document.getElementById('empty-state');
  const statsBadge = document.getElementById('stats-badge');
  const scanBtn = document.getElementById('scan-btn');
  const scanOverlay = document.getElementById('scan-overlay');
  const lightbox = document.getElementById('lightbox');
  const lightboxMedia = document.getElementById('lightbox-media');
  const lightboxName = document.getElementById('lightbox-name');
  const lightboxMeta = document.getElementById('lightbox-meta');
  const lightboxClose = document.getElementById('lightbox-close');
  const lightboxPrev = document.getElementById('lightbox-prev');
  const lightboxNext = document.getElementById('lightbox-next');
  const lightboxCounter = document.getElementById('lightbox-counter');
  const filterTabs = document.querySelectorAll('.filter-tab');

  // ===== Initialize =====
  async function init() {
    loadStats();
    loadMedia();
    setupInfiniteScroll();
    setupFilterTabs();
    setupLightbox();
    setupScanButton();
  }

  // ===== API Helpers =====
  async function api(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ===== Load Stats =====
  async function loadStats() {
    try {
      const stats = await api('/api/stats');
      if (stats.total === 0) {
        statsBadge.textContent = 'Scanning...';
        // Poll until scan completes
        pollForMedia();
      } else {
        const parts = [];
        if (stats.photos > 0) parts.push(`${formatNumber(stats.photos)} photos`);
        if (stats.videos > 0) parts.push(`${formatNumber(stats.videos)} videos`);
        statsBadge.textContent = parts.join(' · ') + ` · ${stats.totalSizeHuman}`;
      }
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  }

  async function pollForMedia() {
    try {
      const stats = await api('/api/stats');
      if (stats.total > 0) {
        loadStats();
        resetAndLoad();
        return;
      }
    } catch (_) {}
    setTimeout(pollForMedia, 3000);
  }

  // ===== Load Media =====
  async function loadMedia() {
    if (isLoading || !hasMore) return;
    isLoading = true;
    loader.classList.remove('hidden');

    try {
      const data = await api(`/api/media?page=${currentPage}&limit=60&type=${currentFilter}`);

      if (data.items.length === 0 && currentPage === 1) {
        emptyState.classList.remove('hidden');
        gallery.classList.add('hidden');
      } else {
        emptyState.classList.add('hidden');
        gallery.classList.remove('hidden');
        appendItems(data.items);
        hasMore = data.hasMore;
        currentPage++;
      }
    } catch (err) {
      console.error('Failed to load media:', err);
    } finally {
      isLoading = false;
      loader.classList.toggle('hidden', !hasMore);
    }
  }

  // ===== Render Items =====
  function appendItems(items) {
    const fragment = document.createDocumentFragment();
    const startIndex = allItems.length;

    items.forEach((item, i) => {
      allItems.push(item);

      const el = document.createElement('div');
      el.className = 'gallery-item skeleton';
      el.dataset.index = startIndex + i;
      el.style.animationDelay = `${(i % 6) * 40}ms`;

      // Create image
      const img = document.createElement('img');
      img.alt = item.name;
      img.loading = 'lazy';
      img.dataset.src = item.thumbUrl;

      img.onload = () => {
        img.classList.add('loaded');
        el.classList.remove('skeleton');
      };

      img.onerror = () => {
        el.classList.remove('skeleton');
        el.style.background = 'var(--bg-card)';
      };

      el.appendChild(img);

      // Video badge
      if (item.type === 'video') {
        const badge = document.createElement('div');
        badge.className = 'video-badge';
        badge.innerHTML = `
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          ${item.durationHuman || ''}
        `;
        el.appendChild(badge);
      }

      // Click handler
      el.addEventListener('click', () => openLightbox(startIndex + i));

      fragment.appendChild(el);
    });

    gallery.appendChild(fragment);

    // Start observing new images for lazy loading
    observeImages();
  }

  // ===== Lazy Loading with IntersectionObserver =====
  const imageObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        if (img.dataset.src) {
          img.src = img.dataset.src;
          delete img.dataset.src;
          imageObserver.unobserve(img);
        }
      }
    });
  }, {
    rootMargin: '200px',
  });

  function observeImages() {
    gallery.querySelectorAll('img[data-src]').forEach(img => {
      imageObserver.observe(img);
    });
  }

  // ===== Infinite Scroll =====
  function setupInfiniteScroll() {
    const scrollObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        loadMedia();
      }
    }, {
      rootMargin: '600px',
    });
    scrollObserver.observe(loader);
  }

  // ===== Filter Tabs =====
  function setupFilterTabs() {
    filterTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const filter = tab.dataset.filter;
        if (filter === currentFilter) return;

        filterTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentFilter = filter;
        resetAndLoad();
      });
    });
  }

  function resetAndLoad() {
    currentPage = 1;
    hasMore = true;
    allItems = [];
    gallery.innerHTML = '';
    loadMedia();
    loadStats();
  }

  // ===== Lightbox =====
  function setupLightbox() {
    lightboxClose.addEventListener('click', closeLightbox);
    lightboxPrev.addEventListener('click', (e) => { e.stopPropagation(); navigateLightbox(-1); });
    lightboxNext.addEventListener('click', (e) => { e.stopPropagation(); navigateLightbox(1); });

    // Click backdrop to close
    lightbox.querySelector('.lightbox-backdrop').addEventListener('click', closeLightbox);

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      if (lightbox.classList.contains('hidden')) return;
      switch (e.key) {
        case 'Escape': closeLightbox(); break;
        case 'ArrowLeft': navigateLightbox(-1); break;
        case 'ArrowRight': navigateLightbox(1); break;
      }
    });

    // Touch swipe
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;

    lightboxMedia.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
    }, { passive: true });

    lightboxMedia.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      const dt = Date.now() - touchStartTime;

      // Must be a quick swipe, mostly horizontal
      if (dt < 400 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx > 0) navigateLightbox(-1);
        else navigateLightbox(1);
      }
    }, { passive: true });
  }

  function openLightbox(index) {
    lightboxIndex = index;
    renderLightboxItem(index);
    lightbox.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightbox.classList.add('hidden');
    document.body.style.overflow = '';

    // Pause any video
    const video = lightboxMedia.querySelector('video');
    if (video) video.pause();
    lightboxIndex = -1;
  }

  function navigateLightbox(direction) {
    const newIndex = lightboxIndex + direction;
    if (newIndex < 0 || newIndex >= allItems.length) return;

    // Pause current video before navigating
    const video = lightboxMedia.querySelector('video');
    if (video) video.pause();

    lightboxIndex = newIndex;
    renderLightboxItem(newIndex);

    // Load more if near the end
    if (newIndex >= allItems.length - 10 && hasMore) {
      loadMedia();
    }
  }

  function renderLightboxItem(index) {
    const item = allItems[index];
    if (!item) return;

    lightboxCounter.textContent = `${index + 1} / ${allItems.length}`;
    lightboxName.textContent = item.name;

    const dateParts = [];
    if (item.date) {
      dateParts.push(formatDate(item.date));
    }
    if (item.sizeHuman) {
      dateParts.push(item.sizeHuman);
    }
    if (item.durationHuman) {
      dateParts.push(item.durationHuman);
    }
    lightboxMeta.textContent = dateParts.join(' · ');

    // Show/hide nav buttons
    lightboxPrev.style.visibility = index > 0 ? 'visible' : 'hidden';
    lightboxNext.style.visibility = index < allItems.length - 1 ? 'visible' : 'hidden';

    if (item.type === 'video') {
      lightboxMedia.innerHTML = `
        <video controls playsinline preload="metadata" autoplay>
          <source src="${item.videoUrl}" type="video/mp4">
          Your browser does not support video playback.
        </video>
      `;
    } else {
      lightboxMedia.innerHTML = `<div class="lightbox-loading"></div>`;
      const img = document.createElement('img');
      img.alt = item.name;
      img.onload = () => {
        lightboxMedia.innerHTML = '';
        img.classList.add('loaded');
        lightboxMedia.appendChild(img);
      };
      img.onerror = () => {
        lightboxMedia.innerHTML = '<p style="color: var(--text-muted)">Failed to load image</p>';
      };
      // Load preview first, then can switch to full if desired
      img.src = item.previewUrl || item.thumbUrl;
    }
  }

  // ===== Scan =====
  function setupScanButton() {
    scanBtn.addEventListener('click', triggerScan);
  }

  window.triggerScan = async function () {
    scanBtn.classList.add('scanning');
    scanOverlay.classList.remove('hidden');

    try {
      await fetch('/api/scan', { method: 'POST' });
      // Wait for scan to complete by polling stats
      const poll = setInterval(async () => {
        try {
          const stats = await api('/api/stats');
          if (!stats.scanInProgress) {
            clearInterval(poll);
            scanBtn.classList.remove('scanning');
            scanOverlay.classList.add('hidden');
            resetAndLoad();
          }
        } catch (_) {}
      }, 2000);
    } catch (err) {
      console.error('Scan failed:', err);
      scanBtn.classList.remove('scanning');
      scanOverlay.classList.add('hidden');
    }
  };

  // ===== Helpers =====
  function formatNumber(n) {
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return n.toString();
  }

  function formatDate(dateStr) {
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch (_) {
      return dateStr;
    }
  }

  // ===== Start =====
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
