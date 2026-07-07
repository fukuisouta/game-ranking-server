const net = require('net');

const PORT = process.env.PORT || 10000;
let rankingList = [
    { playerName: "TEST_PLAYER", clearTime: 99.99 }
];

const server = net.createServer((socket) => {
    const clientIP = socket.remoteAddress;
    console.log(`\n[CONNECT] クライアントが接続しました。 IP: ${clientIP}`);

    socket.on('data', (data) => {
        try {
            const text = data.toString();

            // 💡 1. ブラウザ用のHTML返信処理
            if (text.startsWith('GET ') || text.startsWith('HEAD ')) {
                rankingList.sort((a, b) => a.clearTime - b.clearTime);
                let html = `<html><head><meta charset='utf-8'><title>Solo Ranking</title>
                <style>
                    body { font-family: sans-serif; background: #f4f7f6; text-align: center; padding: 50px; }
                    table { margin: 0 auto; border-collapse: collapse; background: #fff; box-shadow: 0 4px 8px rgba(0,0,0,0.1); width: 400px; }
                    th, td { padding: 12px 20px; border-bottom: 1px solid #ddd; }
                    th { background: #34495e; color: #fff; }
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

            // 💡 3. スコア保存
            if (binaryBuffer.length >= 20) {
                let playerName = binaryBuffer.toString('utf8', 0, 16).replace(/\0/g, '').trim();
                let clearTime = binaryBuffer.readFloatLE(16);

                if (playerName.length > 0 && !isNaN(clearTime)) {
                    rankingList.push({ playerName, clearTime });
                    console.log(`[RECORD_RECEIVED] ★保存成功★ -> ${playerName} | ${clearTime.toFixed(2)}秒`);
                }
            }

            // 💡 4. TOP5を整形してゲームへ返信
            rankingList.sort((a, b) => a.clearTime - b.clearTime);
            const top5 = rankingList.slice(0, 5);
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
        }
    });
});

server.listen(PORT, () => {
    console.log(`[SERVER_START] ランキングサーバー稼働中...`);
});
