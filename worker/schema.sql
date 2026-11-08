CREATE TABLE IF NOT EXISTS likes (
  photo   TEXT NOT NULL,
  album   TEXT NOT NULL,
  client  TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (photo, client)
);
CREATE INDEX IF NOT EXISTS likes_album ON likes (album);

CREATE TABLE IF NOT EXISTS comments (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  photo   TEXT NOT NULL,
  album   TEXT NOT NULL,
  name    TEXT NOT NULL,
  text    TEXT NOT NULL,
  client  TEXT NOT NULL,
  created INTEGER NOT NULL,
  hidden  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS comments_photo ON comments (photo, created);
CREATE INDEX IF NOT EXISTS comments_album ON comments (album);
CREATE INDEX IF NOT EXISTS comments_client ON comments (client, created);
