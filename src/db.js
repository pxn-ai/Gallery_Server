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
`);

// Prepared statements
const stmts = {
  upsert: db.prepare(`
    INSERT INTO media (file_path, file_name, media_type, file_size, width, height, duration, date_taken, date_modified)
    VALUES (@file_path, @file_name, @media_type, @file_size, @width, @height, @duration, @date_taken, @date_modified)
    ON CONFLICT(file_path) DO UPDATE SET
      file_size = @file_size,
      width = @width,
      height = @height,
      duration = @duration,
      date_taken = @date_taken,
      date_modified = @date_modified,
      scanned_at = datetime('now')
  `),

  updateThumb: db.prepare(`
    UPDATE media SET thumb_path = @thumb_path WHERE id = @id
  `),

  updatePreview: db.prepare(`
    UPDATE media SET preview_path = @preview_path WHERE id = @id
  `),

  getById: db.prepare(`SELECT * FROM media WHERE id = ?`),

  getPage: db.prepare(`
    SELECT * FROM media
    WHERE (@type = 'all' OR media_type = @type)
    ORDER BY COALESCE(date_taken, date_modified) DESC
    LIMIT @limit OFFSET @offset
  `),

  getCount: db.prepare(`
    SELECT COUNT(*) as count FROM media
    WHERE (@type = 'all' OR media_type = @type)
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
};

module.exports = {
  db,
  upsertMedia(data) {
    return stmts.upsert.run(data);
  },
  updateThumbPath(id, thumbPath) {
    return stmts.updateThumb.run({ id, thumb_path: thumbPath });
  },
  updatePreviewPath(id, previewPath) {
    return stmts.updatePreview.run({ id, preview_path: previewPath });
  },
  getMediaById(id) {
    return stmts.getById.get(id);
  },
  getMediaByPath(filePath) {
    return stmts.getByPath.get(filePath);
  },
  getMediaPage(page = 1, limit = 60, type = 'all') {
    const offset = (page - 1) * limit;
    return stmts.getPage.all({ type, limit, offset });
  },
  getMediaCount(type = 'all') {
    return stmts.getCount.get({ type }).count;
  },
  getStats() {
    return stmts.getStats.get();
  },
  getAllPaths() {
    return stmts.getAll.all().map(r => r.file_path);
  },
  deleteByPath(filePath) {
    return stmts.deleteByPath.run(filePath);
  },
};
