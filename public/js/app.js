/**
 * Gallery v2 — Client Application
 * Premium mobile-first gallery with tabs: Photos, People, Timeline, Places
 */
(function () {
  'use strict';

  // ═══════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════
  const state = {
    // Photos
    currentPage: 1,
    currentFilter: 'all',
    isLoading: false,
    hasMore: true,
    allItems: [],

    // Lightbox
    lightboxIndex: -1,
    lightboxItems: null, // null = use allItems, otherwise custom list

    // Navigation
    activeTab: 'photos',

    // People
    people: [],
    personDetail: null,
    personPage: 1,
    personHasMore: true,
    personItems: [],

    // Timeline
    timelineMode: 'month',
    timelineData: null,
    continuousPage: 1,
    continuousHasMore: true,
    continuousItems: [],

    // Places
    placesData: null,
    placeDetail: null,
    placeItems: [],

    // AI
    aiStatus: null,
  };

  // ═══════════════════════════════════════════
  // DOM CACHE
  // ═══════════════════════════════════════════
  const $ = id => document.getElementById(id);
  const el = {
    gallery: $('gallery'),
    loader: $('loader'),
    emptyState: $('empty-state'),
    statsBadge: $('stats-badge'),
    scanBtn: $('scan-btn'),
    scanOverlay: $('scan-overlay'),
    // Lightbox
    lightbox: $('lightbox'),
    lightboxMedia: $('lightbox-media'),
    lightboxClose: $('lightbox-close'),
    lightboxPrev: $('lightbox-prev'),
    lightboxNext: $('lightbox-next'),
    lightboxCounter: $('lightbox-counter'),
    lightboxDetail: $('lightbox-detail'),
    detailFilename: $('detail-filename'),
    detailDate: $('detail-date'),
    detailSize: $('detail-size'),
    detailDimensions: $('detail-dimensions'),
    detailLocation: $('detail-location'),
    detailFaces: $('detail-faces'),
    // Tabs
    tabBar: $('tab-bar'),
    // People
    peopleGrid: $('people-grid'),
    peopleCount: $('people-count'),
    peopleEmpty: $('people-empty'),
    personDetail: $('person-detail'),
    personBackBtn: $('person-back-btn'),
    personDetailName: $('person-detail-name'),
    personDetailCount: $('person-detail-count'),
    personDetailGrid: $('person-detail-grid'),
    // Timeline
    timelineModeSlider: $('timeline-mode-slider'),
    modeIndicator: $('mode-indicator'),
    timelineContent: $('timeline-content'),
    timelineLoader: $('timeline-loader'),
    // Places
    placesGrid: $('places-grid'),
    placesCount: $('places-count'),
    placesEmpty: $('places-empty'),
    placeDetail: $('place-detail'),
    placeBackBtn: $('place-back-btn'),
    placeDetailName: $('place-detail-name'),
    placeDetailCount: $('place-detail-count'),
    placeDetailGrid: $('place-detail-grid'),
    // AI
    aiProgressBar: $('ai-progress-bar'),
    aiProgressFill: $('ai-progress-fill'),
  };

  // ═══════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════
  function init() {
    loadStats();
    loadMedia();
    setupInfiniteScroll();
    setupFilterTabs();
    setupLightbox();
    setupScanButton();
    setupTabNavigation();
    setupTimelineModeSlider();
    setupPeopleView();
    setupPlacesView();
    pollAiStatus();
  }

  // ═══════════════════════════════════════════
  // API
  // ═══════════════════════════════════════════
  async function api(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ═══════════════════════════════════════════
  // STATS
  // ═══════════════════════════════════════════
  async function loadStats() {
    try {
      const stats = await api('/api/stats');
      if (stats.total === 0) {
        el.statsBadge.textContent = 'Scanning...';
        pollForMedia();
      } else {
        const parts = [];
        if (stats.photos > 0) parts.push(`${fmtNum(stats.photos)} photos`);
        if (stats.videos > 0) parts.push(`${fmtNum(stats.videos)} videos`);
        el.statsBadge.textContent = parts.join(' · ') + ` · ${stats.totalSizeHuman}`;
      }
    } catch (err) {
      console.error('Stats:', err);
    }
  }

  async function pollForMedia() {
    try {
      const stats = await api('/api/stats');
      if (stats.total > 0) { loadStats(); resetAndLoadPhotos(); return; }
    } catch (_) {}
    setTimeout(pollForMedia, 3000);
  }

  // ═══════════════════════════════════════════
  // TAB NAVIGATION
  // ═══════════════════════════════════════════
  function setupTabNavigation() {
    el.tabBar.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });
  }

  function switchTab(tabName) {
    if (state.activeTab === tabName) return;
    state.activeTab = tabName;

    // Update tab buttons
    el.tabBar.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));

    // Update views
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.dataset.view === tabName));

    // Load data for the tab if needed
    if (tabName === 'people') loadPeople();
    else if (tabName === 'timeline') loadTimeline();
    else if (tabName === 'places') loadPlaces();
  }

  // ═══════════════════════════════════════════
  // PHOTOS VIEW
  // ═══════════════════════════════════════════
  async function loadMedia() {
    if (state.isLoading || !state.hasMore) return;
    state.isLoading = true;
    el.loader.classList.remove('hidden');

    try {
      const data = await api(`/api/media?page=${state.currentPage}&limit=60&type=${state.currentFilter}`);

      if (data.items.length === 0 && state.currentPage === 1) {
        el.emptyState.classList.remove('hidden');
        el.gallery.classList.add('hidden');
      } else {
        el.emptyState.classList.add('hidden');
        el.gallery.classList.remove('hidden');
        appendGalleryItems(data.items, el.gallery, state.allItems);
        state.hasMore = data.hasMore;
        state.currentPage++;
      }
    } catch (err) {
      console.error('Media:', err);
    } finally {
      state.isLoading = false;
      el.loader.classList.toggle('hidden', !state.hasMore);
    }
  }

  function appendGalleryItems(items, container, itemList, clickHandler) {
    const fragment = document.createDocumentFragment();
    const startIndex = itemList.length;

    items.forEach((item, i) => {
      itemList.push(item);
      const el = createGalleryItem(item, startIndex + i, clickHandler);
      el.style.animationDelay = `${(i % 6) * 40}ms`;
      fragment.appendChild(el);
    });

    container.appendChild(fragment);
    observeImages(container);
  }

  function createGalleryItem(item, index, clickHandler) {
    const div = document.createElement('div');
    div.className = 'gallery-item skeleton';
    div.dataset.index = index;

    const img = document.createElement('img');
    img.alt = item.name;
    img.loading = 'lazy';
    img.dataset.src = item.thumbUrl;
    img.onload = () => { img.classList.add('loaded'); div.classList.remove('skeleton'); };
    img.onerror = () => { div.classList.remove('skeleton'); div.style.background = 'var(--bg-card)'; };
    div.appendChild(img);

    if (item.type === 'video') {
      const badge = document.createElement('div');
      badge.className = 'video-badge';
      badge.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> ${item.durationHuman || ''}`;
      div.appendChild(badge);
    }

    div.addEventListener('click', () => {
      if (clickHandler) clickHandler(index);
      else openLightbox(index);
    });

    return div;
  }

  // Lazy loading
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
  }, { rootMargin: '300px' });

  function observeImages(container) {
    (container || document).querySelectorAll('img[data-src]').forEach(img => imageObserver.observe(img));
  }

  // Infinite scroll
  function setupInfiniteScroll() {
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && state.activeTab === 'photos') loadMedia();
    }, { rootMargin: '600px' });
    obs.observe(el.loader);
  }

  // Filter tabs
  function setupFilterTabs() {
    document.querySelectorAll('.filter-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const filter = tab.dataset.filter;
        if (filter === state.currentFilter) return;
        document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        state.currentFilter = filter;
        resetAndLoadPhotos();
      });
    });
  }

  function resetAndLoadPhotos() {
    state.currentPage = 1;
    state.hasMore = true;
    state.allItems = [];
    el.gallery.innerHTML = '';
    loadMedia();
    loadStats();
  }

  // ═══════════════════════════════════════════
  // LIGHTBOX
  // ═══════════════════════════════════════════
  function setupLightbox() {
    el.lightboxClose.addEventListener('click', closeLightbox);
    el.lightboxPrev.addEventListener('click', (e) => { e.stopPropagation(); navigateLightbox(-1); });
    el.lightboxNext.addEventListener('click', (e) => { e.stopPropagation(); navigateLightbox(1); });
    el.lightbox.querySelector('.lightbox-backdrop').addEventListener('click', closeLightbox);

    document.addEventListener('keydown', (e) => {
      if (el.lightbox.classList.contains('hidden')) return;
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') navigateLightbox(-1);
      else if (e.key === 'ArrowRight') navigateLightbox(1);
    });

    // Touch swipe
    let sx = 0, sy = 0, st = 0;
    el.lightboxMedia.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now(); }, { passive: true });
    el.lightboxMedia.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - sx;
      const dy = e.changedTouches[0].clientY - sy;
      const dt = Date.now() - st;
      if (dt < 400 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        dx > 0 ? navigateLightbox(-1) : navigateLightbox(1);
      }
    }, { passive: true });
  }

  function openLightbox(index, items) {
    state.lightboxIndex = index;
    state.lightboxItems = items || null;
    renderLightboxItem(index);
    el.lightbox.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    el.lightbox.classList.add('hidden');
    document.body.style.overflow = '';
    const video = el.lightboxMedia.querySelector('video');
    if (video) video.pause();
    state.lightboxIndex = -1;
    state.lightboxItems = null;
  }

  function navigateLightbox(dir) {
    const items = state.lightboxItems || state.allItems;
    const newIndex = state.lightboxIndex + dir;
    if (newIndex < 0 || newIndex >= items.length) return;
    const video = el.lightboxMedia.querySelector('video');
    if (video) video.pause();
    state.lightboxIndex = newIndex;
    renderLightboxItem(newIndex);
    if (newIndex >= items.length - 10 && state.hasMore && !state.lightboxItems) loadMedia();
  }

  function renderLightboxItem(index) {
    const items = state.lightboxItems || state.allItems;
    const item = items[index];
    if (!item) return;

    el.lightboxCounter.textContent = `${index + 1} / ${items.length}`;
    el.lightboxPrev.style.visibility = index > 0 ? 'visible' : 'hidden';
    el.lightboxNext.style.visibility = index < items.length - 1 ? 'visible' : 'hidden';

    // Detail panel
    el.detailFilename.textContent = item.name;
    el.detailDate.textContent = item.date ? `📅 ${fmtDate(item.date)}` : '';
    el.detailSize.textContent = item.sizeHuman ? `💾 ${item.sizeHuman}${item.durationHuman ? ' · ' + item.durationHuman : ''}` : '';
    el.detailDimensions.textContent = item.width && item.height ? `📐 ${item.width} × ${item.height}` : '';
    el.detailLocation.textContent = item.latitude && item.longitude ? `📍 ${item.latitude.toFixed(4)}, ${item.longitude.toFixed(4)}` : '';
    el.detailFaces.textContent = '';

    if (item.type === 'video') {
      el.lightboxMedia.innerHTML = `
        <video controls playsinline preload="metadata" autoplay>
          <source src="${item.videoUrl}" type="video/mp4">
        </video>`;
    } else {
      el.lightboxMedia.innerHTML = '<div class="lightbox-loading"></div>';
      const img = document.createElement('img');
      img.alt = item.name;
      img.onload = () => { el.lightboxMedia.innerHTML = ''; img.classList.add('loaded'); el.lightboxMedia.appendChild(img); };
      img.onerror = () => { el.lightboxMedia.innerHTML = '<p style="color:var(--text-muted)">Failed to load</p>'; };
      img.src = item.previewUrl || item.thumbUrl;
    }
  }

  // ═══════════════════════════════════════════
  // SCAN
  // ═══════════════════════════════════════════
  function setupScanButton() {
    el.scanBtn.addEventListener('click', triggerScan);
  }

  async function triggerScan() {
    el.scanBtn.classList.add('scanning');
    el.scanOverlay.classList.remove('hidden');
    try {
      await fetch('/api/scan', { method: 'POST' });
      const poll = setInterval(async () => {
        try {
          const stats = await api('/api/stats');
          if (!stats.scanInProgress) {
            clearInterval(poll);
            el.scanBtn.classList.remove('scanning');
            el.scanOverlay.classList.add('hidden');
            resetAndLoadPhotos();
          }
        } catch (_) {}
      }, 2000);
    } catch (err) {
      console.error('Scan:', err);
      el.scanBtn.classList.remove('scanning');
      el.scanOverlay.classList.add('hidden');
    }
  }

  // ═══════════════════════════════════════════
  // PEOPLE VIEW
  // ═══════════════════════════════════════════
  function setupPeopleView() {
    el.personBackBtn.addEventListener('click', closePeopleDetail);
    el.personDetailName.addEventListener('blur', savePeopleNameEdit);
    el.personDetailName.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); el.personDetailName.blur(); } });
  }

  async function loadPeople() {
    try {
      const people = await api('/api/people');
      state.people = people;

      if (people.length === 0) {
        el.peopleGrid.classList.add('hidden');
        el.peopleEmpty.classList.remove('hidden');
        el.peopleCount.textContent = '';
      } else {
        el.peopleEmpty.classList.add('hidden');
        el.peopleGrid.classList.remove('hidden');
        el.peopleCount.textContent = `${people.length} people`;
        renderPeopleGrid(people);
      }
    } catch (err) {
      console.error('People:', err);
    }
  }

  function renderPeopleGrid(people) {
    el.peopleGrid.innerHTML = '';
    const fragment = document.createDocumentFragment();

    people.forEach((person, i) => {
      const card = document.createElement('div');
      card.className = 'person-card';
      card.style.animationDelay = `${i * 50}ms`;

      const avatar = document.createElement('img');
      avatar.className = 'person-avatar';
      avatar.alt = person.name || 'Unknown';
      avatar.loading = 'lazy';
      avatar.src = person.avatarUrl || person.thumbUrl || '';
      avatar.onerror = () => { avatar.style.background = 'var(--accent-soft)'; };
      card.appendChild(avatar);

      const name = document.createElement('div');
      name.className = 'person-name';
      name.textContent = person.name || `Person ${person.id}`;
      card.appendChild(name);

      const count = document.createElement('div');
      count.className = 'person-count';
      count.textContent = `${person.faceCount} photos`;
      card.appendChild(count);

      card.addEventListener('click', () => openPersonDetail(person));
      fragment.appendChild(card);
    });

    el.peopleGrid.appendChild(fragment);
  }

  async function openPersonDetail(person) {
    state.personDetail = person;
    state.personPage = 1;
    state.personHasMore = true;
    state.personItems = [];

    el.personDetailName.textContent = person.name || `Person ${person.id}`;
    el.personDetailGrid.innerHTML = '';
    el.personDetail.classList.remove('hidden');
    el.peopleGrid.parentElement.querySelector('.view-header').style.display = 'none';
    el.peopleGrid.style.display = 'none';

    await loadPersonMedia();
  }

  async function loadPersonMedia() {
    try {
      const data = await api(`/api/people/${state.personDetail.id}/media?page=${state.personPage}&limit=60`);
      el.personDetailCount.textContent = `${data.total} photos`;
      appendGalleryItems(data.items, el.personDetailGrid, state.personItems, (idx) => openLightbox(idx, state.personItems));
      state.personHasMore = data.hasMore;
      state.personPage++;
    } catch (err) {
      console.error('Person media:', err);
    }
  }

  function closePeopleDetail() {
    el.personDetail.classList.add('hidden');
    el.peopleGrid.parentElement.querySelector('.view-header').style.display = '';
    el.peopleGrid.style.display = '';
  }

  async function savePeopleNameEdit() {
    if (!state.personDetail) return;
    const newName = el.personDetailName.textContent.trim();
    if (newName === state.personDetail.name) return;
    try {
      await api(`/api/people/${state.personDetail.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName || null }),
      });
      state.personDetail.name = newName || null;
    } catch (err) {
      console.error('Rename:', err);
    }
  }

  // ═══════════════════════════════════════════
  // TIMELINE VIEW
  // ═══════════════════════════════════════════
  function setupTimelineModeSlider() {
    const buttons = el.timelineModeSlider.querySelectorAll('.mode-btn');
    updateModeIndicator();

    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (mode === state.timelineMode) return;

        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.timelineMode = mode;
        state.continuousPage = 1;
        state.continuousHasMore = true;
        state.continuousItems = [];
        updateModeIndicator();
        loadTimeline();
      });
    });

    // Continuous timeline infinite scroll
    window.addEventListener('scroll', () => {
      if (state.activeTab !== 'timeline' || state.timelineMode !== 'continuous') return;
      if (state.isLoading || !state.continuousHasMore) return;
      if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 800) {
        loadTimelineContinuous();
      }
    });
  }

  function updateModeIndicator() {
    const activeBtn = el.timelineModeSlider.querySelector('.mode-btn.active');
    if (activeBtn && el.modeIndicator) {
      el.modeIndicator.style.width = `${activeBtn.offsetWidth}px`;
      el.modeIndicator.style.left = `${activeBtn.offsetLeft}px`;
    }
  }

  async function loadTimeline() {
    el.timelineContent.innerHTML = '';

    if (state.timelineMode === 'continuous') {
      state.continuousPage = 1;
      state.continuousHasMore = true;
      state.continuousItems = [];
      await loadTimelineContinuous();
    } else {
      try {
        const data = await api(`/api/timeline?mode=${state.timelineMode}`);
        state.timelineData = data;
        renderTimeline(data);
      } catch (err) {
        console.error('Timeline:', err);
      }
    }
  }

  function renderTimeline(data) {
    el.timelineContent.innerHTML = '';
    const fragment = document.createDocumentFragment();

    if (data.mode === 'month') {
      (data.periods || []).forEach(period => {
        const section = document.createElement('div');
        section.className = 'timeline-month-section';

        const header = document.createElement('div');
        header.className = 'timeline-month-header';
        header.innerHTML = `
          <span class="timeline-month-label">${fmtMonthLabel(period.period)}</span>
          <span class="timeline-month-count">${period.count} items</span>
        `;
        section.appendChild(header);

        const strip = createTimelineStrip(period);
        section.appendChild(strip);

        fragment.appendChild(section);
      });
    } else if (data.mode === 'day') {
      // Group days by month
      const byMonth = {};
      (data.periods || []).forEach(period => {
        const month = period.period.substring(0, 7);
        if (!byMonth[month]) byMonth[month] = [];
        byMonth[month].push(period);
      });

      Object.entries(byMonth).forEach(([month, days]) => {
        const section = document.createElement('div');
        section.className = 'timeline-month-section';

        const monthHeader = document.createElement('div');
        monthHeader.className = 'timeline-month-header';
        monthHeader.innerHTML = `<span class="timeline-month-label">${fmtMonthLabel(month)}</span>`;
        section.appendChild(monthHeader);

        days.forEach(day => {
          const dayHeader = document.createElement('div');
          dayHeader.className = 'timeline-day-header';
          dayHeader.innerHTML = `
            <span class="timeline-day-label">${fmtDayLabel(day.period)}</span>
            <span class="timeline-day-count">${day.photos} photos${day.videos > 0 ? ' · ' + day.videos + ' videos' : ''}</span>
          `;
          section.appendChild(dayHeader);

          const strip = createTimelineStrip(day);
          section.appendChild(strip);
        });

        fragment.appendChild(section);
      });
    }

    el.timelineContent.appendChild(fragment);
    // Schedule mode indicator update after render
    requestAnimationFrame(updateModeIndicator);
  }

  function createTimelineStrip(period) {
    const strip = document.createElement('div');
    strip.className = 'timeline-strip';

    // Load items for this period on first view
    strip.dataset.period = period.period;
    strip.dataset.loaded = 'false';

    // Create placeholders
    const count = Math.min(period.count, 20);
    for (let i = 0; i < count; i++) {
      const item = document.createElement('div');
      item.className = 'timeline-strip-item skeleton';
      strip.appendChild(item);
    }

    // Lazy-load strip content
    const stripObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting && strip.dataset.loaded === 'false') {
          strip.dataset.loaded = 'true';
          stripObserver.unobserve(strip);
          loadTimelineStrip(strip, period.period, state.timelineMode);
        }
      });
    }, { rootMargin: '200px' });

    stripObserver.observe(strip);
    return strip;
  }

  async function loadTimelineStrip(strip, period, mode) {
    try {
      const data = await api(`/api/timeline?mode=${mode}&period=${period}&limit=30`);
      strip.innerHTML = '';

      (data.items || []).forEach((item, i) => {
        const div = document.createElement('div');
        div.className = 'timeline-strip-item';

        const img = document.createElement('img');
        img.alt = item.name;
        img.loading = 'lazy';
        img.dataset.src = item.thumbUrl;
        img.onload = () => img.classList.add('loaded');
        div.appendChild(img);

        if (item.type === 'video') {
          const badge = document.createElement('div');
          badge.className = 'video-badge';
          badge.innerHTML = `<svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
          div.appendChild(badge);
        }

        div.addEventListener('click', () => openLightbox(i, data.items));

        strip.appendChild(div);
      });

      observeImages(strip);
    } catch (err) {
      console.error('Timeline strip:', err);
    }
  }

  async function loadTimelineContinuous() {
    if (state.isLoading || !state.continuousHasMore) return;
    state.isLoading = true;
    el.timelineLoader.classList.remove('hidden');

    try {
      const data = await api(`/api/timeline?mode=continuous&page=${state.continuousPage}&limit=60`);

      if (data.items && data.items.length > 0) {
        renderContinuousItems(data.items);
        state.continuousHasMore = data.hasMore;
        state.continuousPage++;
      } else {
        state.continuousHasMore = false;
      }
    } catch (err) {
      console.error('Continuous:', err);
    } finally {
      state.isLoading = false;
      el.timelineLoader.classList.toggle('hidden', !state.continuousHasMore);
    }
  }

  function renderContinuousItems(items) {
    const fragment = document.createDocumentFragment();
    let lastDateHeader = el.timelineContent.querySelector('.timeline-continuous-header:last-of-type');
    let lastDate = lastDateHeader ? lastDateHeader.dataset.date : null;
    let currentGrid = el.timelineContent.querySelector('.gallery:last-of-type');

    items.forEach(item => {
      state.continuousItems.push(item);
      const itemDate = item.date ? item.date.substring(0, 10) : 'Unknown';

      if (itemDate !== lastDate) {
        // New date header
        const header = document.createElement('div');
        header.className = 'timeline-continuous-header';
        header.dataset.date = itemDate;
        header.textContent = itemDate !== 'Unknown' ? fmtFullDate(itemDate) : 'Unknown Date';
        fragment.appendChild(header);

        currentGrid = document.createElement('div');
        currentGrid.className = 'gallery';
        fragment.appendChild(currentGrid);

        lastDate = itemDate;
      }

      const idx = state.continuousItems.length - 1;
      const galleryItem = createGalleryItem(item, idx, (i) => openLightbox(i, state.continuousItems));
      if (currentGrid) currentGrid.appendChild(galleryItem);
    });

    el.timelineContent.appendChild(fragment);
    observeImages(el.timelineContent);
  }

  // ═══════════════════════════════════════════
  // PLACES VIEW
  // ═══════════════════════════════════════════
  function setupPlacesView() {
    el.placeBackBtn.addEventListener('click', closePlaceDetail);
  }

  async function loadPlaces() {
    try {
      const data = await api('/api/locations');
      state.placesData = data;

      if (data.clusters.length === 0) {
        el.placesGrid.classList.add('hidden');
        el.placesEmpty.classList.remove('hidden');
        el.placesCount.textContent = '';
      } else {
        el.placesEmpty.classList.add('hidden');
        el.placesGrid.classList.remove('hidden');
        el.placesCount.textContent = `${data.clusters.length} locations`;
        renderPlacesGrid(data.clusters);
      }
    } catch (err) {
      console.error('Places:', err);
    }
  }

  function renderPlacesGrid(clusters) {
    el.placesGrid.innerHTML = '';
    const fragment = document.createDocumentFragment();

    clusters.forEach((cluster, i) => {
      const card = document.createElement('div');
      card.className = 'place-card';
      card.style.animationDelay = `${i * 60}ms`;

      const img = document.createElement('img');
      img.alt = 'Location';
      img.loading = 'lazy';
      img.dataset.src = cluster.thumbUrl;
      img.onload = () => img.classList.add('loaded');
      card.appendChild(img);

      const info = document.createElement('div');
      info.className = 'place-card-info';
      info.innerHTML = `
        <div class="place-card-name">📍 ${cluster.latitude.toFixed(2)}, ${cluster.longitude.toFixed(2)}</div>
        <div class="place-card-count">${cluster.count} items</div>
      `;
      card.appendChild(info);

      card.addEventListener('click', () => openPlaceDetail(cluster));
      fragment.appendChild(card);
    });

    el.placesGrid.appendChild(fragment);
    observeImages(el.placesGrid);
  }

  async function openPlaceDetail(cluster) {
    state.placeDetail = cluster;
    state.placeItems = [];

    el.placeDetailName.textContent = `📍 ${cluster.latitude.toFixed(3)}, ${cluster.longitude.toFixed(3)}`;
    el.placeDetailCount.textContent = `${cluster.count} items`;
    el.placeDetailGrid.innerHTML = '';
    el.placeDetail.classList.remove('hidden');
    el.placesGrid.parentElement.querySelector('.view-header').style.display = 'none';
    el.placesGrid.style.display = 'none';

    // Load media for each item in the cluster
    try {
      const promises = cluster.items.slice(0, 60).map(id => api(`/api/media/${id}`));
      const items = await Promise.all(promises);
      appendGalleryItems(items, el.placeDetailGrid, state.placeItems, (idx) => openLightbox(idx, state.placeItems));
    } catch (err) {
      console.error('Place media:', err);
    }
  }

  function closePlaceDetail() {
    el.placeDetail.classList.add('hidden');
    el.placesGrid.parentElement.querySelector('.view-header').style.display = '';
    el.placesGrid.style.display = '';
  }

  // ═══════════════════════════════════════════
  // AI STATUS POLLING
  // ═══════════════════════════════════════════
  async function pollAiStatus() {
    try {
      const status = await api('/api/ai/status');
      state.aiStatus = status;

      if (status.running && status.progress < 100) {
        el.aiProgressBar.classList.remove('hidden');
        el.aiProgressFill.style.width = `${status.progress}%`;
      } else {
        el.aiProgressBar.classList.add('hidden');
      }
    } catch (_) {}

    // Poll every 10s
    setTimeout(pollAiStatus, 10000);
  }

  // ═══════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════
  function fmtNum(n) {
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return n.toString();
  }

  function fmtDate(str) {
    try { return new Date(str).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch (_) { return str; }
  }

  function fmtFullDate(str) {
    try { return new Date(str + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }); }
    catch (_) { return str; }
  }

  function fmtMonthLabel(ym) {
    try {
      const [y, m] = ym.split('-');
      return new Date(y, m - 1).toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
    } catch (_) { return ym; }
  }

  function fmtDayLabel(ymd) {
    try { return new Date(ymd + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' }); }
    catch (_) { return ymd; }
  }

  // Expose for HTML onclick
  window.Gallery = { triggerScan };

  // Start
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
