-- Agent Sell Stuff -- consolidated schema.
-- Run once against your D1 database:
--   npx wrangler d1 execute sellstuff --remote --file migrations/0001_init.sql
-- Safe to re-run: every statement is IF NOT EXISTS.

-- One row per thing you are selling.
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,              -- kebab-case id, e.g. "blue-drill-3f9a"
  title TEXT,
  description TEXT,
  category TEXT,                          -- one of Facebook's own category labels
  condition TEXT,                         -- New | Like New | Good | Fair | Salvage
  notes TEXT,                             -- your Telegram caption, verbatim

  price_ask REAL,
  price_floor REAL,                       -- lowest you would accept; price drops never go under it
  pricing_reasoning TEXT,                 -- the AI's own words on how it priced it ("why")
  price_confidence TEXT,                  -- high | medium | low

  -- draft | researched | pending_approval | approved | posting | posted
  -- | sold | rejected | archived | needs_attention
  status TEXT NOT NULL DEFAULT 'draft',

  fb_listing_url TEXT,                    -- permalink, when the poster could capture it
  fb_card_title TEXT,                     -- exact "Your listings" card title you confirmed for this item
  posted_at TEXT,
  sold_at TEXT,

  edit_queued INTEGER DEFAULT 0,          -- 0 none, 1 queued, 2 claimed by the poster
  delete_queued INTEGER DEFAULT 0,        -- 0 none, 1 queued, 2 claimed by the poster. A delete, never "mark sold".
  awaiting_decision INTEGER DEFAULT 0,    -- 1 = a Telegram question is open; the poster skips this item

  post_attempts INTEGER NOT NULL DEFAULT 0,   -- strikes. 3 = parked as needs_attention
  last_post_error TEXT,
  last_post_error_at TEXT,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS items_status ON items (status, updated_at);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  r2_key TEXT NOT NULL,
  ord INTEGER DEFAULT 0                   -- 0 = hero photo
);
CREATE INDEX IF NOT EXISTS photos_item ON photos (item_id, ord);

-- Price evidence. source 'ai-estimate' is the model's guess and is never
-- presented as a real sold comp.
CREATE TABLE IF NOT EXISTS comps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id),
  source TEXT,                            -- 'ai-estimate' | 'ebay-sold' | 'marketplace' | 'other'
  title TEXT, price REAL, url TEXT, note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Audit log. Every state change and every decision lands here.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER REFERENCES items(id),
  type TEXT NOT NULL,                     -- intake|research|proposed|approved|rejected|posted|sold|archived|note
  payload TEXT,                           -- JSON
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS events_item ON events (item_id, id);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER UNIQUE NOT NULL REFERENCES items(id),
  sold_price REAL NOT NULL,
  sold_at TEXT NOT NULL,
  days_listed INTEGER,
  buyer_note TEXT
);

-- Telegram photo bursts. A multi-photo send arrives as several webhook updates
-- sharing one media_group_id; they are buffered here until the burst goes quiet,
-- then researched once.
CREATE TABLE IF NOT EXISTS intake_buffer (
  group_key TEXT PRIMARY KEY,             -- "mg:<media_group_id>" or "single:<message_id>"
  chat_id TEXT NOT NULL,
  item_id INTEGER REFERENCES items(id),
  slug TEXT,
  caption TEXT,                           -- first non-empty caption in the burst = your notes
  n_photos INTEGER DEFAULT 0,
  finalized INTEGER DEFAULT 0,
  last_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);

-- Every judgement call becomes a Telegram question with buttons.
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER,
  kind TEXT NOT NULL,                     -- nothing_sellable | which_listing | looks_gone | category | floor_block
  question TEXT,
  payload TEXT,                           -- JSON the answer handler needs
  choices TEXT,                           -- JSON [{key, text}] exactly as offered, so a stale tap resolves against what was shown
  status TEXT DEFAULT 'pending',          -- pending | answered | superseded
  answer TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS decisions_pending ON decisions (status, created_at);
CREATE INDEX IF NOT EXISTS decisions_item ON decisions (item_id, status);

-- Telegram message_id -> item, so replying to a card tells us which item you mean.
CREATE TABLE IF NOT EXISTS cards (
  message_id TEXT PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  created_at TEXT DEFAULT (datetime('now'))
);
