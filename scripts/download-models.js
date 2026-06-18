/**
 * Download ONNX models for face detection and recognition
 * Models are downloaded from GitHub releases / ONNX Model Zoo
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MODELS_DIR = path.join(__dirname, '..', 'models');

const MODELS = [
  {
    name: 'scrfd_500m_bnkps_shape640x640.onnx',
    // SCRFD-500M face detection model from InsightFace
    url: 'https://github.com/deepinsight/insightface/releases/download/v0.7/scrfd_500m_bnkps_shape640x640.onnx',
    description: 'Face detection (SCRFD-500M)',
  },
  {
    name: 'arcface_r100_v1.onnx',
    // ArcFace recognition model
    url: 'https://github.com/deepinsight/insightface/releases/download/v0.7/arcface_r100_v1.onnx',
    description: 'Face recognition (ArcFace R100)',
  },
];

function downloadFile(url, destPath, description) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(destPath)) {
      const size = fs.statSync(destPath).size;
      if (size > 100000) { // > 100KB means likely valid
        console.log(`  ✅ ${description} — already downloaded (${(size / 1024 / 1024).toFixed(1)} MB)`);
        return resolve();
      }
    }

    console.log(`  ⬇️  Downloading ${description}...`);
    const file = fs.createWriteStream(destPath);
    let totalBytes = 0;

    function doRequest(requestUrl) {
      const protocol = requestUrl.startsWith('https') ? https : http;
      protocol.get(requestUrl, { headers: { 'User-Agent': 'GalleryServer/2.0' } }, (res) => {
        // Handle redirects
        if (res.statusCode === 301 || res.statusCode === 302) {
          return doRequest(res.headers.location);
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${requestUrl}`));
          return;
        }

        const contentLength = parseInt(res.headers['content-length'] || '0');

        res.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (contentLength > 0) {
            const pct = Math.round((totalBytes / contentLength) * 100);
            process.stdout.write(`\r     ${(totalBytes / 1024 / 1024).toFixed(1)} MB / ${(contentLength / 1024 / 1024).toFixed(1)} MB (${pct}%)`);
          }
        });

        res.pipe(file);

        file.on('finish', () => {
          file.close();
          console.log(`\n  ✅ ${description} — ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }

    doRequest(url);
  });
}

async function main() {
  console.log('\n🤖 Gallery Server — Model Download\n');

  fs.mkdirSync(MODELS_DIR, { recursive: true });

  for (const model of MODELS) {
    const destPath = path.join(MODELS_DIR, model.name);
    try {
      await downloadFile(model.url, destPath, model.description);
    } catch (err) {
      console.error(`  ❌ Failed to download ${model.description}: ${err.message}`);
      console.error(`     You can manually download from: ${model.url}`);
      console.error(`     And place it at: ${destPath}\n`);
    }
  }

  console.log('\n✅ Model download complete!\n');
}

main().catch(console.error);
