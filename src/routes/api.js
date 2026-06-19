const express = require('express');
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');
const sharp = require('sharp');
const db = require('../db');
const { getThumbnail, getPreview, getFullImage } = require('../thumbnailer');
const { scanMedia } = require('../scanner');
const aiIndexer = require('../ai/indexer');

const router = express.Router();

// Track scan state
let scanInProgress = false;

// ════════════════════════════════════════
// STATS
// ════════════════════════════════════════

/**
 * GET /api/stats
 * Gallery statistics
 */
router.get('/stats', (req, res) => {
  try {
    const stats = db.getStats();
    const aiStatus = aiIndexer.getStatus();
    res.json({
      total: stats.total || 0,
      photos: stats.photos || 0,
      videos: stats.videos || 0,
      totalSize: stats.total_size || 0,
      totalSizeHuman: formatBytes(stats.total_size || 0),
      scanInProgress,
      peopleCount: db.getPeopleCount(),
      locationCount: db.getLocationCount(),
      aiProgress: aiStatus.progress,
      aiRunning: aiStatus.running,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// MEDIA
// ════════════════════════════════════════

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

// ════════════════════════════════════════
// THUMBNAILS / PREVIEWS / FULL
// ════════════════════════════════════════

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

// ════════════════════════════════════════
// VIDEO STREAMING
// ════════════════════════════════════════

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

// ════════════════════════════════════════
// MEDIA SCAN
// ════════════════════════════════════════

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

// ════════════════════════════════════════
// PEOPLE (Face Clusters)
// ════════════════════════════════════════

/**
 * GET /api/people
 * List all recognized people with face count and representative thumbnail
 */
router.get('/people', (req, res) => {
  try {
    const people = db.getAllPeople();
    res.json(people.map(p => ({
      id: p.id,
      name: p.name,
      faceCount: p.face_count,
      representativeFaceId: p.representative_face_id,
      repMediaId: p.rep_media_id,
      // Provide a face crop URL for the avatar
      avatarUrl: p.representative_face_id ? `/api/face-crop/${p.representative_face_id}` : null,
      thumbUrl: p.rep_media_id ? `/api/thumb/${p.rep_media_id}` : null,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/people/:id/media
 * Paginated photos of a specific person
 */
router.get('/people/:id/media', (req, res) => {
  try {
    const personId = parseInt(req.params.id);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 60));

    const person = db.getPersonById(personId);
    if (!person) return res.status(404).json({ error: 'Person not found' });

    const items = db.getMediaByPerson(personId, page, limit);
    const total = db.getMediaCountByPerson(personId);
    const totalPages = Math.ceil(total / limit);

    res.json({
      person: { id: person.id, name: person.name, faceCount: person.face_count },
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
 * PUT /api/people/:id
 * Rename a person
 */
router.put('/people/:id', (req, res) => {
  try {
    const personId = parseInt(req.params.id);
    const { name } = req.body;

    const person = db.getPersonById(personId);
    if (!person) return res.status(404).json({ error: 'Person not found' });

    db.updatePersonName(personId, name || null);
    res.json({ id: personId, name: name || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/people/merge
 * Merge two person clusters
 */
router.post('/people/merge', (req, res) => {
  try {
    const { sourceId, targetId } = req.body;
    if (!sourceId || !targetId) return res.status(400).json({ error: 'sourceId and targetId required' });

    const source = db.getPersonById(sourceId);
    const target = db.getPersonById(targetId);
    if (!source || !target) return res.status(404).json({ error: 'Person not found' });

    // Move all faces from source to target
    const faces = db.getFacesByPerson(sourceId);
    for (const face of faces) {
      db.updateFacePerson(face.id, targetId);
    }

    // Update target face count
    db.updatePersonFaceCount(targetId);

    // Delete source person
    db.deletePerson(sourceId);

    res.json({ message: 'Merged', targetId, newFaceCount: db.getMediaCountByPerson(targetId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/face-crop/:faceId
 * Cropped face image from the original photo
 */
router.get('/face-crop/:faceId', async (req, res) => {
  try {
    const face = db.getFaceById(parseInt(req.params.faceId));
    if (!face) return res.status(404).json({ error: 'Face not found' });

    const media = db.getMediaById(face.media_id);
    if (!media) return res.status(404).json({ error: 'Media not found' });

    // Get image dimensions
    const meta = await sharp(media.file_path).metadata();
    const imgW = meta.width;
    const imgH = meta.height;

    // Convert normalized bbox to pixel coords with padding
    const padding = 0.3; // 30% padding around face
    let x = Math.round(face.bbox_x * imgW);
    let y = Math.round(face.bbox_y * imgH);
    let w = Math.round(face.bbox_w * imgW);
    let h = Math.round(face.bbox_h * imgH);

    // Add padding
    const padW = Math.round(w * padding);
    const padH = Math.round(h * padding);
    x = Math.max(0, x - padW);
    y = Math.max(0, y - padH);
    w = Math.min(imgW - x, w + padW * 2);
    h = Math.min(imgH - y, h + padH * 2);

    // Make it square (use the larger dimension)
    const size = Math.max(w, h);
    const cx = x + w / 2;
    const cy = y + h / 2;
    x = Math.max(0, Math.round(cx - size / 2));
    y = Math.max(0, Math.round(cy - size / 2));
    w = Math.min(imgW - x, size);
    h = Math.min(imgH - y, size);

    const croppedBuffer = await sharp(media.file_path)
      .rotate()
      .extract({ left: x, top: y, width: w, height: h })
      .resize(200, 200, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toBuffer();

    res.set('Cache-Control', 'public, max-age=86400');
    res.type('image/jpeg');
    res.send(croppedBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// TIMELINE
// ════════════════════════════════════════

/**
 * GET /api/timeline
 * Timeline data — supports month, day, and continuous modes
 * Query: mode=month|day|continuous, page, limit, period (for specific month/day)
 */
router.get('/timeline', (req, res) => {
  try {
    const mode = ['month', 'day', 'continuous'].includes(req.query.mode) ? req.query.mode : 'month';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 60));

    if (mode === 'month') {
      // Return month summaries, optionally with media for a specific month
      const period = req.query.period; // e.g., "2025-06"
      if (period) {
        const items = db.getMediaByMonth(period, page, limit);
        const total = db.getMediaCountByMonth(period);
        res.json({
          mode: 'month',
          period,
          items: items.map(formatMediaItem),
          total,
          hasMore: page * limit < total,
          page,
        });
      } else {
        const timeline = db.getTimelineByMonth();
        res.json({
          mode: 'month',
          periods: timeline.map(t => ({
            period: t.period,
            count: t.count,
            photos: t.photos,
            videos: t.videos,
            thumbUrl: t.first_media_id ? `/api/thumb/${t.first_media_id}` : null,
          })),
        });
      }
    } else if (mode === 'day') {
      const period = req.query.period; // e.g., "2025-06-15"
      if (period) {
        const items = db.getMediaByDay(period, page, limit);
        res.json({
          mode: 'day',
          period,
          items: items.map(formatMediaItem),
          page,
        });
      } else {
        const timeline = db.getTimelineByDay();
        res.json({
          mode: 'day',
          periods: timeline.map(t => ({
            period: t.period,
            count: t.count,
            photos: t.photos,
            videos: t.videos,
            thumbUrl: t.first_media_id ? `/api/thumb/${t.first_media_id}` : null,
          })),
        });
      }
    } else {
      // Continuous: paginated list of all media, ordered by date
      const items = db.getTimelineContinuous(page, limit);
      const total = db.getTimelineContinuousCount();
      res.json({
        mode: 'continuous',
        items: items.map(formatMediaItem),
        total,
        page,
        hasMore: page * limit < total,
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// LOCATIONS
// ════════════════════════════════════════

/**
 * GET /api/locations
 * All media with GPS coordinates, clustered by proximity
 */
router.get('/locations', (req, res) => {
  try {
    const media = db.getMediaWithLocation();

    // Cluster nearby locations (within ~1km)
    const clusters = [];
    const used = new Set();

    for (let i = 0; i < media.length; i++) {
      if (used.has(i)) continue;

      const cluster = {
        latitude: media[i].latitude,
        longitude: media[i].longitude,
        count: 1,
        items: [media[i].id],
        thumbUrl: `/api/thumb/${media[i].id}`,
      };

      for (let j = i + 1; j < media.length; j++) {
        if (used.has(j)) continue;
        const dist = haversineDistance(
          media[i].latitude, media[i].longitude,
          media[j].latitude, media[j].longitude
        );
        if (dist < 1.0) { // Within 1km
          cluster.count++;
          cluster.items.push(media[j].id);
          used.add(j);
        }
      }

      used.add(i);
      // Average the cluster center
      if (cluster.items.length > 1) {
        let sumLat = 0, sumLng = 0;
        for (const id of cluster.items) {
          const m = media.find(x => x.id === id);
          if (m) { sumLat += m.latitude; sumLng += m.longitude; }
        }
        cluster.latitude = sumLat / cluster.items.length;
        cluster.longitude = sumLng / cluster.items.length;
      }

      clusters.push(cluster);
    }

    res.json({ clusters, totalWithLocation: media.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// AI STATUS
// ════════════════════════════════════════

/**
 * GET /api/ai/status
 * AI indexing progress
 */
router.get('/ai/status', (req, res) => {
  try {
    res.json(aiIndexer.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ai/start
 * Start/resume AI indexing
 */
router.post('/ai/start', (req, res) => {
  try {
    aiIndexer.start();
    res.json({ message: 'AI indexing started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/ai/stop
 * Stop AI indexing
 */
router.post('/ai/stop', (req, res) => {
  try {
    aiIndexer.stop();
    res.json({ message: 'AI indexing stopping' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════

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
    latitude: item.latitude || null,
    longitude: item.longitude || null,
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

/**
 * Haversine distance between two GPS coordinates in km
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

module.exports = router;
