const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '10mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// テーブル作成
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ranking (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        clear_time REAL NOT NULL,
        play_log TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("Database initialized");
  } catch (err) {
    console.error("DB Init Error:", err);
  }
}
initDB();

// ── 【スコア保存 API (POST)】 ──
app.post('/api/score', async (req, res) => {
  const { name, time, clear_time, log, play_log } = req.body;
  
  const scoreTime = time !== undefined ? time : clear_time;
  const rawLog = log !== undefined ? log : play_log;

  if (!name || scoreTime === undefined) {
    return res.status(400).json({ error: "Invalid data" });
  }

  try {
    // ログデータ（Base64文字列）を変換せずそのままDBへ保存（絶対エラーが出ない！）
    await pool.query(
      'INSERT INTO ranking (name, clear_time, play_log) VALUES ($1, $2, $3)',
      [String(name), parseFloat(scoreTime), String(rawLog || '')]
    );
    res.json({ success: true, message: "OK: Score Saved" });
  } catch (err) {
    console.error("Save Error Detail:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ── 【ログダウンロード API (GET)】 ──
app.get('/api/log/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT name, play_log FROM ranking WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0 || !result.rows[0].play_log) {
      return res.status(404).send('Log not found');
    }

    const item = result.rows[0];
    const filename = `log_${item.name}_${req.params.id}.txt`;

    // DBにはBase64（あるいは生のログ）が入っているのでそのままテキストファイルとしてダウンロードさせる
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(item.play_log);
  } catch (err) {
    console.error("Download Error:", err);
    res.status(500).send('Server Error');
  }
});

// ランキングリセット API
app.post('/api/reset', async (req, res) => {
  try {
    await pool.query('DELETE FROM ranking');
    res.redirect('/');
  } catch (err) {
    res.status(500).send("Database Error");
  }
});

// ランキング表示 Webページ (GET /)
app.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ranking ORDER BY clear_time ASC LIMIT 10');
    
    let rowsHtml = '';
    result.rows.forEach((row, index) => {
      const logText = row.play_log || '';
      const logSize = Buffer.byteLength(logText, 'utf-8');
      
      const logHtml = logSize > 0 
        ? `<a href="/api/log/${row.id}" class="download-btn">Download (${logSize} B)</a>`
        : '<span class="no-log">None</span>';

      rowsHtml += `
        <tr>
          <td>${index + 1}</td>
          <td><strong>${escapeHtml(row.name)}</strong></td>
          <td>${Number(row.clear_time).toFixed(3)} s</td>
          <td>${logHtml}</td>
        </tr>
      `;
    });

    const html = `
      <!DOCTYPE html>
      <html lang="ja">
      <head>
        <meta charset="UTF-8">
        <title>Solo Play Ranking</title>
        <style>
          body { font-family: sans-serif; background: #f4f6f8; padding: 40px; display: flex; flex-direction: column; align-items: center; }
          h1 { color: #333; }
          table { border-collapse: collapse; width: 600px; background: #fff; box-shadow: 0 4px 6px rgba(0,0,0,0.1); border-radius: 8px; overflow: hidden; }
          th, td { padding: 12px 16px; text-align: left; }
          th { background: #34495e; color: #fff; }
          tr:nth-child(even) { background: #f8f9fa; }
          .no-log { color: #95a5a6; font-size: 0.9em; }
          
          .download-btn {
            color: #27ae60;
            font-weight: bold;
            text-decoration: none;
            background: #e8f8f0;
            padding: 4px 8px;
            border-radius: 4px;
            border: 1px solid #27ae60;
            font-size: 0.85em;
            transition: 0.2s;
            display: inline-block;
          }
          .download-btn:hover {
            background: #27ae60;
            color: #fff;
          }

          .reset-sec { margin-top: 30px; text-align: center; }
          .reset-btn { background: #e74c3c; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-weight: bold; }
          .reset-btn:hover { background: #c0392b; }
        </style>
      </head>
      <body>
        <h1>Solo Play Ranking</h1>
        <table>
          <thead>
            <tr>
              <th>Rank</th>
              <th>Player</th>
              <th>Time</th>
              <th>Log</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>

        <div class="reset-sec">
          <form action="/api/reset" method="POST" onsubmit="return confirm('本当にランキングをリセットしますか？');">
            <button type="submit" class="reset-btn">Reset Ranking</button>
          </form>
        </div>
      </body>
      </html>
    `;
    res.send(html);
  } catch (err) {
    console.error("Fetch Error:", err);
    res.status(500).send("Database Error");
  }
});

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, function(m) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
