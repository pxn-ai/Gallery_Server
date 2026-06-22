/**
 * Face Detector — SCRFD-500M ONNX model
 *
 * Detects faces in images and returns bounding boxes + 5-point landmarks.
 * Uses the SCRFD-500M model (small, fast, good accuracy) via onnxruntime-node.
 */
const ort = require('onnxruntime-node');
const sharp = require('sharp');
const path = require('path');

const MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'scrfd_500m_bnkps_shape640x640.onnx');
const INPUT_SIZE = 640;
const CONF_THRESHOLD = 0.5;
const NMS_THRESHOLD = 0.4;
const STRIDES = [8, 16, 32];
const FMC = 3; // Feature map count

let session = null;
let inputName = null;
let loadFailed = false;

/**
 * Initialize the ONNX session (lazy, cached)
 */
async function ensureSession() {
  if (session) return;
  if (loadFailed) throw new Error('SCRFD model failed to load (previous attempt failed)');

  // Validate model file exists and is not empty
  const fs = require('fs');
  if (!fs.existsSync(MODEL_PATH)) {
    loadFailed = true;
    throw new Error(`SCRFD model not found at ${MODEL_PATH}. Run: npm run download-models`);
  }
  const stat = fs.statSync(MODEL_PATH);
  if (stat.size < 100000) {
    loadFailed = true;
    throw new Error(`SCRFD model file is too small (${stat.size} bytes) — likely corrupt. Delete and re-run: npm run download-models`);
  }

  console.log('🔍 Loading SCRFD face detection model...');
  try {
    session = await ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
    inputName = session.inputNames[0];
    console.log(`   ✅ SCRFD loaded (input: ${inputName})`);
  } catch (err) {
    loadFailed = true;
    throw err;
  }
}

/**
 * Preprocess image to 640x640 Float32Array in NCHW format
 */
async function preprocessImage(imageInput) {
  // imageInput can be a file path or a Buffer
  const { data, info } = await sharp(imageInput)
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const pixelCount = width * height;

  // Convert HWC RGB to NCHW format (the model expects this layout)
  // SCRFD expects pixel values 0-255 as float, no normalization
  const float32 = new Float32Array(3 * pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    float32[i] = data[i * channels];                     // R channel
    float32[pixelCount + i] = data[i * channels + 1];    // G channel
    float32[2 * pixelCount + i] = data[i * channels + 2]; // B channel
  }

  return float32;
}

/**
 * Generate anchors for a given stride
 */
function generateAnchors(stride, height, width) {
  const anchors = [];
  const fh = Math.ceil(height / stride);
  const fw = Math.ceil(width / stride);

  for (let i = 0; i < fh; i++) {
    for (let j = 0; j < fw; j++) {
      // 2 anchors per location for SCRFD
      anchors.push([j, i]);
      anchors.push([j, i]);
    }
  }
  return anchors;
}

/**
 * Compute IoU (Intersection over Union) between two boxes
 */
function computeIoU(boxA, boxB) {
  const x1 = Math.max(boxA[0], boxB[0]);
  const y1 = Math.max(boxA[1], boxB[1]);
  const x2 = Math.min(boxA[2], boxB[2]);
  const y2 = Math.min(boxA[3], boxB[3]);

  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (boxA[2] - boxA[0]) * (boxA[3] - boxA[1]);
  const areaB = (boxB[2] - boxB[0]) * (boxB[3] - boxB[1]);
  const union = areaA + areaB - intersection;

  return union > 0 ? intersection / union : 0;
}

/**
 * Non-Maximum Suppression
 */
function nms(detections, iouThreshold) {
  if (detections.length === 0) return [];

  // Sort by confidence descending
  detections.sort((a, b) => b.confidence - a.confidence);

  const kept = [];
  const suppressed = new Set();

  for (let i = 0; i < detections.length; i++) {
    if (suppressed.has(i)) continue;
    kept.push(detections[i]);

    for (let j = i + 1; j < detections.length; j++) {
      if (suppressed.has(j)) continue;
      const iou = computeIoU(
        [detections[i].bbox.x1, detections[i].bbox.y1, detections[i].bbox.x2, detections[i].bbox.y2],
        [detections[j].bbox.x1, detections[j].bbox.y1, detections[j].bbox.x2, detections[j].bbox.y2]
      );
      if (iou > iouThreshold) {
        suppressed.add(j);
      }
    }
  }

  return kept;
}

