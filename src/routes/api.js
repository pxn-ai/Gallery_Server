const express = require('express');
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');
const db = require('../db');
const { getThumbnail, getPreview, getFullImage } = require('../thumbnailer');
const { scanMedia } = require('../scanner');

const router = express.Router();

// Track scan state
let scanInProgress = false;

/**
 * GET /api/stats
 * Gallery statistics
 */
router.get('/stats', (req, res) => {
  try {
    const stats = db.getStats();
    res.json({
      total: stats.total || 0,
      photos: stats.photos || 0,
      videos: stats.videos || 0,
      totalSize: stats.total_size || 0,
      totalSizeHuman: formatBytes(stats.total_size || 0),
      scanInProgress,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/media
 * Paginated media list
 * Query params: page (default 1), limit (default 60), type (all/photo/video)
 */
router.get('/media', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 60));
    const type = ['all', 'photo', 'video'].includes(req.query.type) ? req.query.type : 'all';

    const items = db.getMediaPage(page, limit, type);
    const total = db.getMediaCount(type);
    const totalPages = Math.ceil(total / limit);

    res.json({
      items: items.map(formatMediaItem),
      page,
      limit,
      total,
      totalPages,
      hasMore: page < totalPages,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/media/:id
 * Single media item metadata
 */
router.get('/media/:id', (req, res) => {
  try {
    const item = db.getMediaById(parseInt(req.params.id));
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json(formatMediaItem(item));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/thumb/:id
 * Thumbnail image (400px, lazy generated)
 */
router.get('/thumb/:id', async (req, res) => {
  try {
    const item = db.getMediaById(parseInt(req.params.id));
    if (!item) return res.status(404).json({ error: 'Not found' });

    const thumbPath = await getThumbnail(item);
    if (!thumbPath) return res.status(500).json({ error: 'Thumbnail generation failed' });

    res.set('Cache-Control', 'public, max-age=86400');
    res.type('image/jpeg');
    res.sendFile(thumbPath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/preview/:id
 * Medium preview (1400px, lazy generated)
 */
router.get('/preview/:id', async (req, res) => {
  try {
    const item = db.getMediaById(parseInt(req.params.id));
    if (!item) return res.status(404).json({ error: 'Not found' });

    const previewPath = await getPreview(item);
    if (!previewPath) return res.status(500).json({ error: 'Preview generation failed' });

    res.set('Cache-Control', 'public, max-age=86400');
    res.type('image/jpeg');
    res.sendFile(previewPath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/full/:id
 * Full resolution image (HEIC converted to JPEG)
 */
router.get('/full/:id', async (req, res) => {
  try {
    const item = db.getMediaById(parseInt(req.params.id));
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (item.media_type !== 'photo') return res.status(400).json({ error: 'Not a photo' });

    const fullPath = await getFullImage(item);
    if (!fullPath) return res.status(500).json({ error: 'Conversion failed' });

    res.set('Cache-Control', 'public, max-age=86400');
    const mimeType = mime.lookup(fullPath) || 'image/jpeg';
    res.type(mimeType);
    res.sendFile(fullPath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/video/:id
 * Video streaming with range request support
 */
router.get('/video/:id', (req, res) => {
  try {
    const item = db.getMediaById(parseInt(req.params.id));
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (item.media_type !== 'video') return res.status(400).json({ error: 'Not a video' });

    const filePath = item.file_path;
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const mimeType = mime.lookup(filePath) || 'video/mp4';

    const range = req.headers.range;

    if (range) {
      // Parse range header
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const stream = fs.createReadStream(filePath, { start, end });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=86400',
      });

      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
      });

      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/scan
 * Trigger a media rescan
 */
router.post('/scan', async (req, res) => {
  if (scanInProgress) {
    return res.status(409).json({ error: 'Scan already in progress' });
  }

  scanInProgress = true;
  res.json({ message: 'Scan started' });

  try {
    await scanMedia();
  } catch (err) {
    console.error('Scan error:', err);
  } finally {
    scanInProgress = false;
  }
});

// Helper: format media item for API response
function formatMediaItem(item) {
  return {
    id: item.id,
    name: item.file_name,
    type: item.media_type,
    size: item.file_size,
    sizeHuman: formatBytes(item.file_size),
    width: item.width,
    height: item.height,
    duration: item.duration,
    durationHuman: item.duration ? formatDuration(item.duration) : null,
    dateTaken: item.date_taken,
    dateModified: item.date_modified,
    date: item.date_taken || item.date_modified,
    thumbUrl: `/api/thumb/${item.id}`,
    previewUrl: item.media_type === 'photo' ? `/api/preview/${item.id}` : null,
    fullUrl: item.media_type === 'photo' ? `/api/full/${item.id}` : null,
    videoUrl: item.media_type === 'video' ? `/api/video/${item.id}` : null,
  };
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

module.exports = router;
