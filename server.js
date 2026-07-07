const net = require('net');
const { Client } = require('pg');

const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;

// 💡 データベースの初期設定
async function initDatabase() {
    if (!DATABASE_URL) {
        console.log("[DB_WARNING] DATABASE_URLが設定されていません。メモリモードで動作します。");
        return null;
    }
    const client = new Client({
        connectionString: DATABASE_URL,
    });
    await client.connect();
    
    // ランキング用のテーブルがなければ自動作成するSQL
    await client.query(`
        CREATE TABLE IF NOT EXISTS ranking (
            id SERIAL PRIMARY KEY,
            player_name VARCHAR(16) NOT NULL,
            clear_time REAL NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log("[DB_SUCCESS] PostgreSQL データベースに正常に接続し、テーブルを確認しました。");
    return client;
}

const server = net.createServer(async (socket) => {
    let dbClient = null;
    try {
        dbClient = await initDatabase();
    } catch (dbErr) {
        console.error("[DB_ERROR] データベース接続に失敗しました:", dbErr);
    }

    socket.on('data', async (data) => {
        try {
            const text = data.toString();

            // 💡 1. ブラウザ用のHTML返信処理 (DBからデータを取得する)
            if (text.startsWith('GET ') || text.startsWith('HEAD ')) {
                let rankingList = [];
                if (dbClient) {
                    const res = await dbClient.query("SELECT player_name, clear_time FROM ranking ORDER BY clear_time ASC LIMIT 10;");
                    rankingList = res.rows.map(row => ({ playerName: row.player_name, clearTime: row.clear_time }));
                } else {
                    rankingList = [{ playerName: "DB_OFFLINE_TEST", clearTime: 99.99 }];
                }

                let html = `<html><head><meta charset='utf-8'><title>Solo Ranking</title>
                <style>
                    body { font-family: sans-serif; background: #f4f7f6; text-align: center; padding: 50px; }
                    table { margin: 0 auto; border-collapse: collapse; background: #fff; box-shadow: 0 4px 8px rgba(0,0,0,0.1); width: 400px; }
                    th, td { padding: 12px 20px; border-bottom: 1px solid #ddd; }
                    th { background: #2c3e50; color: #fff; }
                    tr:nth-child(even) { background: #f9f9f9; }
                    h1 { color: #2c3e50; }
                </style>
                </head><body><h1>Solo Play Ranking</h1><table><tr><th>Rank</th><th>Player</th><th>Time</th></tr>`;
                
                rankingList.forEach((item, index) => {
                    html += `<tr><td>${index + 1}</td><td>${item.playerName}</td><td>${item.clearTime.toFixed(2)}s</td></tr>`;
                });
                html += `</table></body></html>`;

                const httpResponse = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Length: " + Buffer.byteLength(html) + "\r\n\r\n" + html;
                socket.write(httpResponse);
                socket.end();
                return;
            }

            // 💡 2. ゲームからのHTTP POSTデータを解析
            let binaryBuffer = data;
            if (text.startsWith('POST ')) {
                const headerEndIndex = data.indexOf('\r\n\r\n');
                if (headerEndIndex !== -1) {
                    binaryBuffer = data.slice(headerEndIndex + 4);
                }
            }

            // 💡 3. スコアを永久保存 (DBへインサート)
            if (binaryBuffer.length >= 20) {
                let playerName = binaryBuffer.toString('utf8', 0, 16).replace(/\0/g, '').trim();
                let clearTime = binaryBuffer.readFloatLE(16);

                if (playerName.length > 0 && !isNaN(clearTime)) {
                    if (dbClient) {
                        await dbClient.query(
                            "INSERT INTO ranking (player_name, clear_time) VALUES ($1, $2);",
                            [playerName, clearTime]
                        );
                        console.log(`[DB_SAVE] ★データベースへ永続保存成功★ -> ${playerName} | ${clearTime.toFixed(2)}秒`);
                    } else {
                        console.log(`[MEMORY_SAVE] (DB無効) -> ${playerName} | ${clearTime.toFixed(2)}秒`);
                    }
                }
            }

            // 💡 4. 最新のTOP5を取得してゲームへ返信
            let top5 = [];
            if (dbClient) {
                const res = await dbClient.query("SELECT player_name, clear_time FROM ranking ORDER BY clear_time ASC LIMIT 5;");
                top5 = res.rows.map(row => ({ playerName: row.player_name, clearTime: row.clear_time }));
            }

            const sendBuffer = Buffer.alloc(top5.length * 20);
            top5.forEach((item, index) => {
                const offset = index * 20;
                const nameBuf = Buffer.alloc(16);
                nameBuf.write(item.playerName, 'utf8');
                nameBuf.copy(sendBuffer, offset);
                sendBuffer.writeFloatLE(item.clearTime, offset + 16);
            });

            const httpHeader = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: " + sendBuffer.length + "\r\n\r\n";
            
            socket.write(httpHeader, () => {
                socket.write(sendBuffer, () => {
                    socket.end();
                });
            });

        } catch (err) {
            console.error(`[ERROR]`, err);
            socket.end();
        } finally {
            if (dbClient) {
                await dbClient.end().catch(() => {});
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`[SERVER_START] PostgreSQL対応ランキングサーバー稼働中...`);
});
