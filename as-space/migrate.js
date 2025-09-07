// migrate.js
import mysql from 'mysql2/promise';

async function run(){
  const poolText = await mysql.createPool({
    host: process.env.TIDB0_HOST, port: Number(process.env.TIDB0_PORT || 4000), user: process.env.TIDB0_USER, password: process.env.TIDB0_PASS, database: process.env.TIDB0_DB || 'test',
    ssl: process.env.TIDB0_CA_B64 ? { ca: Buffer.from(process.env.TIDB0_CA_B64, 'base64') } : undefined,
    waitForConnections:true, connectionLimit:2
  });

  const poolFiles = await mysql.createPool({
    host: process.env.TIDB1_HOST, port: Number(process.env.TIDB1_PORT || 4000), user: process.env.TIDB1_USER, password: process.env.TIDB1_PASS, database: process.env.TIDB1_DB || 'test',
    ssl: process.env.TIDB1_CA_B64 ? { ca: Buffer.from(process.env.TIDB1_CA_B64, 'base64') } : undefined,
    waitForConnections:true, connectionLimit:2
  });

  await poolText.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      role VARCHAR(20),
      content TEXT,
      parent_id BIGINT NULL,
      attachment_id BIGINT NULL,
      attachment_url TEXT NULL,
      attachment_name VARCHAR(255) NULL,
      attachment_type VARCHAR(100) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  console.log('messages table created/ok');

  await poolFiles.execute(`
    CREATE TABLE IF NOT EXISTS files (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      filename VARCHAR(255),
      mime_type VARCHAR(100),
      file_data LONGBLOB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  console.log('files table created/ok');

  await poolText.end();
  await poolFiles.end();
  console.log('migrate done');
}

run().catch(e=>{ console.error(e); process.exit(1); });
