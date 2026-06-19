const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const exifr = require('exifr');
const db = require('./db');

const MEDIA_PATH = process.env.MEDIA_PATH || '/media/pasan/PHOTOS/';

// Supported extensions
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif', '.avif', '.dng']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v']);
const IGNORE_DIRS = new Set(['.Spotlight-V100', '.Trashes', '.fseventsd', '@eaDir', '.DS_Store']);

/**
 * Get video metadata via ffprobe
 */
function probeVideo(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        resolve({ width: null, height: null, duration: null });
        return;
      }
      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      resolve({
        width: videoStream?.width || null,
        height: videoStream?.height || null,
        duration: metadata.format?.duration || null,
      });
    });
  });
}

/**
 * Get photo metadata via Sharp (dimensions) + exifr (EXIF date + GPS)
 */
async function probePhoto(filePath) {
  let width = null, height = null, dateTaken = null;
  let latitude = null, longitude = null;

  // Get dimensions via Sharp (fast)
  try {
    const meta = await sharp(filePath).metadata();
    width = meta.width || null;
    height = meta.height || null;
  } catch (err) {
    console.warn(`  ⚠ Sharp metadata failed for: ${path.basename(filePath)} — ${err.message}`);
  }

  // Get EXIF date + GPS via exifr (supports HEIC natively, auto-converts GPS DMS→decimal)
  try {
    const exif = await exifr.parse(filePath, {
      pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'GPSLatitude', 'GPSLongitude'],
      translateValues: true,
      reviveValues: true,
    });

    if (exif) {
      // Date extraction — prefer DateTimeOriginal, fall back to CreateDate
      const dateVal = exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate;
      if (dateVal instanceof Date && !isNaN(dateVal)) {
        dateTaken = dateVal.toISOString();
      } else if (typeof dateVal === 'string') {
        dateTaken = dateVal;
      }

      // GPS extraction — exifr auto-converts to decimal degrees
      if (typeof exif.latitude === 'number' && typeof exif.longitude === 'number') {
        latitude = exif.latitude;
        longitude = exif.longitude;
      }
    }

    // If no GPS from main parse, try the dedicated gps() method
    if (latitude === null) {
      try {
        const gps = await exifr.gps(filePath);
        if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number') {
          latitude = gps.latitude;
          longitude = gps.longitude;
        }
      } catch (_) { /* no GPS data */ }
    }
  } catch (err) {
    console.warn(`  ⚠ EXIF parse failed for: ${path.basename(filePath)} — ${err.message}`);
  }

  return { width, height, dateTaken, latitude, longitude };
}

/**
 * Recursively collect media file paths
 */
function collectMediaFiles(dir) {
  const results = [];

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`  ⚠ Cannot read directory: ${dir}`);
    return results;
  }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...collectMediaFiles(fullPath));
    } else if (entry.isFile()) {
      // Skip macOS resource fork files, hidden files, and AAE sidecar files
      if (entry.name.startsWith('._') || entry.name.startsWith('.')) continue;

      const ext = path.extname(entry.name).toLowerCase();

      // Skip Apple AAE edit sidecar files
      if (ext === '.aae') continue;

      if (PHOTO_EXTS.has(ext)) {
        results.push({ path: fullPath, type: 'photo' });
      } else if (VIDEO_EXTS.has(ext)) {
        results.push({ path: fullPath, type: 'video' });
      }
    }
  }

  return results;
}

/**
 * Scan all media and populate the database
 */
async function scanMedia(progressCallback) {
  console.log(`\n📂 Scanning media in: ${MEDIA_PATH}`);
  const startTime = Date.now();

  const files = collectMediaFiles(MEDIA_PATH);
  console.log(`   Found ${files.length} media files`);

  // Remove DB entries for files that no longer exist
  const existingPaths = new Set(db.getAllPaths());
  const currentPaths = new Set(files.map(f => f.path));
  let removed = 0;
  for (const existingPath of existingPaths) {
    if (!currentPaths.has(existingPath)) {
      // Clear AI scan data for removed files
      const existing = db.getMediaByPath(existingPath);
      if (existing) {
        db.deleteFacesByMedia(existing.id);
        db.clearAiScanForMedia(existing.id);
      }
      db.deleteByPath(existingPath);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`   🗑  Removed ${removed} stale entries`);
  }

  // Skip files already in DB (by file path + size match)
  let scanned = 0;
  let skipped = 0;
  let errors = 0;
  let gpsFound = 0;

  for (const file of files) {
    try {
      const stat = fs.statSync(file.path);
      const existing = db.getMediaByPath(file.path);

      // Skip if already scanned and file size matches (hasn't changed)
      if (existing && existing.file_size === stat.size) {
        skipped++;
        continue;
      }

      // If file changed, clear its old AI scan data so it gets re-indexed
      if (existing && existing.file_size !== stat.size) {
        db.deleteFacesByMedia(existing.id);
        db.clearAiScanForMedia(existing.id);
      }

      let width = null, height = null, duration = null, dateTaken = null;
      let latitude = null, longitude = null;

      if (file.type === 'photo') {
        const meta = await probePhoto(file.path);
        width = meta.width;
        height = meta.height;
        dateTaken = meta.dateTaken;
        latitude = meta.latitude;
        longitude = meta.longitude;
        if (latitude !== null) gpsFound++;
      } else {
        const meta = await probeVideo(file.path);
        width = meta.width;
        height = meta.height;
        duration = meta.duration;
      }

      db.upsertMedia({
        file_path: file.path,
        file_name: path.basename(file.path),
        media_type: file.type,
        file_size: stat.size,
        width,
        height,
        duration,
        date_taken: dateTaken,
        date_modified: stat.mtime.toISOString(),
        latitude: latitude,
        longitude: longitude,
      });

      scanned++;

      // Log progress every 100 files
      if (scanned % 100 === 0) {
        const pct = Math.round(((scanned + skipped) / files.length) * 100);
        console.log(`   📸 Scanned ${scanned} new files (${pct}% complete, ${gpsFound} with GPS)`);
        if (progressCallback) progressCallback(scanned, skipped, files.length);
      }
    } catch (err) {
      errors++;
      console.warn(`  ⚠ Error scanning ${path.basename(file.path)}: ${err.message}`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Scan complete in ${elapsed}s`);
  console.log(`   📸 ${scanned} new | ⏭ ${skipped} cached | 📍 ${gpsFound} GPS | ❌ ${errors} errors\n`);

  return { scanned, skipped, errors, total: files.length, gpsFound };
}

module.exports = { scanMedia, collectMediaFiles };
