const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const crypto = require('crypto');
const db = require('./db');

const CACHE_DIR = path.join(__dirname, '..', '.gallery_cache');
const THUMB_DIR = path.join(CACHE_DIR, 'thumbs');
const PREVIEW_DIR = path.join(CACHE_DIR, 'previews');
const FULL_DIR = path.join(CACHE_DIR, 'full');

// Ensure cache directories exist
[THUMB_DIR, PREVIEW_DIR, FULL_DIR].forEach(dir => {
  fs.mkdirSync(dir, { recursive: true });
});

const THUMB_SIZE = 400;
const PREVIEW_SIZE = 1400;
const JPEG_QUALITY = 80;

// Formats that need conversion to JPEG for browsers
const NEEDS_CONVERSION = new Set(['.heic', '.heif', '.dng', '.avif']);

/**
 * Create a deterministic cache filename based on file path
 */
function getCacheFilename(filePath) {
  const hash = crypto.createHash('md5').update(filePath).digest('hex');
  const ext = '.jpg';
  return hash + ext;
}

/**
 * Generate a thumbnail for a photo
 */
async function generatePhotoThumb(filePath, outputPath) {
  await sharp(filePath, { failOnError: false })
    .rotate() // auto-rotate based on EXIF
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: JPEG_QUALITY })
    .toFile(outputPath);
}

/**
 * Generate a preview for a photo (larger, fit within bounds)
 */
async function generatePhotoPreview(filePath, outputPath) {
  await sharp(filePath, { failOnError: false })
    .rotate()
    .resize(PREVIEW_SIZE, PREVIEW_SIZE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toFile(outputPath);
}

/**
 * Convert HEIC/DNG to full-size JPEG
 */
async function convertToJpeg(filePath, outputPath) {
  await sharp(filePath, { failOnError: false })
    .rotate()
    .jpeg({ quality: 92 })
    .toFile(outputPath);
}

/**
 * Generate a thumbnail for a video (extract frame at 1s)
 */
function generateVideoThumb(filePath, outputPath) {
  return new Promise((resolve, reject) => {
    const tempPng = outputPath + '.tmp.png';
    ffmpeg(filePath)
      .on('error', (err) => {
        // Try at 0s if 1s fails (very short video)
        ffmpeg(filePath)
          .on('error', reject)
          .on('end', async () => {
            try {
              await sharp(tempPng)
                .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'centre' })
                .jpeg({ quality: JPEG_QUALITY })
                .toFile(outputPath);
              fs.unlinkSync(tempPng);
              resolve();
            } catch (e) {
              reject(e);
            }
          })
          .screenshots({
            count: 1,
            timemarks: ['0'],
            filename: path.basename(tempPng),
            folder: path.dirname(tempPng),
            size: '640x?',
          });
      })
      .on('end', async () => {
        try {
          await sharp(tempPng)
            .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'centre' })
            .jpeg({ quality: JPEG_QUALITY })
            .toFile(outputPath);
          fs.unlinkSync(tempPng);
          resolve();
        } catch (e) {
          reject(e);
        }
      })
      .screenshots({
        count: 1,
        timemarks: ['1'],
        filename: path.basename(tempPng),
        folder: path.dirname(tempPng),
        size: '640x?',
      });
  });
}

/**
 * Generate a preview for a video (larger frame extract)
 */
function generateVideoPreview(filePath, outputPath) {
  return new Promise((resolve, reject) => {
    const tempPng = outputPath + '.tmp.png';
    ffmpeg(filePath)
      .on('error', reject)
      .on('end', async () => {
        try {
          await sharp(tempPng)
            .resize(PREVIEW_SIZE, PREVIEW_SIZE, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: JPEG_QUALITY })
            .toFile(outputPath);
          fs.unlinkSync(tempPng);
          resolve();
        } catch (e) {
          reject(e);
        }
      })
      .screenshots({
        count: 1,
        timemarks: ['1'],
        filename: path.basename(tempPng),
        folder: path.dirname(tempPng),
        size: '1280x?',
      });
  });
}

/**
 * Get or generate thumbnail for a media item
 */
async function getThumbnail(mediaItem) {
  const cacheFile = getCacheFilename(mediaItem.file_path);
  const thumbPath = path.join(THUMB_DIR, cacheFile);

  // Return cached version
  if (fs.existsSync(thumbPath)) {
    return thumbPath;
  }

  // Generate new thumbnail
  try {
    if (mediaItem.media_type === 'photo') {
      await generatePhotoThumb(mediaItem.file_path, thumbPath);
    } else {
      await generateVideoThumb(mediaItem.file_path, thumbPath);
    }
    db.updateThumbPath(mediaItem.id, thumbPath);
    return thumbPath;
  } catch (err) {
    console.error(`Failed to generate thumb for ${mediaItem.file_name}: ${err.message}`);
    return null;
  }
}

/**
 * Get or generate preview for a media item
 */
async function getPreview(mediaItem) {
  const cacheFile = getCacheFilename(mediaItem.file_path);
  const previewPath = path.join(PREVIEW_DIR, cacheFile);

  if (fs.existsSync(previewPath)) {
    return previewPath;
  }

  try {
    if (mediaItem.media_type === 'photo') {
      await generatePhotoPreview(mediaItem.file_path, previewPath);
    } else {
      await generateVideoPreview(mediaItem.file_path, previewPath);
    }
    db.updatePreviewPath(mediaItem.id, previewPath);
    return previewPath;
  } catch (err) {
    console.error(`Failed to generate preview for ${mediaItem.file_name}: ${err.message}`);
    return null;
  }
}

/**
 * Get full-resolution image (converts HEIC/DNG to JPEG if needed)
 */
async function getFullImage(mediaItem) {
  const ext = path.extname(mediaItem.file_path).toLowerCase();

  // If the file is browser-compatible, serve directly
  if (!NEEDS_CONVERSION.has(ext)) {
    return mediaItem.file_path;
  }

  // Convert to JPEG and cache
  const cacheFile = getCacheFilename(mediaItem.file_path);
  const fullPath = path.join(FULL_DIR, cacheFile);

  if (fs.existsSync(fullPath)) {
    return fullPath;
  }

  try {
    await convertToJpeg(mediaItem.file_path, fullPath);
    return fullPath;
  } catch (err) {
    console.error(`Failed to convert ${mediaItem.file_name}: ${err.message}`);
    return null;
  }
}

module.exports = {
  getThumbnail,
  getPreview,
  getFullImage,
  THUMB_DIR,
  PREVIEW_DIR,
  FULL_DIR,
};
