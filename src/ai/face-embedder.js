/**
 * Face Embedder — ArcFace R100 ONNX model
 *
 * Takes a face image (with landmarks for alignment) and produces a 512-dimensional
 * embedding vector for face recognition/clustering.
 */
const ort = require('onnxruntime-node');
const sharp = require('sharp');
const path = require('path');

const MODEL_PATH = path.join(__dirname, '..', '..', 'models', 'arcface_r100_v1.onnx');
const FACE_SIZE = 112;

let session = null;
let inputName = null;

// Standard alignment reference points for ArcFace 112x112
// These are the "ideal" positions of [left_eye, right_eye, nose, left_mouth, right_mouth]
const REF_POINTS = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/**
 * Initialize the ONNX session (lazy, cached)
 */
async function ensureSession() {
  if (session) return;
  console.log('🧠 Loading ArcFace embedding model...');
  session = await ort.InferenceSession.create(MODEL_PATH, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });
  inputName = session.inputNames[0];
  console.log(`   ✅ ArcFace loaded (input: ${inputName})`);
}

/**
 * Compute a 2D affine transformation matrix from source to destination points.
 * Uses least-squares fitting for the similarity transform (rotation, scale, translation).
 *
 * @param {Array} src - Source points [[x1,y1], [x2,y2], ...]
 * @param {Array} dst - Destination points [[x1,y1], [x2,y2], ...]
 * @returns {Array} 2x3 affine matrix [[a, b, tx], [c, d, ty]]
 */
function estimateSimilarityTransform(src, dst) {
  const n = src.length;

  // Build the system of equations for least-squares
  // We want to find [a, b, tx, ty] such that:
  //   dst_x = a * src_x - b * src_y + tx
  //   dst_y = b * src_x + a * src_y + ty
  let sumSrcX = 0, sumSrcY = 0, sumDstX = 0, sumDstY = 0;
  let sumSrcXSrcX = 0, sumSrcYSrcY = 0;
  let sumSrcXDstX = 0, sumSrcYDstX = 0;
  let sumSrcXDstY = 0, sumSrcYDstY = 0;

  for (let i = 0; i < n; i++) {
    const sx = src[i][0], sy = src[i][1];
    const dx = dst[i][0], dy = dst[i][1];
    sumSrcX += sx; sumSrcY += sy;
    sumDstX += dx; sumDstY += dy;
    sumSrcXSrcX += sx * sx; sumSrcYSrcY += sy * sy;
    sumSrcXDstX += sx * dx; sumSrcYDstX += sy * dx;
    sumSrcXDstY += sx * dy; sumSrcYDstY += sy * dy;
  }

  const sumSrcSq = sumSrcXSrcX + sumSrcYSrcY;
  const denom = n * sumSrcSq - sumSrcX * sumSrcX - sumSrcY * sumSrcY;

  if (Math.abs(denom) < 1e-10) {
    // Degenerate case, return identity
    return [[1, 0, 0], [0, 1, 0]];
  }

  const a = (sumSrcSq * 0 + n * (sumSrcXDstX + sumSrcYDstY) - sumSrcX * sumDstX - sumSrcY * sumDstY) / (n * sumSrcSq - sumSrcX * sumSrcX - sumSrcY * sumSrcY);
  const b = (n * (sumSrcXDstY - sumSrcYDstX) - sumSrcX * sumDstY + sumSrcY * sumDstX) / (n * sumSrcSq - sumSrcX * sumSrcX - sumSrcY * sumSrcY);

  // Simpler approach: compute scale + rotation from point pairs
  // Use the first two points (eyes) for a robust estimate
  const srcDx = src[1][0] - src[0][0];
  const srcDy = src[1][1] - src[0][1];
  const dstDx = dst[1][0] - dst[0][0];
  const dstDy = dst[1][1] - dst[0][1];

  const srcDist = Math.sqrt(srcDx * srcDx + srcDy * srcDy);
  const dstDist = Math.sqrt(dstDx * dstDx + dstDy * dstDy);

  if (srcDist < 1e-6) return [[1, 0, 0], [0, 1, 0]];

  const scale = dstDist / srcDist;
  const angle = Math.atan2(dstDy, dstDx) - Math.atan2(srcDy, srcDx);

  const cosA = scale * Math.cos(angle);
  const sinA = scale * Math.sin(angle);

  // Compute translation using centroid
  const srcCx = sumSrcX / n;
  const srcCy = sumSrcY / n;
  const dstCx = sumDstX / n;
  const dstCy = sumDstY / n;

  const tx = dstCx - cosA * srcCx + sinA * srcCy;
  const ty = dstCy - sinA * srcCx - cosA * srcCy;

  return [[cosA, -sinA, tx], [sinA, cosA, ty]];
}

/**
 * Apply affine transform to crop and align a face from an image buffer.
 * Uses Sharp for the actual image manipulation.
 *
 * @param {string|Buffer} imageInput - Original image path or buffer
 * @param {Array} landmarks - 5 facial landmarks [{x, y}] in normalized coords (0-1)
 * @param {number} imgWidth - Original image width
 * @param {number} imgHeight - Original image height
 * @returns {Promise<Buffer>} - Aligned 112x112 face as raw RGB buffer
 */
