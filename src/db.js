const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', '.gallery_cache', 'gallery.db');

// Ensure cache directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT UNIQUE NOT NULL,
    file_name TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('photo', 'video')),
    file_size INTEGER DEFAULT 0,
    width INTEGER,
    height INTEGER,
    duration REAL,
    date_taken TEXT,
    date_modified TEXT,
    thumb_path TEXT,
    preview_path TEXT,
    scanned_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_media_type ON media(media_type);
  CREATE INDEX IF NOT EXISTS idx_media_date ON media(date_taken DESC);
  CREATE INDEX IF NOT EXISTS idx_media_modified ON media(date_modified DESC);
  CREATE INDEX IF NOT EXISTS idx_media_path ON media(file_path);

  -- Face detections (one row per face found in a photo)
  CREATE TABLE IF NOT EXISTS faces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    bbox_x REAL NOT NULL,
    bbox_y REAL NOT NULL,
    bbox_w REAL NOT NULL,
    bbox_h REAL NOT NULL,
    confidence REAL,
    embedding BLOB,
    person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_faces_media ON faces(media_id);
  CREATE INDEX IF NOT EXISTS idx_faces_person ON faces(person_id);

  -- Person clusters (one row per unique person)
  CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    representative_face_id INTEGER,
    face_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Track AI scan progress
  CREATE TABLE IF NOT EXISTS ai_scan_status (
    media_id INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
    scanned_at TEXT DEFAULT (datetime('now')),
    faces_found INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_ai_scan ON ai_scan_status(media_id);
`);

// Prepared statements
const stmts = {
  // Media CRUD
  upsert: db.prepare(`
    INSERT INTO media (file_path, file_name, media_type, file_size, width, height, duration, date_taken, date_modified)
    VALUES (@file_path, @file_name, @media_type, @file_size, @width, @height, @duration, @date_taken, @date_modified)
    ON CONFLICT(file_path) DO UPDATE SET
      file_size = @file_size, width = @width, height = @height, duration = @duration,
      date_taken = @date_taken, date_modified = @date_modified, scanned_at = datetime('now')
  `),
  updateThumb: db.prepare(`UPDATE media SET thumb_path = @thumb_path WHERE id = @id`),
  updatePreview: db.prepare(`UPDATE media SET preview_path = @preview_path WHERE id = @id`),
  getById: db.prepare(`SELECT * FROM media WHERE id = ?`),
  getPage: db.prepare(`
    SELECT * FROM media
    WHERE (@type = 'all' OR media_type = @type)
    ORDER BY COALESCE(date_taken, date_modified) DESC
    LIMIT @limit OFFSET @offset
  `),
  getCount: db.prepare(`
    SELECT COUNT(*) as count FROM media WHERE (@type = 'all' OR media_type = @type)
  `),
  getStats: db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN media_type = 'photo' THEN 1 ELSE 0 END) as photos,
      SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END) as videos,
      SUM(file_size) as total_size
    FROM media
  `),
  getAll: db.prepare(`SELECT file_path FROM media`),
  deleteByPath: db.prepare(`DELETE FROM media WHERE file_path = ?`),
  getByPath: db.prepare(`SELECT * FROM media WHERE file_path = ?`),

  // Face CRUD
  insertFace: db.prepare(`
    INSERT INTO faces (media_id, bbox_x, bbox_y, bbox_w, bbox_h, confidence, embedding, person_id)
    VALUES (@media_id, @bbox_x, @bbox_y, @bbox_w, @bbox_h, @confidence, @embedding, @person_id)
  `),
  getFacesByMedia: db.prepare(`SELECT * FROM faces WHERE media_id = ?`),
  getFaceById: db.prepare(`SELECT * FROM faces WHERE id = ?`),
  getFacesByPerson: db.prepare(`SELECT * FROM faces WHERE person_id = ?`),
  updateFacePerson: db.prepare(`UPDATE faces SET person_id = @person_id WHERE id = @id`),
  getAllFacesWithEmbeddings: db.prepare(`SELECT id, embedding, person_id FROM faces WHERE embedding IS NOT NULL`),

  // People CRUD
  insertPerson: db.prepare(`
    INSERT INTO people (name, representative_face_id, face_count) VALUES (@name, @representative_face_id, @face_count)
  `),
  getAllPeople: db.prepare(`
    SELECT p.*, f.media_id as rep_media_id
    FROM people p
    LEFT JOIN faces f ON f.id = p.representative_face_id
    WHERE p.face_count > 0
    ORDER BY p.face_count DESC
  `),
  getPersonById: db.prepare(`SELECT * FROM people WHERE id = ?`),
  updatePersonName: db.prepare(`UPDATE people SET name = @name WHERE id = @id`),
  updatePersonFaceCount: db.prepare(`
    UPDATE people SET face_count = (SELECT COUNT(*) FROM faces WHERE person_id = @id) WHERE id = @id
  `),
  updatePersonRepFace: db.prepare(`
    UPDATE people SET representative_face_id = @face_id WHERE id = @id
  `),
  deletePerson: db.prepare(`DELETE FROM people WHERE id = ?`),

  // Media for a person (through faces)
  getMediaByPerson: db.prepare(`
    SELECT DISTINCT m.* FROM media m
    INNER JOIN faces f ON f.media_id = m.id
    WHERE f.person_id = @person_id
    ORDER BY COALESCE(m.date_taken, m.date_modified) DESC
    LIMIT @limit OFFSET @offset
  `),
  getMediaCountByPerson: db.prepare(`
    SELECT COUNT(DISTINCT m.id) as count FROM media m
    INNER JOIN faces f ON f.media_id = m.id
    WHERE f.person_id = ?
  `),

  // AI scan status
  markAiScanned: db.prepare(`
    INSERT OR REPLACE INTO ai_scan_status (media_id, faces_found, scanned_at)
    VALUES (@media_id, @faces_found, datetime('now'))
  `),
  isAiScanned: db.prepare(`SELECT 1 FROM ai_scan_status WHERE media_id = ?`),
  getAiScanCount: db.prepare(`SELECT COUNT(*) as count FROM ai_scan_status`),
  getUnscannedPhotos: db.prepare(`
    SELECT m.* FROM media m
    LEFT JOIN ai_scan_status a ON a.media_id = m.id
    WHERE a.media_id IS NULL AND m.media_type = 'photo'
    ORDER BY m.id
    LIMIT ?
  `),

  // Timeline queries
  getTimeline: db.prepare(`
    SELECT
      strftime('%Y-%m', COALESCE(date_taken, date_modified)) as month,
      COUNT(*) as count,
      SUM(CASE WHEN media_type = 'photo' THEN 1 ELSE 0 END) as photos,
      SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END) as videos
    FROM media
    GROUP BY month
    ORDER BY month DESC
  `),
  getMediaByMonth: db.prepare(`
    SELECT * FROM media
    WHERE strftime('%Y-%m', COALESCE(date_taken, date_modified)) = @month
    ORDER BY COALESCE(date_taken, date_modified) DESC
    LIMIT @limit OFFSET @offset
  `),
  getMediaCountByMonth: db.prepare(`
    SELECT COUNT(*) as count FROM media
    WHERE strftime('%Y-%m', COALESCE(date_taken, date_modified)) = ?
  `),
};

