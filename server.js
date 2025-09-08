// server.js
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import mysql from 'mysql2/promise';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' })); // 🟢 نحدد حجم الرسالة النصية (5MB كافي)

// --- env / defaults ---
const PORT = process.env.PORT || 3000;

// TiDB Cluster0 (texts)
const T0 = {
  host: process.env.TIDB0_HOST,
  port: Number(process.env.TIDB0_PORT || 4000),
  user: process.env.TIDB0_USER,
  password: process.env.TIDB0_PASS,
  database: process.env.TIDB0_DB || 'test',
  caB64: process.env.TIDB0_CA_B64 || ''
};

// TiDB Cluster1 (files)
const T1 = {
  host: process.env.TIDB1_HOST,
  port: Number(process.env.TIDB1_PORT || 4000),
  user: process.env.TIDB1_USER,
  password: process.env.TIDB1_PASS,
  database: process.env.TIDB1_DB || 'test',
  caB64: process.env.TIDB1_CA_B64 || ''
};

// helper to write CA file from base64 env var
function writeCa(envB64, outPath){
  if(!envB64) return null;
  try {
    const buf = Buffer.from(envB64, 'base64');
    fs.writeFileSync(outPath, buf);
    return outPath;
  } catch(e){
    console.error('writeCa error', e);
    return null;
  }
}

const ca0path = writeCa(T0.caB64, '/tmp/ca0.pem');
const ca1path = writeCa(T1.caB64, '/tmp/ca1.pem');

const poolText = mysql.createPool({
  host: T0.host, port: T0.port, user: T0.user, password: T0.password, database: T0.database,
  waitForConnections: true, connectionLimit: 10,
  ssl: ca0path ? { ca: fs.readFileSync(ca0path) } : undefined
});

const poolFiles = mysql.createPool({
  host: T1.host, port: T1.port, user: T1.user, password: T1.password, database: T1.database,
  waitForConnections: true, connectionLimit: 10,
  ssl: ca1path ? { ca: fs.readFileSync(ca1path) } : undefined
});

// multer memory storage
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB cap

// POST /api/files  -> upload file to Cluster1, return file id & url
app.post('/api/files', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const { originalname, mimetype, buffer } = req.file;

    // خزّن الملف في Cluster1
    const sql = 'INSERT INTO files (filename, mime_type, file_data) VALUES (?, ?, ?)';
    const [result] = await poolFiles.execute(sql, [originalname, mimetype, buffer]);
    const fileId = result.insertId;
    const fileUrl = `https://backend-as-space-1.onrender.com/api/files/${fileId}`;

    // 🟢 أضف أيضاً إدخال في جدول messages (Cluster0)
    const msgSql = `INSERT INTO messages (role, content, attachment_id, attachment_url, attachment_name, attachment_type)
                    VALUES (?, ?, ?, ?, ?, ?)`;
    await poolText.execute(msgSql, [
      'user', '', fileId, fileUrl, originalname, mimetype
    ]);

    // رجّع البيانات كاملة
    return res.json({
      id: fileId,
      url: fileUrl,
      filename: originalname,
      mime_type: mimetype
    });
  } catch (err) {
  console.error('POST /api/files error:', err.message, err.stack);
  return res.status(500).json({ error: 'upload failed', details: err.message });
}
});

// GET /api/files/:id -> stream file content from DB
app.get('/api/files/:id', async (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    const [rows] = await poolFiles.execute('SELECT filename, mime_type, file_data FROM files WHERE id = ?', [id]);
    if (!rows || rows.length === 0) return res.status(404).send('Not found');
    const row = rows[0];
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${row.filename}"`);
    res.send(row.file_data);
  } catch (err) {
    console.error('GET /api/files/:id error', err);
    res.status(500).send('error');
  }
});

// POST /api/messages -> save message in Cluster0
app.post('/api/messages', async (req, res) => {
  try {
    const { role, content, parent_id = null, attachmentId = null, attachmentUrl = null, attachmentName = null, attachmentType = null } = req.body;

    // 🟢 نتأكد أننا ما نخزن ملف ضخم هنا، فقط البيانات النصية + الرابط
    if (content && content.length > 10000) {
      return res.status(413).json({ error: 'message too large' });
    }

    const sql = `INSERT INTO messages (role, content, parent_id, attachment_id, attachment_url, attachment_name, attachment_type) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    const [result] = await poolText.execute(sql, [role, content, parent_id, attachmentId, attachmentUrl, attachmentName, attachmentType]);
    return res.json({ id: result.insertId });
  } catch (err) {
    console.error('POST /api/messages error', err);
    return res.status(500).json({ error: 'save failed' });
  }
});

// GET /api/messages?limit=200  -> return last N messages (ordered asc)
app.get('/api/messages', async (req, res) => {
  try {
    const limit = Math.min(1000, Number(req.query.limit || 200));
    const [rows] = await poolText.execute('SELECT id, role, content, parent_id, attachment_id, attachment_url, attachment_name, attachment_type, created_at FROM messages ORDER BY created_at ASC LIMIT ?', [limit]);
    return res.json(rows);
  } catch (err) {
    console.error('GET /api/messages error', err);
    return res.status(500).json({ error: 'fetch failed' });
  }
});

// POST /api/cleanup -> deletes expired (can be secured later)
app.post('/api/cleanup', async (req, res) => {
  try {
    await poolText.execute("DELETE FROM messages WHERE created_at < NOW() - INTERVAL 90 DAY");
    await poolFiles.execute("DELETE FROM files WHERE created_at < NOW() - INTERVAL 30 DAY");
    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/cleanup error', err);
    return res.status(500).json({ error: 'cleanup failed' });
  }
});

// health
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log('Server listening on port', PORT);
});