async function alignFace(imageInput, landmarks, imgWidth, imgHeight) {
  // Convert normalized landmarks to pixel coordinates
  const srcPoints = landmarks.map(l => [l.x * imgWidth, l.y * imgHeight]);

  // Compute affine matrix from source landmarks to reference points
  const M = estimateSimilarityTransform(srcPoints, REF_POINTS);

  // Instead of full affine warp (which Sharp doesn't support directly),
  // we'll extract a region around the face, resize, and use the landmarks
  // to compute a crop that approximates alignment

  // Compute the bounding box of where the aligned face should come from
  // by inverting the transform on the 112x112 corners
  const det = M[0][0] * M[1][1] - M[0][1] * M[1][0];
  if (Math.abs(det) < 1e-10) {
    // Fallback: simple center crop
    const cx = (srcPoints[0][0] + srcPoints[1][0]) / 2;
    const cy = (srcPoints[0][1] + srcPoints[1][1]) / 2;
    const eyeDist = Math.sqrt(
      Math.pow(srcPoints[1][0] - srcPoints[0][0], 2) +
      Math.pow(srcPoints[1][1] - srcPoints[0][1], 2)
    );
    const size = Math.max(eyeDist * 3.5, 50);
    const left = Math.max(0, Math.round(cx - size / 2));
    const top = Math.max(0, Math.round(cy - size * 0.4));
    const right = Math.min(imgWidth, Math.round(cx + size / 2));
    const bottom = Math.min(imgHeight, Math.round(top + size));

    return sharp(imageInput)
      .extract({ left, top, width: right - left, height: bottom - top })
      .resize(FACE_SIZE, FACE_SIZE, { fit: 'cover' })
      .removeAlpha()
      .raw()
      .toBuffer();
  }

  // Inverse transform matrix
  const invDet = 1 / det;
  const invM = [
    [M[1][1] * invDet, -M[0][1] * invDet, (M[0][1] * M[1][2] - M[1][1] * M[0][2]) * invDet],
    [-M[1][0] * invDet, M[0][0] * invDet, (M[1][0] * M[0][2] - M[0][0] * M[1][2]) * invDet],
  ];

  // Find the bounding box in source image that maps to the 112x112 output
  const corners = [[0, 0], [FACE_SIZE, 0], [FACE_SIZE, FACE_SIZE], [0, FACE_SIZE]];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const [cx, cy] of corners) {
    const sx = invM[0][0] * cx + invM[0][1] * cy + invM[0][2];
    const sy = invM[1][0] * cx + invM[1][1] * cy + invM[1][2];
    minX = Math.min(minX, sx);
    minY = Math.min(minY, sy);
    maxX = Math.max(maxX, sx);
    maxY = Math.max(maxY, sy);
  }

  // Clamp to image bounds
  const left = Math.max(0, Math.floor(minX));
  const top = Math.max(0, Math.floor(minY));
  const right = Math.min(imgWidth, Math.ceil(maxX));
  const bottom = Math.min(imgHeight, Math.ceil(maxY));
  const cropW = right - left;
  const cropH = bottom - top;

  if (cropW < 10 || cropH < 10) {
    // Face too small, return null
    return null;
  }

  // Extract the region and resize to 112x112
  return sharp(imageInput)
    .extract({ left, top, width: cropW, height: cropH })
    .resize(FACE_SIZE, FACE_SIZE, { fit: 'cover', position: 'centre' })
    .removeAlpha()
    .raw()
    .toBuffer();
}

/**
 * Get face embedding from an aligned face buffer
 *
 * @param {Buffer} faceRgbBuffer - Raw RGB buffer of 112x112 aligned face
 * @returns {Promise<Float32Array>} - L2-normalized 512-dim embedding
 */
async function getEmbeddingFromAligned(faceRgbBuffer) {
  await ensureSession();

  const pixelCount = FACE_SIZE * FACE_SIZE;
  const float32 = new Float32Array(3 * pixelCount);

  // Convert HWC RGB to NCHW, normalize: (pixel - 127.5) / 128.0
  for (let i = 0; i < pixelCount; i++) {
    float32[i] = (faceRgbBuffer[i * 3] - 127.5) / 128.0;                    // R
    float32[pixelCount + i] = (faceRgbBuffer[i * 3 + 1] - 127.5) / 128.0;   // G
    float32[2 * pixelCount + i] = (faceRgbBuffer[i * 3 + 2] - 127.5) / 128.0; // B
  }

  const inputTensor = new ort.Tensor('float32', float32, [1, 3, FACE_SIZE, FACE_SIZE]);
  const feeds = {};
  feeds[inputName] = inputTensor;

  const results = await session.run(feeds);
  const outputName = session.outputNames[0];
  const embedding = new Float32Array(results[outputName].data);

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < embedding.length; i++) {
    norm += embedding[i] * embedding[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] /= norm;
    }
  }

  return embedding;
}

/**
 * Get face embedding from an image with landmarks
 *
 * @param {string|Buffer} imageInput - Image path or buffer
 * @param {Array} landmarks - 5 facial landmarks [{x, y}] in normalized coords
 * @returns {Promise<Float32Array|null>} - 512-dim embedding or null if alignment fails
 */
async function getEmbedding(imageInput, landmarks) {
  const meta = await sharp(imageInput).metadata();

  const alignedBuffer = await alignFace(imageInput, landmarks, meta.width, meta.height);
  if (!alignedBuffer) return null;

  return getEmbeddingFromAligned(alignedBuffer);
}

/**
 * Release the ONNX session
 */
async function dispose() {
  if (session) {
    await session.release();
    session = null;
    console.log('   ArcFace session released');
  }
}

module.exports = { getEmbedding, alignFace, getEmbeddingFromAligned, dispose };
