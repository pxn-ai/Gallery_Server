const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
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
 * Get photo metadata via Sharp
 */
async function probePhoto(filePath) {
  try {
    const meta = await sharp(filePath).metadata();
    let dateTaken = null;

    // Try to extract EXIF date
    if (meta.exif) {
      try {
        // Parse EXIF buffer for DateTimeOriginal
        const exifStr = meta.exif.toString('binary');
        const dateMatch = exifStr.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
        if (dateMatch) {
          dateTaken = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T${dateMatch[4]}:${dateMatch[5]}:${dateMatch[6]}`;
        }
      } catch (_) { /* ignore EXIF parse errors */ }
    }

    return {
      width: meta.width || null,
      height: meta.height || null,
      dateTaken,
    };
  } catch (err) {
    console.warn(`  ⚠ Could not read metadata for: ${path.basename(filePath)} — ${err.message}`);
    return { width: null, height: null, dateTaken: null };
  }
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
      // Skip macOS resource fork files and hidden files
      if (entry.name.startsWith('._') || entry.name.startsWith('.')) continue;

      const ext = path.extname(entry.name).toLowerCase();
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

  for (const file of files) {
    try {
      const stat = fs.statSync(file.path);
      const existing = db.getMediaByPath(file.path);

      // Skip if already scanned and file size matches (hasn't changed)
      if (existing && existing.file_size === stat.size) {
        skipped++;
        continue;
      }

      let width = null, height = null, duration = null, dateTaken = null;

      if (file.type === 'photo') {
        const meta = await probePhoto(file.path);
        width = meta.width;
        height = meta.height;
        dateTaken = meta.dateTaken;
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
      });

      scanned++;

      // Log progress every 100 files
      if (scanned % 100 === 0) {
        const pct = Math.round(((scanned + skipped) / files.length) * 100);
        console.log(`   📸 Scanned ${scanned} new files (${pct}% complete)`);
        if (progressCallback) progressCallback(scanned, skipped, files.length);
      }
    } catch (err) {
      errors++;
      console.warn(`  ⚠ Error scanning ${path.basename(file.path)}: ${err.message}`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Scan complete in ${elapsed}s`);
  console.log(`   📸 ${scanned} new | ⏭ ${skipped} cached | ❌ ${errors} errors\n`);

  return { scanned, skipped, errors, total: files.length };
}

module.exports = { scanMedia, collectMediaFiles };
