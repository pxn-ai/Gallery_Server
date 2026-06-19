/**
 * Face Clustering — DBSCAN with cosine distance
 *
 * Groups face embeddings into person clusters using DBSCAN.
 * Supports incremental clustering: new faces can be assigned to existing clusters.
 */
const db = require('../db');

const EPSILON = 0.55;      // Cosine distance threshold for "same person"
const MIN_SAMPLES = 2;     // Minimum faces to form a cluster

/**
 * Compute cosine distance between two embedding vectors
 * cosine_distance = 1 - cosine_similarity
 *
 * @param {Float32Array|Buffer} a
 * @param {Float32Array|Buffer} b
 * @returns {number} distance in [0, 2]
 */
function cosineDistance(a, b) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) return 2;
  return 1 - (dotProduct / (normA * normB));
}

/**
 * Convert a BLOB from SQLite to Float32Array
 */
function blobToFloat32(blob) {
  if (blob instanceof Float32Array) return blob;
  if (Buffer.isBuffer(blob)) {
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  }
  return new Float32Array(blob);
}

/**
 * DBSCAN clustering algorithm
 *
 * @param {Array<{id, embedding}>} points - Face data with embeddings
 * @param {number} eps - Epsilon (max distance for neighborhood)
 * @param {number} minPts - Minimum points to form a cluster
 * @returns {Map<number, number>} - Map of point index → cluster label (-1 = noise)
 */
function dbscan(points, eps = EPSILON, minPts = MIN_SAMPLES) {
  const n = points.length;
  const labels = new Map(); // index → cluster label
  let clusterLabel = 0;

  // Precompute all embeddings as Float32Arrays
  const embeddings = points.map(p => blobToFloat32(p.embedding));

  // Find neighbors for a point
  function regionQuery(idx) {
    const neighbors = [];
    for (let i = 0; i < n; i++) {
      if (i === idx) continue;
      const dist = cosineDistance(embeddings[idx], embeddings[i]);
      if (dist <= eps) {
        neighbors.push(i);
      }
    }
    return neighbors;
  }

  for (let i = 0; i < n; i++) {
    if (labels.has(i)) continue;

    const neighbors = regionQuery(i);

    if (neighbors.length < minPts - 1) {
      labels.set(i, -1); // Noise
      continue;
    }

    // Start a new cluster
    labels.set(i, clusterLabel);
    const seedSet = [...neighbors];

    for (let j = 0; j < seedSet.length; j++) {
      const q = seedSet[j];

      if (labels.get(q) === -1) {
        labels.set(q, clusterLabel); // Change noise to border point
      }

      if (labels.has(q)) continue;
      labels.set(q, clusterLabel);

      const qNeighbors = regionQuery(q);
      if (qNeighbors.length >= minPts - 1) {
        for (const nn of qNeighbors) {
          if (!seedSet.includes(nn)) {
            seedSet.push(nn);
          }
        }
      }
    }

    clusterLabel++;
  }

  return labels;
}

/**
 * Run full clustering on all face embeddings in the database.
 * Creates/updates people entries.
 *
 * @returns {{ clustersCreated: number, facesAssigned: number, noise: number }}
 */
function clusterAllFaces() {
  console.log('🔗 Running face clustering...');

  // Load all faces with embeddings
  const allFaces = db.getAllFacesWithEmbeddings();
  if (allFaces.length === 0) {
    console.log('   No faces to cluster');
    return { clustersCreated: 0, facesAssigned: 0, noise: 0 };
  }

  console.log(`   ${allFaces.length} faces to cluster`);

  // Run DBSCAN
  const labels = dbscan(allFaces);

  // Group faces by cluster label
  const clusters = new Map(); // clusterLabel → [faceIds]
  let noise = 0;

  for (const [idx, label] of labels) {
    if (label === -1) {
      noise++;
      // Reset person_id for noise faces
      db.updateFacePerson(allFaces[idx].id, null);
      continue;
    }
    if (!clusters.has(label)) clusters.set(label, []);
    clusters.get(label).push(allFaces[idx].id);
  }

  // Clear existing people and reassign
  // We use a transaction for atomicity
  const transaction = db.db.transaction(() => {
    // Remove old person assignments
    for (const face of allFaces) {
      if (face.person_id) {
        db.updateFacePerson(face.id, null);
      }
    }

    // Delete old empty people
    db.deleteEmptyPeople();

    // Create new person for each cluster
    for (const [, faceIds] of clusters) {
      // Pick the face with highest confidence as representative
      let bestFaceId = faceIds[0];
      let bestConfidence = 0;
      for (const faceId of faceIds) {
        const face = db.getFaceById(faceId);
        if (face && face.confidence > bestConfidence) {
          bestConfidence = face.confidence;
          bestFaceId = faceId;
        }
      }

      // Check if there's an existing person that already has most of these faces
      // (for incremental updates — preserve names)
      let existingPerson = null;
      for (const faceId of faceIds) {
        const face = db.getFaceById(faceId);
        if (face && face.person_id) {
          const person = db.getPersonById(face.person_id);
          if (person && person.name) {
            existingPerson = person;
            break;
          }
        }
      }

      let personId;
      if (existingPerson) {
        personId = existingPerson.id;
        db.updatePersonRepFace(personId, bestFaceId);
      } else {
        const result = db.insertPerson({
          name: null,
          representative_face_id: bestFaceId,
          face_count: faceIds.length,
        });
        personId = result.lastInsertRowid;
      }

      // Assign all faces to this person
      for (const faceId of faceIds) {
        db.updateFacePerson(faceId, personId);
      }

      // Update face count
      db.updatePersonFaceCount(personId);
    }
  });

  transaction();

  console.log(`   ✅ ${clusters.size} people found, ${noise} unmatched faces`);
  return {
    clustersCreated: clusters.size,
    facesAssigned: allFaces.length - noise,
    noise,
  };
}

/**
 * Try to assign a single new face to an existing person cluster.
 * If no match is found within EPSILON, returns null.
 *
 * @param {Float32Array} embedding - The new face's embedding
 * @returns {number|null} - Person ID if matched, null otherwise
 */
function findMatchingPerson(embedding) {
  const allFaces = db.getAllFacesWithEmbeddings();
  let bestPersonId = null;
  let bestDist = EPSILON;

  for (const face of allFaces) {
    if (!face.person_id) continue;
    const faceEmb = blobToFloat32(face.embedding);
    const dist = cosineDistance(embedding, faceEmb);
    if (dist < bestDist) {
      bestDist = dist;
      bestPersonId = face.person_id;
    }
  }

  return bestPersonId;
}

module.exports = { clusterAllFaces, findMatchingPerson, cosineDistance, blobToFloat32 };