module.exports = {
  db,

  // Media operations
  upsertMedia(data) { return stmts.upsert.run(data); },
  updateThumbPath(id, thumbPath) { return stmts.updateThumb.run({ id, thumb_path: thumbPath }); },
  updatePreviewPath(id, previewPath) { return stmts.updatePreview.run({ id, preview_path: previewPath }); },
  getMediaById(id) { return stmts.getById.get(id); },
  getMediaByPath(filePath) { return stmts.getByPath.get(filePath); },
  getMediaPage(page = 1, limit = 60, type = 'all') {
    const offset = (page - 1) * limit;
    return stmts.getPage.all({ type, limit, offset });
  },
  getMediaCount(type = 'all') { return stmts.getCount.get({ type }).count; },
  getStats() { return stmts.getStats.get(); },
  getAllPaths() { return stmts.getAll.all().map(r => r.file_path); },
  deleteByPath(filePath) { return stmts.deleteByPath.run(filePath); },

  // Face operations
  insertFace(data) { return stmts.insertFace.run(data); },
  getFacesByMedia(mediaId) { return stmts.getFacesByMedia.all(mediaId); },
  getFaceById(id) { return stmts.getFaceById.get(id); },
  getFacesByPerson(personId) { return stmts.getFacesByPerson.all(personId); },
  updateFacePerson(faceId, personId) { return stmts.updateFacePerson.run({ id: faceId, person_id: personId }); },
  getAllFacesWithEmbeddings() { return stmts.getAllFacesWithEmbeddings.all(); },

  // People operations
  insertPerson(data) { return stmts.insertPerson.run(data); },
  getAllPeople() { return stmts.getAllPeople.all(); },
  getPersonById(id) { return stmts.getPersonById.get(id); },
  updatePersonName(id, name) { return stmts.updatePersonName.run({ id, name }); },
  updatePersonFaceCount(id) { return stmts.updatePersonFaceCount.run({ id }); },
  updatePersonRepFace(id, faceId) { return stmts.updatePersonRepFace.run({ id, face_id: faceId }); },
  deletePerson(id) { return stmts.deletePerson.run(id); },
  getMediaByPerson(personId, page = 1, limit = 60) {
    const offset = (page - 1) * limit;
    return stmts.getMediaByPerson.all({ person_id: personId, limit, offset });
  },
  getMediaCountByPerson(personId) { return stmts.getMediaCountByPerson.get(personId).count; },

  // AI scan
  markAiScanned(mediaId, facesFound) { return stmts.markAiScanned.run({ media_id: mediaId, faces_found: facesFound }); },
  isAiScanned(mediaId) { return !!stmts.isAiScanned.get(mediaId); },
  getAiScanCount() { return stmts.getAiScanCount.get().count; },
  getUnscannedPhotos(limit = 50) { return stmts.getUnscannedPhotos.all(limit); },

  // Timeline
  getTimeline() { return stmts.getTimeline.all(); },
  getMediaByMonth(month, page = 1, limit = 60) {
    const offset = (page - 1) * limit;
    return stmts.getMediaByMonth.all({ month, limit, offset });
  },
  getMediaCountByMonth(month) { return stmts.getMediaCountByMonth.get(month).count; },
};
