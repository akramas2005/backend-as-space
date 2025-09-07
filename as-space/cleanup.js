// cleanup.js
import mysql from 'mysql2/promise';

async function run(){
  const poolText = mysql.createPool({
    host: process.env.TIDB0_HOST, port:Number(process.env.TIDB0_PORT||4000), user: process.env.TIDB0_USER, password: process.env.TIDB0_PASS, database: process.env.TIDB0_DB||'test',
    ssl: process.env.TIDB0_CA_B64 ? { ca: Buffer.from(process.env.TIDB0_CA_B64, 'base64') } : undefined
  });
  const poolFiles = mysql.createPool({
    host: process.env.TIDB1_HOST, port:Number(process.env.TIDB1_PORT||4000), user: process.env.TIDB1_USER, password: process.env.TIDB1_PASS, database: process.env.TIDB1_DB||'test',
    ssl: process.env.TIDB1_CA_B64 ? { ca: Buffer.from(process.env.TIDB1_CA_B64, 'base64') } : undefined
  });

  await poolText.execute("DELETE FROM messages WHERE created_at < NOW() - INTERVAL 90 DAY");
  await poolFiles.execute("DELETE FROM files WHERE created_at < NOW() - INTERVAL 30 DAY");

  await poolText.end();
  await poolFiles.end();
  console.log('cleanup complete');
}

run().catch(e=>{ console.error(e); process.exit(1); });
