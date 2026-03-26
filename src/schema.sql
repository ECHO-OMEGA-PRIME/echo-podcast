-- Echo Podcast — Podcast Hosting Platform
-- D1 Schema

CREATE TABLE IF NOT EXISTS shows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  author TEXT,
  owner_name TEXT,
  owner_email TEXT,
  language TEXT DEFAULT 'en',
  category TEXT,
  subcategory TEXT,
  explicit INTEGER DEFAULT 0,
  website TEXT,
  image_url TEXT,
  cover_url TEXT,
  brand_color TEXT DEFAULT '#0d7377',
  itunes_id TEXT,
  spotify_url TEXT,
  google_url TEXT,
  social JSON DEFAULT '{}',
  tags JSON DEFAULT '[]',
  status TEXT DEFAULT 'active',
  total_episodes INTEGER DEFAULT 0,
  total_downloads INTEGER DEFAULT 0,
  total_subscribers INTEGER DEFAULT 0,
  avg_duration_min REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  content TEXT,
  audio_url TEXT,
  audio_key TEXT,
  duration_sec INTEGER DEFAULT 0,
  file_size INTEGER DEFAULT 0,
  season INTEGER,
  episode_number INTEGER,
  episode_type TEXT DEFAULT 'full',
  explicit INTEGER DEFAULT 0,
  image_url TEXT,
  transcript TEXT,
  show_notes TEXT,
  chapters JSON DEFAULT '[]',
  tags JSON DEFAULT '[]',
  guests JSON DEFAULT '[]',
  links JSON DEFAULT '[]',
  status TEXT DEFAULT 'draft',
  published_at TEXT,
  scheduled_at TEXT,
  total_downloads INTEGER DEFAULT 0,
  total_listens INTEGER DEFAULT 0,
  avg_listen_pct REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(show_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_episodes_show ON episodes(show_id, status);
CREATE INDEX IF NOT EXISTS idx_episodes_published ON episodes(published_at);

CREATE TABLE IF NOT EXISTS downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL,
  show_id INTEGER NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  country TEXT,
  city TEXT,
  device TEXT,
  app TEXT,
  referrer TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_downloads_episode ON downloads(episode_id);
CREATE INDEX IF NOT EXISTS idx_downloads_date ON downloads(created_at);

CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  source TEXT DEFAULT 'website',
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(show_id, email)
);

CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  episode_ids JSON DEFAULT '[]',
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(show_id, slug)
);

CREATE TABLE IF NOT EXISTS analytics_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  downloads INTEGER DEFAULT 0,
  unique_listeners INTEGER DEFAULT 0,
  new_subscribers INTEGER DEFAULT 0,
  top_episode_id INTEGER,
  top_country TEXT,
  top_app TEXT,
  UNIQUE(show_id, date)
);

CREATE TABLE IF NOT EXISTS embed_players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id INTEGER NOT NULL,
  episode_id INTEGER,
  type TEXT DEFAULT 'single',
  style JSON DEFAULT '{}',
  short_code TEXT NOT NULL UNIQUE,
  total_plays INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  show_id INTEGER,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
