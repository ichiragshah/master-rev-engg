const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100),
      username VARCHAR(100) UNIQUE NOT NULL,
      password_enc TEXT NOT NULL,
      telegram_chat_id BIGINT,
      telegram_username VARCHAR(100),
      threshold INTEGER DEFAULT 50000,
      alert_type VARCHAR(30) DEFAULT 'exposure_only',
      active BOOLEAN DEFAULT true,
      token TEXT,
      token_expiry BIGINT,
      user_id VARCHAR(100),
      sports VARCHAR(200) DEFAULT 'All',
      book_view VARCHAR(20) DEFAULT 'Total Book',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS sports VARCHAR(200) DEFAULT 'All'`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS book_view VARCHAR(20) DEFAULT 'Total Book'`);
  console.log('[DB] clients table ready');
}

async function getAllActiveClients() {
  const { rows } = await pool.query(
    'SELECT * FROM clients WHERE active = true AND telegram_chat_id IS NOT NULL'
  );
  return rows;
}

async function registerClient(data) {
  const { name, username, password_enc, telegram_username, threshold, alert_type, sports, book_view } = data;
  const { rows } = await pool.query(
    `INSERT INTO clients (name, username, password_enc, telegram_username, threshold, alert_type, sports, book_view)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (username) DO UPDATE SET
       name = EXCLUDED.name,
       password_enc = EXCLUDED.password_enc,
       telegram_username = EXCLUDED.telegram_username,
       threshold = EXCLUDED.threshold,
       alert_type = EXCLUDED.alert_type,
       sports = EXCLUDED.sports,
       book_view = EXCLUDED.book_view
     RETURNING id, username`,
    [name, username, password_enc, telegram_username, threshold || 50000, alert_type || 'exposure_only', sports || 'All', book_view || 'Total Book']
  );
  return rows[0];
}

async function updateClientToken(username, token, expiry, userId) {
  await pool.query(
    'UPDATE clients SET token = $1, token_expiry = $2, user_id = $3 WHERE username = $4',
    [token, expiry, userId, username]
  );
}

async function updateClientChatId(telegram_username, chat_id) {
  const { rowCount } = await pool.query(
    'UPDATE clients SET telegram_chat_id = $1 WHERE LOWER(telegram_username) = LOWER($2)',
    [chat_id, telegram_username]
  );
  return rowCount > 0;
}

async function updateClientConfig(chat_id, field, value) {
  const allowed = ['threshold', 'alert_type', 'sports', 'book_view', 'active'];
  if (!allowed.includes(field)) throw new Error('Invalid field');
  await pool.query(
    `UPDATE clients SET ${field} = $1 WHERE telegram_chat_id = $2`,
    [value, chat_id]
  );
}

async function setClientActive(chat_id, active) {
  await pool.query(
    'UPDATE clients SET active = $1 WHERE telegram_chat_id = $2',
    [active, chat_id]
  );
}

async function getClientByChatId(chat_id) {
  const { rows } = await pool.query(
    'SELECT * FROM clients WHERE telegram_chat_id = $1',
    [chat_id]
  );
  return rows[0] || null;
}

async function getAllClients() {
  const { rows } = await pool.query(
    'SELECT id, name, username, telegram_chat_id, telegram_username, threshold, alert_type, sports, book_view, active, user_id, created_at FROM clients'
  );
  return rows;
}

module.exports = {
  pool,
  initDB,
  getAllActiveClients,
  registerClient,
  updateClientToken,
  updateClientChatId,
  updateClientConfig,
  setClientActive,
  getClientByChatId,
  getAllClients,
};
