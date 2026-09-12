const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const torrentStream = require('torrent-stream');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const activeTorrents = new Map();

// Optimized high-speed YTS & global tracker list
const YTS_TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://explodie.org:6969/announce',
    'udp://tracker.moeking.me:6969/announce',
    'udp://opentracker.i2p.rocks:6969/announce',
    'udp://tracker.dler.org:6969/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://tracker.openbittorrent.com:80/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.bitsearch.to:1337/announce',
    'udp://movies.zsw.ca:6969/announce',
    'udp://p4p.arenabg.com:1337/announce',
    'udp://retracker.lanta-net.ru:2710/announce',
    'udp://open.demonii.com:1337/announce',
    'http://tracker.openbittorrent.com:80/announce'
];

function appendTrackersToMagnet(magnetUrl) {
    if (!magnetUrl.startsWith('magnet:?')) return magnetUrl;
    let enriched = magnetUrl;
    for (const tr of YTS_TRACKERS) {
        if (!enriched.includes(encodeURIComponent(tr)) && !enriched.includes(tr)) {
            enriched += `&tr=${encodeURIComponent(tr)}`;
        }
    }
    return enriched;
}

// Helper to resolve YTS links to torrent/magnet
async function resolveTorrentSource(inputUrl) {
    let trimmed = inputUrl.trim();

    if (trimmed.startsWith('magnet:?')) {
        return appendTrackersToMagnet(trimmed);
    }

    try {
        if (trimmed.includes('yts.mx') || trimmed.includes('yts.lt') || trimmed.includes('yts.am') || trimmed.includes('yts.gg') || trimmed.includes('yify')) {
            if (trimmed.endsWith('.torrent') || trimmed.includes('/torrent/download/')) {
                const response = await axios.get(trimmed, { responseType: 'arraybuffer' });
                return Buffer.from(response.data);
            }

            if (trimmed.includes('/movies/') || trimmed.includes('/movie/')) {
                const pageRes = await axios.get(trimmed);
                const html = pageRes.data;
                const magnetMatches = html.match(/href="(magnet:\?[^"]+)"/g);
                if (magnetMatches && magnetMatches.length > 0) {
                    const rawMagnet = magnetMatches[0].replace('href="', '').replace('"', '');
                    return appendTrackersToMagnet(rawMagnet);
                }
                const torrentMatches = html.match(/href="(https:\/\/[^"]+\.torrent)"/g);
                if (torrentMatches && torrentMatches.length > 0) {
                    const torrentUrl = torrentMatches[0].replace('href="', '').replace('"', '');
                    const response = await axios.get(torrentUrl, { responseType: 'arraybuffer' });
                    return Buffer.from(response.data);
                }
            }
        }

        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
            const response = await axios.get(trimmed, { responseType: 'arraybuffer' });
            return Buffer.from(response.data);
        }
    } catch (err) {
        console.error('Error resolving source:', err.message);
    }

    return trimmed;
}

