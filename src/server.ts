import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { Server } from 'socket.io';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4321;
// In the compiled dist folder, this script will be at dist/server.js
// so the public folder will be at dist/public
const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
    // CORS headers just in case
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, POST, GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method === 'POST' && req.url === '/ingest') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                io.emit('rpc-message', data);
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('OK');
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Invalid JSON');
            }
        });
        return;
    }

    // Serve static files
    if (req.method === 'GET') {
        let filePath = req.url === '/' ? '/index.html' : req.url || '';
        filePath = filePath.split('?')[0]; // Strip query parameters
        
        // Prevent directory traversal
        const absolutePath = path.normalize(path.join(PUBLIC_DIR, filePath));
        if (!absolutePath.startsWith(PUBLIC_DIR)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        fs.stat(absolutePath, (err, stats) => {
            if (err || !stats.isFile()) {
                res.writeHead(404);
                res.end('Not Found');
                return;
            }

            const ext = path.extname(absolutePath);
            const mimeTypes: Record<string, string> = {
                '.html': 'text/html',
                '.js': 'application/javascript',
                '.css': 'text/css',
                '.json': 'application/json',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.svg': 'image/svg+xml'
            };

            res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
            fs.createReadStream(absolutePath).pipe(res);
        });
        return;
    }

    res.writeHead(405);
    res.end('Method Not Allowed');
});

const io = new Server(server, { cors: { origin: '*' } });

server.listen(PORT, () => {
    console.log(`\x1b[36m[Analyzer Server]\x1b[0m Running at http://localhost:${PORT}`);
    console.log(`\x1b[36m[Analyzer Server]\x1b[0m Waiting for intercepted communications...`);
});