-- Triangle WMS Pro - Simple Jitsi meetings
-- Safe additive migration.

CREATE TABLE IF NOT EXISTS meetings (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) DEFAULT '',
  room_name VARCHAR(255) NOT NULL,
  meeting_url TEXT NOT NULL,
  conversation_id INTEGER,
  created_by INTEGER,
  company_id INTEGER,
  status VARCHAR(80) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS meeting_participants (
  id SERIAL PRIMARY KEY,
  meeting_id INTEGER REFERENCES meetings(id) ON DELETE CASCADE,
  user_id INTEGER,
  joined_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (meeting_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_meetings_company_id ON meetings(company_id);
CREATE INDEX IF NOT EXISTS idx_meetings_conversation_id ON meetings(conversation_id);
CREATE INDEX IF NOT EXISTS idx_meeting_participants_user_id ON meeting_participants(user_id);