app.post('/api/convert', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'Torrent link or magnet URL is required' });
    }

    try {
        const torrentSource = await resolveTorrentSource(url);

        const engine = torrentStream(torrentSource, {
            path: path.join(__dirname, 'downloads'),
            trackers: YTS_TRACKERS,
            connections: 400,
            uploads: 20,
            verify: false,
            dht: true
        });

        // Start listening to accept incoming peer connections and register port with trackers/DHT
        engine.listen(0, (err) => {
            if (!err) console.log(`Torrent swarm listening on port ${engine.port}`);
        });

        let isResolved = false;

        engine.on('ready', () => {
            const infoHash = (engine.infoHash || crypto.createHash('md5').update(url).digest('hex')).toLowerCase();

            if (activeTorrents.has(infoHash)) {
                const existing = activeTorrents.get(infoHash);
                if (!isResolved) {
                    isResolved = true;
                    return res.json({
                        success: true,
                        infoHash: existing.infoHash,
                        name: existing.name,
                        totalSize: existing.totalSize,
                        files: existing.filesMeta
                    });
                }
                return;
            }

            let totalSize = 0;
            const filesMeta = engine.files.map((file, index) => {
                totalSize += file.length;
                return {
                    index,
                    name: file.name,
                    length: file.length,
                    path: file.path,
                    downloadLink: `/api/download/${infoHash}/${index}`,
                    streamLink: `/api/stream/${infoHash}/${index}`
                };
            });

            // Select largest video file
            const largestFileIndex = filesMeta.reduce((maxIdx, f, idx, arr) => f.length > arr[maxIdx].length ? idx : maxIdx, 0);
            engine.files.forEach((f, idx) => {
                if (idx === largestFileIndex) {
                    f.select();
                } else {
                    f.deselect();
                }
            });

            const torrentData = {
                infoHash,
                name: engine.torrent ? engine.torrent.name : 'YTS Movie Download',
                totalSize,
                engine,
                filesMeta
            };

            activeTorrents.set(infoHash, torrentData);

            if (!isResolved) {
                isResolved = true;
                return res.json({
                    success: true,
                    infoHash,
                    name: torrentData.name,
                    totalSize,
                    files: filesMeta
                });
            }
        });

        engine.on('error', (err) => {
            console.error('Engine error:', err);
            if (!isResolved) {
                isResolved = true;
                return res.status(500).json({ error: 'Failed to parse or connect to torrent' });
            }
        });

        setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                return res.status(504).json({ error: 'Metadata fetching timed out. Searching for peers...' });
            }
        }, 15000);

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Failed to process torrent link.' });
    }
});

app.get('/api/status/:infoHash', (req, res) => {
    const infoHash = req.params.infoHash.toLowerCase();
    const t = activeTorrents.get(infoHash);
    if (!t) return res.status(404).json({ error: 'Torrent not found' });

    const swarm = t.engine.swarm;
    res.json({
        infoHash: t.infoHash,
        name: t.name,
        progress: t.totalSize && swarm ? (swarm.downloaded / t.totalSize) : 0,
        downloadSpeed: swarm ? swarm.downloadSpeed() : 0,
        peers: swarm ? swarm.wires.length : 0,
        downloaded: swarm ? swarm.downloaded : 0,
        totalSize: t.totalSize
    });
});

app.get('/api/stream/:infoHash/:fileIndex', (req, res) => {
    const infoHash = req.params.infoHash.toLowerCase();
    const t = activeTorrents.get(infoHash);
    if (!t) return res.status(404).send('Torrent session expired or not found');

    const fileIndex = parseInt(req.params.fileIndex, 10);
    const file = t.engine.files[fileIndex];
    if (!file) return res.status(404).send('File not found');

    t.engine.files.forEach((f, idx) => {
        if (idx === fileIndex) f.select();
        else f.deselect();
    });

    const range = req.headers.range;
    if (!range) {
        res.setHeader('Content-Type', getContentType(file.name));
        res.setHeader('Content-Length', file.length);
        res.setHeader('Accept-Ranges', 'bytes');
        const stream = file.createReadStream();
        stream.on('error', (err) => console.error('Stream error:', err.message));
        return stream.pipe(res);
    }

    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : file.length - 1;
    const chunksize = (end - start) + 1;

    res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${file.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': getContentType(file.name),
    });

    const stream = file.createReadStream({ start, end });
    stream.on('error', (err) => console.error('Stream range error:', err.message));
    stream.pipe(res);
});

app.get('/api/download/:infoHash/:fileIndex', (req, res) => {
    const infoHash = req.params.infoHash.toLowerCase();
    const t = activeTorrents.get(infoHash);
    if (!t) return res.status(404).send('Torrent session expired or not found');

    const fileIndex = parseInt(req.params.fileIndex, 10);
    const file = t.engine.files[fileIndex];
    if (!file) return res.status(404).send('File not found');

    t.engine.files.forEach((f, idx) => {
        if (idx === fileIndex) f.select();
        else f.deselect();
    });

    res.setHeader('Content-Length', file.length);
    res.setHeader('Content-Type', getContentType(file.name));
    res.setHeader('Content-Disposition', `attachment; filename="${file.name.replace(/["']/g, '')}"`);

    const stream = file.createReadStream();
    stream.on('error', (err) => {
        console.error('Download stream error:', err.message);
    });

    req.on('close', () => {
        stream.destroy();
    });

    stream.pipe(res);
});

