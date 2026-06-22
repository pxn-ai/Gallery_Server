/**
 * AI Face Indexer — Persistent Background Worker
 *
 * Runs continuously in the background, scanning photos for faces,
 * extracting embeddings, and clustering them into people.
 *
 * - Processes unscanned photos incrementally
 * - Re-processes photos whose files have changed
 * - Runs clustering periodically as new faces are found
 * - Memory-efficient: processes one photo at a time
 * - Gracefully stops/starts via API
 */
const db = require('../db');
const { detectFaces } = require('./face-detector');
const { getEmbedding } = require('./face-embedder');
const { clusterAllFaces, findMatchingPerson } = require('./clustering');

// Indexer state
let isRunning = false;
let shouldStop = false;
let stats = {
  scanned: 0,
  totalPhotos: 0,
  facesFound: 0,
  currentFile: null,
  startedAt: null,
  lastActivity: null,
  errors: 0,
};

// Timing
const BATCH_SIZE = 10;          // Photos per batch before yielding
const YIELD_DELAY = 100;        // ms pause between batches (reduce CPU pressure)
const CLUSTER_INTERVAL = 50;    // Re-cluster every N new faces found
const IDLE_POLL_INTERVAL = 30000; // Check for new work every 30s when idle

let pendingFacesSinceCluster = 0;

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process a single photo: detect faces → extract embeddings → store
 */
async function processPhoto(media) {
  stats.currentFile = media.file_name;

  try {
    // Detect faces
    const faces = await detectFaces(media.file_path);

    if (faces.length === 0) {
      // No faces found — mark as scanned
      db.markAiScanned(media.id, 0);
      return 0;
    }

    let storedFaces = 0;

    for (const face of faces) {
      try {
        // Get embedding
        let embedding = null;
        if (face.landmarks) {
          embedding = await getEmbedding(media.file_path, face.landmarks);
        }

        if (!embedding) continue;

        // Convert Float32Array to Buffer for SQLite storage
        const embeddingBlob = Buffer.from(embedding.buffer);

        // Try to match to existing person (incremental clustering)
        const matchedPersonId = findMatchingPerson(embedding);

        // Store face in database
        const result = db.insertFace({
          media_id: media.id,
          bbox_x: face.bbox.x,
          bbox_y: face.bbox.y,
          bbox_w: face.bbox.w,
          bbox_h: face.bbox.h,
          confidence: face.confidence,
          embedding: embeddingBlob,
          person_id: matchedPersonId,
        });

        // If matched to a person, update their face count and maybe update representative
        if (matchedPersonId) {
          db.updatePersonFaceCount(matchedPersonId);
        }

        storedFaces++;
        stats.facesFound++;
        pendingFacesSinceCluster++;
      } catch (err) {
        console.warn(`   ⚠ Face embedding failed: ${err.message}`);
      }
    }

    // Mark as scanned
    db.markAiScanned(media.id, storedFaces);
    return storedFaces;

  } catch (err) {
    // If the model itself failed to load, propagate the error to stop indexing
    if (err.message.includes('failed to load') || err.message.includes('too small') || err.message.includes('not found')) {
      throw err; // Stop the indexer entirely
    }
    console.warn(`   ⚠ Face detection failed for ${media.file_name}: ${err.message}`);
    stats.errors++;
    // Mark as scanned with 0 faces to avoid retrying broken files
    db.markAiScanned(media.id, 0);
    return 0;
  }
}

/**
 * Process a batch of unscanned photos
 * @returns {number} Number of photos processed
 */