/**
 * Post-process SCRFD outputs to extract face detections
 */
function postProcess(outputs, origWidth, origHeight) {
  const detections = [];
  const scaleX = origWidth / INPUT_SIZE;
  const scaleY = origHeight / INPUT_SIZE;

  for (let strideIdx = 0; strideIdx < STRIDES.length; strideIdx++) {
    const stride = STRIDES[strideIdx];
    const anchors = generateAnchors(stride, INPUT_SIZE, INPUT_SIZE);

    // Output tensor names follow pattern: score_8, score_16, score_32, bbox_8, bbox_16, bbox_32, kps_8, etc.
    // But actual names vary by model export. Let's use positional indexing.
    const outputNames = Object.keys(outputs);

    // SCRFD outputs are ordered: [score_8, bbox_8, kps_8, score_16, bbox_16, kps_16, score_32, bbox_32, kps_32]
    const scoreData = outputs[outputNames[strideIdx * FMC]].data;
    const bboxData = outputs[outputNames[strideIdx * FMC + 1]].data;
    const kpsData = outputs[outputNames[strideIdx * FMC + 2]]?.data;

    const numAnchors = anchors.length;

    for (let i = 0; i < numAnchors; i++) {
      const score = scoreData[i];
      if (score < CONF_THRESHOLD) continue;

      const [anchorX, anchorY] = anchors[i];

      // Decode bbox: center offsets + size
      const cx = (anchorX + bboxData[i * 4]) * stride;
      const cy = (anchorY + bboxData[i * 4 + 1]) * stride;
      const w = Math.exp(bboxData[i * 4 + 2]) * stride;
      const h = Math.exp(bboxData[i * 4 + 3]) * stride;

      const x1 = (cx - w / 2) * scaleX;
      const y1 = (cy - h / 2) * scaleY;
      const x2 = (cx + w / 2) * scaleX;
      const y2 = (cy + h / 2) * scaleY;

      // Decode 5-point landmarks if available
      let landmarks = null;
      if (kpsData) {
        landmarks = [];
        for (let k = 0; k < 5; k++) {
          const lx = (anchorX + kpsData[i * 10 + k * 2]) * stride * scaleX;
          const ly = (anchorY + kpsData[i * 10 + k * 2 + 1]) * stride * scaleY;
          landmarks.push({ x: lx, y: ly });
        }
      }

      detections.push({
        bbox: {
          x1: Math.max(0, x1),
          y1: Math.max(0, y1),
          x2: Math.min(origWidth, x2),
          y2: Math.min(origHeight, y2),
        },
        confidence: score,
        landmarks,
      });
    }
  }

  return nms(detections, NMS_THRESHOLD);
}

/**
 * Detect faces in an image
 *
 * @param {string|Buffer} imageInput — file path or image buffer
 * @returns {Promise<Array<{bbox, confidence, landmarks}>>}
 */
async function detectFaces(imageInput) {
  await ensureSession();

  // Get original image dimensions
  const meta = await sharp(imageInput).metadata();
  const origWidth = meta.width;
  const origHeight = meta.height;

  // Preprocess
  const inputData = await preprocessImage(imageInput);
  const inputTensor = new ort.Tensor('float32', inputData, [1, 3, INPUT_SIZE, INPUT_SIZE]);

  // Run inference
  const feeds = {};
  feeds[inputName] = inputTensor;
  const results = await session.run(feeds);

  // Post-process
  const detections = postProcess(results, origWidth, origHeight);

  return detections.map(d => ({
    bbox: {
      x: d.bbox.x1 / origWidth,
      y: d.bbox.y1 / origHeight,
      w: (d.bbox.x2 - d.bbox.x1) / origWidth,
      h: (d.bbox.y2 - d.bbox.y1) / origHeight,
    },
    confidence: d.confidence,
    landmarks: d.landmarks ? d.landmarks.map(l => ({
      x: l.x / origWidth,
      y: l.y / origHeight,
    })) : null,
  }));
}

/**
 * Release the ONNX session (for graceful shutdown)
 */
async function dispose() {
  if (session) {
    await session.release();
    session = null;
    console.log('   SCRFD session released');
  }
}

module.exports = { detectFaces, dispose };
