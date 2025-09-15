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

// ----------------- DELETE routes -----------------

// DELETE file by id
app.delete('/api/files/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing id' });

    const [result] = await poolFiles.execute('DELETE FROM files WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'file not found' });
    }

    return res.json({ ok: true, deleted: id });
  } catch (err) {
    console.error('DELETE /api/files error', err);
    res.status(500).json({ error: 'delete failed' });
  }
});

// DELETE message by id
app.delete('/api/messages/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing id' });

    const [result] = await poolText.execute('DELETE FROM messages WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'message not found' });
    }

    return res.json({ ok: true, deleted: id });
  } catch (err) {
    console.error('DELETE /api/messages error', err);
    res.status(500).json({ error: 'delete failed' });
  }
});

// DELETE messages from a message timestamp onward
app.delete('/api/messages/after/:id', async (req, res) => {
  try {
    const id = Number(req.params.id || 0);
    if (!id) return res.status(400).json({ error: 'missing id' });

    const [rows] = await poolText.execute('SELECT created_at, conversation_id FROM messages WHERE id = ?', [id]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'message not found' });

    const { created_at, conversation_id } = rows[0];
    if (!conversation_id) {
      await poolText.execute('DELETE FROM messages WHERE created_at >= ?', [created_at]);
      await poolFiles.execute('DELETE FROM files WHERE created_at >= ?', [created_at]);
    } else {
      await poolText.execute('DELETE FROM messages WHERE conversation_id = ? AND created_at >= ?', [conversation_id, created_at]);
      await poolFiles.execute('DELETE FROM files WHERE conversation_id = ? AND created_at >= ?', [conversation_id, created_at]);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/messages/after error', err);
    return res.status(500).json({ error: 'delete failed' });
  }
});

// DELETE entire conversation
app.delete('/api/conversations/:id', async (req, res) => {
  try {
    const convId = req.params.id;
    if (!convId) return res.status(400).json({ error: 'missing id' });

    const [msgsResult] = await poolText.execute('DELETE FROM messages WHERE conversation_id = ?', [convId]);
    const [filesResult] = await poolFiles.execute('DELETE FROM files WHERE conversation_id = ?', [convId]);

    return res.json({ ok: true, messages_deleted: msgsResult.affectedRows, files_deleted: filesResult.affectedRows });
  } catch (err) {
    console.error('DELETE /api/conversations error', err);
    return res.status(500).json({ error: 'delete failed' });
  }
});

// DELETE all (admin)
app.delete('/api/conversations/all', async (req, res) => {
  try {
    await poolText.execute('DELETE FROM messages');
    await poolFiles.execute('DELETE FROM files');
    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/conversations/all error', err);
    res.status(500).json({ error: 'delete all failed' });
  }
});

// ----------------- Upload & Messages -----------------

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB cap

// POST /api/files
app.post('/api/files', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const { originalname, mimetype, buffer } = req.file;
    const conversation_id = (req.body && req.body.conversation_id) ? String(req.body.conversation_id) : null;

    const sql = 'INSERT INTO files (filename, mime_type, file_data, conversation_id) VALUES (?, ?, ?, ?)';
    const [result] = await poolFiles.execute(sql, [originalname, mimetype, buffer, conversation_id]);
    const fileId = result.insertId;
    const fileUrl = `https://backend-as-space-1.onrender.com/api/files/${fileId}`;

    const msgSql = `INSERT INTO messages (role, content, attachment_id, attachment_url, attachment_name, attachment_type, conversation_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`;
    await poolText.execute(msgSql, [
      'user', '', fileId, fileUrl, originalname, mimetype, conversation_id
    ]);

    return res.json({
      id: fileId,
      url: fileUrl,
      filename: originalname,
      mime_type: mimetype,
      conversation_id
    });
  } catch (err) {
    console.error('POST /api/files error:', err.message, err.stack);
    return res.status(500).json({ error: 'upload failed', details: err.message });
  }
});

// GET /api/files/:id
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

// POST /api/messages
app.post('/api/messages', async (req, res) => {
  try {
    const {
      role,
      content,
      parent_id = null,
      attachmentId = null,
      attachmentUrl = null,
      attachmentName = null,
      attachmentType = null,
      conversation_id = null
    } = req.body;

    if (content && content.length > 10000) {
      return res.status(413).json({ error: 'message too large' });
    }

    const sql = `INSERT INTO messages
      (role, content, parent_id, attachment_id, attachment_url, attachment_name, attachment_type, conversation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    const [result] = await poolText.execute(sql, [role, content, parent_id, attachmentId, attachmentUrl, attachmentName, attachmentType, conversation_id]);
    return res.json({ id: result.insertId, conversation_id });
  } catch (err) {
    console.error('POST /api/messages error', err);
    return res.status(500).json({ error: 'save failed' });
  }
});

// GET /api/messages
app.get('/api/messages', async (req, res) => {
  try {
    const limit = Math.min(1000, Number(req.query.limit || 200));
    const convoId = req.query.conversation_id || null;

    let rows;
    if (convoId) {
      [rows] = await poolText.execute(
        `SELECT id, role, content, parent_id, attachment_id, attachment_url, attachment_name, attachment_type, created_at, conversation_id
         FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at ASC LIMIT ?`,
        [convoId, limit]
      );
    } else {
      [rows] = await poolText.execute(
        `SELECT id, role, content, parent_id, attachment_id, attachment_url, attachment_name, attachment_type, created_at, conversation_id
         FROM messages
         ORDER BY created_at ASC LIMIT ?`,
        [limit]
      );
    }

    return res.json(rows);
  } catch (err) {
    console.error('GET /api/messages error', err);
    return res.status(500).json({ error: 'fetch failed' });
  }
});

// ----------------- Cleanup -----------------
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