async function processBatch() {
  const unscanned = db.getUnscannedPhotos(BATCH_SIZE);
  if (unscanned.length === 0) return 0;

  for (const photo of unscanned) {
    if (shouldStop) break;

    await processPhoto(photo);
    stats.scanned++;
    stats.lastActivity = new Date().toISOString();

    // Log progress periodically
    if (stats.scanned % 10 === 0) {
      const pct = stats.totalPhotos > 0 ? Math.round((stats.scanned / stats.totalPhotos) * 100) : 0;
      console.log(`   🧠 AI: ${stats.scanned}/${stats.totalPhotos} (${pct}%) — ${stats.facesFound} faces found`);
    }
  }

  // Run clustering if enough new faces have been found
  if (pendingFacesSinceCluster >= CLUSTER_INTERVAL) {
    try {
      clusterAllFaces();
      pendingFacesSinceCluster = 0;
    } catch (err) {
      console.warn(`   ⚠ Clustering failed: ${err.message}`);
    }
  }

  return unscanned.length;
}

/**
 * Main indexer loop — runs continuously as a background task
 */
async function runIndexer() {
  if (isRunning) {
    console.log('   AI indexer already running');
    return;
  }

  isRunning = true;
  shouldStop = false;
  stats.startedAt = new Date().toISOString();
  stats.scanned = db.getAiScanCount();
  stats.totalPhotos = db.getAiTotalPhotos();
  stats.facesFound = db.getAiTotalFaces();
  stats.errors = 0;

  console.log(`\n🧠 AI Face Indexer starting (${stats.scanned}/${stats.totalPhotos} already scanned)\n`);

  // Continuous loop
  while (!shouldStop) {
    try {
      // Update total (new files might have been added)
      stats.totalPhotos = db.getAiTotalPhotos();

      // Process a batch
      const processed = await processBatch();

      if (processed === 0) {
        // No work — run final clustering if needed, then idle
        if (pendingFacesSinceCluster > 0) {
          try {
            clusterAllFaces();
            pendingFacesSinceCluster = 0;
          } catch (err) {
            console.warn(`   ⚠ Final clustering failed: ${err.message}`);
          }
        }

        stats.currentFile = null;

        // Idle: wait before checking for new work
        await sleep(IDLE_POLL_INTERVAL);
        continue;
      }

      // Yield between batches to reduce CPU pressure
      await sleep(YIELD_DELAY);

    } catch (err) {
      // If model failed to load, stop the indexer entirely
      if (err.message.includes('failed to load') || err.message.includes('too small') || err.message.includes('not found at')) {
        console.error(`\n   ❌ AI indexer stopped: ${err.message}`);
        console.error('   Run "npm run download-models" to download the required ONNX models.\n');
        shouldStop = true;
        break;
      }
      console.error(`   ⚠ AI indexer error: ${err.message}`);
      stats.errors++;
      await sleep(5000); // Back off on error
    }
  }

  // Final clustering before stopping
  if (pendingFacesSinceCluster > 0) {
    try {
      clusterAllFaces();
      pendingFacesSinceCluster = 0;
    } catch (_) {}
  }

  isRunning = false;
  stats.currentFile = null;
  console.log('\n🧠 AI Face Indexer stopped\n');
}

/**
 * Start the indexer (non-blocking — runs in background)
 */
function start() {
  if (isRunning) return;
  // Fire and forget — runs as background async loop
  runIndexer().catch(err => {
    console.error('AI Indexer crashed:', err);
    isRunning = false;
  });
}

/**
 * Stop the indexer gracefully
 */
function stop() {
  if (!isRunning) return;
  shouldStop = true;
  console.log('   🧠 AI indexer stopping...');
}

/**
 * Get indexer status
 */
function getStatus() {
  return {
    running: isRunning,
    scanned: db.getAiScanCount(),
    totalPhotos: db.getAiTotalPhotos(),
    facesFound: db.getAiTotalFaces(),
    currentFile: stats.currentFile,
    startedAt: stats.startedAt,
    lastActivity: stats.lastActivity,
    errors: stats.errors,
    progress: stats.totalPhotos > 0
      ? Math.round((db.getAiScanCount() / stats.totalPhotos) * 100)
      : 0,
  };
}

module.exports = { start, stop, getStatus };
