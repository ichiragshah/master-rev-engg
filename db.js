const { Pool } = require('pg');

const log = (level, msg, data = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level, ctx: 'DB', msg, ...data }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100),
      username VARCHAR(100) NOT NULL,
      password_enc TEXT NOT NULL,
      telegram_chat_id BIGINT,
      telegram_username VARCHAR(100),
      threshold INTEGER DEFAULT 0,
      alert_type VARCHAR(30) DEFAULT 'exposure_only',
      active BOOLEAN DEFAULT true,
      token TEXT,
      token_expiry BIGINT,
      user_id VARCHAR(100),
      sports VARCHAR(200) DEFAULT 'All',
      book_view VARCHAR(20) DEFAULT 'Total Book',
      platform VARCHAR(20) DEFAULT 'winner7',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS sports VARCHAR(200) DEFAULT 'All'`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS book_view VARCHAR(20) DEFAULT 'Total Book'`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS platform VARCHAR(20) DEFAULT 'winner7'`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS currency_type VARCHAR(10) DEFAULT 'INR'`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS upline VARCHAR(50)`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(100)`);
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS poll_interval INTEGER DEFAULT 30`);

  // Migrate unique constraint: drop old username-only, add (username, platform)
  await pool.query(`
    DO $$
    BEGIN
      -- Drop old unique constraint on username only (if exists)
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'clients_username_key' AND conrelid = 'clients'::regclass
      ) THEN
        ALTER TABLE clients DROP CONSTRAINT clients_username_key;
      END IF;
      -- Create new unique constraint on (username, platform) if not exists
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'clients_username_platform_key' AND conrelid = 'clients'::regclass
      ) THEN
        ALTER TABLE clients ADD CONSTRAINT clients_username_platform_key UNIQUE (username, platform);
      END IF;
    END $$;
  `);

  // --- alert_recipients table ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alert_recipients (
      id SERIAL PRIMARY KEY,
      client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      telegram_username VARCHAR(100) NOT NULL,
      telegram_chat_id BIGINT,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(client_id, telegram_username)
    )
  `);

  // Migrate existing telegram data from clients into alert_recipients
  await pool.query(`
    INSERT INTO alert_recipients (client_id, telegram_username, telegram_chat_id)
    SELECT id, LOWER(telegram_username), telegram_chat_id
    FROM clients
    WHERE telegram_username IS NOT NULL
      AND telegram_username != ''
    ON CONFLICT (client_id, telegram_username) DO NOTHING
  `);

  // --- polling_state table (survives deploys) ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS polling_state (
      chat_id BIGINT PRIMARY KEY,
      started_at TIMESTAMP DEFAULT NOW()
    )
  `);

  log('INFO', 'clients + alert_recipients + polling_state tables ready');
}

async function getAllActiveClients() {
  const { rows } = await pool.query(`
    SELECT * FROM clients
    WHERE active = true
      AND EXISTS (
        SELECT 1 FROM alert_recipients ar
        WHERE ar.client_id = clients.id AND ar.telegram_chat_id IS NOT NULL
      )
  `);
  return rows;
}

async function registerClient(data) {
  const { name, username, password_enc, telegram_username, threshold, alert_type, sports, book_view, platform, currency_type, upline } = data;
  const { rows } = await pool.query(
    `INSERT INTO clients (name, username, password_enc, telegram_username, threshold, alert_type, sports, book_view, platform, currency_type, upline)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (username, platform) DO UPDATE SET
       name = EXCLUDED.name,
       password_enc = EXCLUDED.password_enc,
       telegram_username = EXCLUDED.telegram_username,
       threshold = EXCLUDED.threshold,
       alert_type = EXCLUDED.alert_type,
       sports = EXCLUDED.sports,
       book_view = EXCLUDED.book_view,
       currency_type = EXCLUDED.currency_type,
       upline = EXCLUDED.upline
     RETURNING id, username, platform`,
    [name, username, password_enc, telegram_username, threshold ?? 0, alert_type || 'exposure_only', sports || 'All', book_view || 'Total Book', platform || 'winner7', currency_type || 'INR', upline || null]
  );
  log('INFO', 'Client registered/updated', { username, platform: platform || 'winner7' });
  return rows[0];
}

async function addRecipients(clientId, usernames) {
  if (!usernames || usernames.length === 0) return;
  const values = usernames.map((u, i) => `($1, $${i + 2})`).join(', ');
  const params = [clientId, ...usernames.map(u => u.toLowerCase())];
  await pool.query(
    `INSERT INTO alert_recipients (client_id, telegram_username)
     VALUES ${values}
     ON CONFLICT (client_id, telegram_username) DO NOTHING`,
    params
  );
}

async function getRecipientChatIds(clientId) {
  const { rows } = await pool.query(
    'SELECT telegram_chat_id FROM alert_recipients WHERE client_id = $1 AND telegram_chat_id IS NOT NULL',
    [clientId]
  );
  return rows.map(r => r.telegram_chat_id);
}

async function getRecipientsByClientId(clientId) {
  const { rows } = await pool.query(
    'SELECT telegram_username, telegram_chat_id FROM alert_recipients WHERE client_id = $1 ORDER BY created_at',
    [clientId]
  );
  return rows;
}

async function linkRecipientChatId(telegramUsername, chatId) {
  const { rowCount } = await pool.query(
    'UPDATE alert_recipients SET telegram_chat_id = $1 WHERE LOWER(telegram_username) = LOWER($2)',
    [chatId, telegramUsername]
  );
  log('INFO', 'Link recipient', { telegramUsername, chatId, linked: rowCount > 0 });
  return rowCount > 0;
}

async function updateClientToken(username, platform, token, expiry, userId) {
  await pool.query(
    'UPDATE clients SET token = $1, token_expiry = $2, user_id = $3 WHERE username = $4 AND platform = $5',
    [token, expiry, userId, username, platform]
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
  const allowed = ['threshold', 'active'];
  if (!allowed.includes(field)) throw new Error('Invalid field');
  await pool.query(
    `UPDATE clients SET ${field} = $1 WHERE telegram_chat_id = $2`,
    [value, chat_id]
  );
}

async function updateClientPollInterval(clientId, seconds) {
  await pool.query('UPDATE clients SET poll_interval = $1 WHERE id = $2', [seconds, clientId]);
}

async function setClientActive(chat_id, active) {
  await pool.query(
    'UPDATE clients SET active = $1 WHERE telegram_chat_id = $2',
    [active, chat_id]
  );
}

async function getClientByChatId(chat_id) {
  const { rows } = await pool.query(
    `SELECT c.* FROM clients c
     WHERE c.telegram_chat_id = $1
        OR EXISTS (
          SELECT 1 FROM alert_recipients ar
          WHERE ar.client_id = c.id AND ar.telegram_chat_id = $1
        )`,
    [chat_id]
  );
  return rows[0] || null;
}

async function getClientsByChatId(chatId) {
  const { rows } = await pool.query(
    `SELECT c.* FROM clients c
     JOIN alert_recipients ar ON ar.client_id = c.id
     WHERE ar.telegram_chat_id = $1 AND c.active = true AND c.alert_type != 'test'`,
    [chatId]
  );
  return rows;
}

async function getAllClients() {
  const { rows } = await pool.query(
    'SELECT id, name, username, telegram_chat_id, telegram_username, threshold, alert_type, sports, book_view, platform, currency_type, upline, active, user_id, created_at FROM clients'
  );
  return rows;
}

async function getActiveClientsForChatIds(chatIds) {
  if (!chatIds || chatIds.length === 0) return [];
  const { rows } = await pool.query(`
    SELECT DISTINCT c.* FROM clients c
    JOIN alert_recipients ar ON ar.client_id = c.id
    WHERE c.active = true
      AND c.alert_type != 'test'
      AND ar.telegram_chat_id = ANY($1::bigint[])
  `, [chatIds]);
  return rows;
}

async function getLinkedClientCount(chatId) {
  const { rows } = await pool.query(`
    SELECT COUNT(DISTINCT c.id) AS cnt FROM clients c
    JOIN alert_recipients ar ON ar.client_id = c.id
    WHERE c.active = true AND ar.telegram_chat_id = $1
  `, [chatId]);
  return parseInt(rows[0].cnt, 10);
}

module.exports = {
  pool,
  initDB,
  getAllActiveClients,
  getActiveClientsForChatIds,
  getLinkedClientCount,
  registerClient,
  addRecipients,
  getRecipientChatIds,
  getRecipientsByClientId,
  linkRecipientChatId,
  updateClientToken,
  updateClientChatId,
  updateClientConfig,
  updateClientPollInterval,
  setClientActive,
  getClientByChatId,
  getClientsByChatId,
  getAllClients,
};