function getContentType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const types = {
        '.mp4': 'video/mp4',
        '.mkv': 'video/x-matroska',
        '.webm': 'video/webm',
        '.avi': 'video/x-msvideo',
        '.mp3': 'audio/mpeg',
        '.srt': 'text/plain',
        '.vtt': 'text/vtt',
        '.jpg': 'image/jpeg',
        '.png': 'image/png'
    };
    return types[ext] || 'application/octet-stream';
}

function getFolderSizeBytes(folderPath) {
    let total = 0;
    if (!fs.existsSync(folderPath)) return 0;
    try {
        const stats = fs.statSync(folderPath);
        if (!stats.isDirectory()) return stats.size;
        const entries = fs.readdirSync(folderPath, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(folderPath, entry.name);
            if (entry.isDirectory()) {
                total += getFolderSizeBytes(full);
            } else if (entry.isFile()) {
                total += fs.statSync(full).size;
            }
        }
    } catch (e) {}
    return total;
}

// Get downloaded files and storage stats on VPS
app.get('/api/downloads', (req, res) => {
    const downloadsDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
    }

    try {
        const entries = fs.readdirSync(downloadsDir, { withFileTypes: true });
        const files = entries.map(entry => {
            const fullPath = path.join(downloadsDir, entry.name);
            let sizeBytes = 0;
            let modifiedAt = null;
            try {
                const stat = fs.statSync(fullPath);
                modifiedAt = stat.mtime;
                sizeBytes = entry.isDirectory() ? getFolderSizeBytes(fullPath) : stat.size;
            } catch (e) {}

            return {
                name: entry.name,
                isDir: entry.isDirectory(),
                sizeBytes,
                modifiedAt
            };
        });

        const totalSizeBytes = getFolderSizeBytes(downloadsDir);
        res.json({
            totalSizeBytes,
            files
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read downloads directory: ' + err.message });
    }
});

// Clean downloaded files on VPS (clean all or clean specific file/folder)
app.post('/api/downloads/clean', (req, res) => {
    const { name } = req.body || {};
    const downloadsDir = path.join(__dirname, 'downloads');

    if (!fs.existsSync(downloadsDir)) {
        return res.json({ success: true, message: 'Downloads directory is already empty.' });
    }

    try {
        if (name) {
            const safeName = path.basename(name);
            const targetPath = path.join(downloadsDir, safeName);

            // Destroy active torrent session holding this file
            for (const [hash, item] of activeTorrents.entries()) {
                if (item.name === safeName || (item.engine && item.engine.torrent && item.engine.torrent.name === safeName)) {
                    try { if (item.engine) item.engine.destroy(); } catch (e) {}
                    activeTorrents.delete(hash);
                }
            }

            if (fs.existsSync(targetPath)) {
                fs.rmSync(targetPath, { recursive: true, force: true });
                return res.json({ success: true, message: `Deleted ${safeName} from VPS.` });
            } else {
                return res.status(404).json({ error: 'File or folder not found on VPS.' });
            }
        }

        // Clean all files in downloads
        for (const [hash, item] of activeTorrents.entries()) {
            try { if (item.engine) item.engine.destroy(); } catch (e) {}
        }
        activeTorrents.clear();

        const entries = fs.readdirSync(downloadsDir);
        for (const entry of entries) {
            const fullPath = path.join(downloadsDir, entry);
            try {
                fs.rmSync(fullPath, { recursive: true, force: true });
            } catch (err) {
                console.error(`Error deleting ${fullPath}:`, err.message);
            }
        }

        return res.json({ success: true, message: 'All downloaded files cleaned from VPS.' });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to clean downloaded files: ' + err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Torrent-to-Direct server listening at http://localhost:${PORT}`);
});
