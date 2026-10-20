-- Buyer messages + pickups.
--
-- The poster reads the Marketplace inbox; the Worker drafts each reply and asks
-- you on Telegram; only text you approved is ever sent.
--
-- Apply: npm run db:buyers   (new installs get it from npm run db:init)

-- Small settings store: pickup spot and pickup hours.
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- One row per Marketplace conversation. thread_key is Facebook's thread id
-- (from the /messages/t/<id> URL). transcript = the last ~20 messages the
-- poster read, as JSON [{dir:'in'|'out', body}], oldest first.
CREATE TABLE IF NOT EXISTS buyer_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_key TEXT UNIQUE NOT NULL,
  thread_url TEXT,
  buyer_name TEXT,
  listing_title TEXT,
  item_id INTEGER REFERENCES items(id),
  transcript TEXT,
  last_in_hash TEXT,          -- the latest buyer message we already drafted for
  muted INTEGER DEFAULT 0,    -- you said "ignore this buyer"
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- A drafted reply waiting on you, then on the poster.
--   pending   card sent, waiting for your tap
--   approved  you tapped Send (or typed your own words) — poster may claim it
--   sending   the poster holds it (a lock, like items.status='posting')
--   sent      typed into Facebook and seen in the thread
--   failed    the poster could not send it; NEVER retried automatically
--   skipped   you tapped Skip
--   superseded  a newer buyer message arrived before you answered
CREATE TABLE IF NOT EXISTS buyer_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES buyer_threads(id),
  in_hash TEXT,
  intent TEXT,                -- answer | propose_meetup | confirm_meetup | decline | sold_elsewhere
  draft TEXT NOT NULL,
  final_text TEXT,            -- what actually goes out (draft, or your own words)
  meetup_at TEXT,             -- local "YYYY-MM-DDTHH:MM" in TIMEZONE
  meetup_place TEXT,
  price INTEGER,              -- agreed price, when the buyer and draft settle on one
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS buyer_replies_status ON buyer_replies(status);

-- A pickup that a buyer agreed to and you confirmed.
--   booked → done (sold) | no_show | cancelled
CREATE TABLE IF NOT EXISTS meetups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER REFERENCES buyer_threads(id),
  item_id INTEGER REFERENCES items(id),
  buyer_name TEXT,
  at TEXT NOT NULL,           -- local "YYYY-MM-DDTHH:MM" in TIMEZONE
  place TEXT,
  price INTEGER,
  status TEXT NOT NULL DEFAULT 'booked',
  reminded INTEGER DEFAULT 0, -- 1 = the hour-before reminder went out
  followed_up INTEGER DEFAULT 0, -- 1 = the "did it sell?" card went out
  created_at TEXT DEFAULT (datetime('now'))
);
