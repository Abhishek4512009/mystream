const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const path = require('path');
const https = require('https');
const fs = require('fs');

const app = express();
app.use(cors());

// --- CONFIGURATION ---
const KEY_FILE_PATH = path.join(__dirname, 'service-account.json');
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const CACHE_DIR = path.join(__dirname, 'cache');

// 🛑 SETTINGS
const MIN_BUFFER_PERCENT = 0.10; // Wait for 10% (Faster start)
const MAX_START_WAIT_MB = 100 * 1024 * 1024; // Wait max 100MB

// 🗑️ CLEANING SETTINGS
const MAX_CACHE_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB Limit
// If cache > 10GB, we delete old files until we are back to safety.

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE_PATH,
    scopes: SCOPES,
});

const driveAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
const activeDownloads = new Set();

// --- THE CLEANER FUNCTION ---
function manageCache() {
    try {
        const files = fs.readdirSync(CACHE_DIR);
        let totalSize = 0;
        const fileStats = [];

        // 1. Calculate Total Size & Gather Info
        files.forEach(file => {
            const filePath = path.join(CACHE_DIR, file);
            const stats = fs.statSync(filePath);
            totalSize += stats.size;
            fileStats.push({ path: filePath, time: stats.mtime.getTime(), size: stats.size });
        });

        // 2. Check if we are over the limit
        if (totalSize > MAX_CACHE_SIZE) {
            console.log(`[Cleaner] 🧹 Cache full (${(totalSize/1024/1024/1024).toFixed(2)} GB). Deleting old files...`);
            
            // Sort by Oldest First
            fileStats.sort((a, b) => a.time - b.time);

            for (const file of fileStats) {
                if (totalSize <= MAX_CACHE_SIZE) break; // Stop if we are safe

                // Don't delete a file that is currently being downloaded!
                const fileName = path.basename(file.path).replace('.mp4', '');
                if (activeDownloads.has(fileName)) continue;

                try {
                    fs.unlinkSync(file.path);
                    totalSize -= file.size;
                    console.log(`[Cleaner] 🗑️ Deleted: ${path.basename(file.path)}`);
                } catch (err) {
                    console.error(`[Cleaner] Error deleting ${file.path}`);
                }
            }
        }
    } catch (err) {
        console.error("[Cleaner] Error:", err.message);
    }
}

async function startBackgroundCaching(fileId, filePath, totalSize) {
    if (activeDownloads.has(fileId)) return;
    if (fs.existsSync(filePath) && fs.statSync(filePath).size === totalSize) {
        // Update "Last Accessed" time so this file doesn't get deleted soon
        const time = new Date();
        fs.utimesSync(filePath, time, time);
        return;
    }

    // RUN CLEANER BEFORE STARTING
    manageCache();

    console.log(`[Cache] 📥 Starting background download for ${fileId}...`);
    activeDownloads.add(fileId);

    const drive = google.drive({ version: 'v3', auth });
    const dest = fs.createWriteStream(filePath, { flags: 'w' });

    try {
        const res = await drive.files.get(
            { fileId: fileId, alt: 'media', acknowledgeAbuse: true },
            { responseType: 'stream', httpsAgent: driveAgent }
        );

        res.data.pipe(dest);

        res.data.on('end', () => {
            console.log(`[Cache] ✅ Download Complete: ${fileId}`);
            activeDownloads.delete(fileId);
        });

        res.data.on('error', (err) => {
            console.error(`[Cache] ❌ Download Failed:`, err.message);
            activeDownloads.delete(fileId);
            // Delete partial file to prevent corruption
            if(fs.existsSync(filePath)) fs.unlinkSync(filePath); 
        });

    } catch (e) {
        console.error("[Cache] Start Error:", e.message);
        activeDownloads.delete(fileId);
    }
}

app.get('/video/:fileId', async (req, res) => {
    const fileId = req.params.fileId;
    const filePath = path.join(CACHE_DIR, `${fileId}.mp4`);
    const drive = google.drive({ version: 'v3', auth });

    try {
        const metadata = await drive.files.get(
            { fileId: fileId, fields: 'size, mimeType' },
            { httpsAgent: driveAgent }
        );
        const fileSize = parseInt(metadata.data.size);
        const contentType = metadata.data.mimeType || 'video/mp4';

        startBackgroundCaching(fileId, filePath, fileSize);

        const requiredBuffer = Math.min(fileSize * MIN_BUFFER_PERCENT, MAX_START_WAIT_MB);
        
        console.log(`\n--- Request for ${fileId} ---`);

        const waitForBuffer = () => {
            if (!fs.existsSync(filePath)) return setTimeout(waitForBuffer, 1000);

            const currentSize = fs.statSync(filePath).size;
            process.stdout.write(`\r   ⏳ Buffering: ${(currentSize/1024/1024).toFixed(0)} / ${(requiredBuffer/1024/1024).toFixed(0)} MB`);

            if (currentSize >= requiredBuffer || currentSize === fileSize) {
                console.log("\n   🚀 Ready! Starting Stream...");
                serveStream();
            } else {
                setTimeout(waitForBuffer, 1000);
            }
        };

        const serveStream = () => {
            const range = req.headers.range;
            if (!range) {
                res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': contentType });
                fs.createReadStream(filePath).pipe(res);
            } else {
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunksize = (end - start) + 1;

                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunksize,
                    'Content-Type': contentType,
                });

                const safeStream = () => {
                    if (!fs.existsSync(filePath)) return res.end(); // File deleted?
                    const currentDiskSize = fs.statSync(filePath).size;
                    if (currentDiskSize < start) {
                        setTimeout(safeStream, 500);
                    } else {
                        fs.createReadStream(filePath, { start, end }).pipe(res);
                    }
                };
                safeStream();
            }
        };

        if (fs.existsSync(filePath) && fs.statSync(filePath).size === fileSize) {
             console.log("   ✅ Cached Hit. Playing instantly.");
             // Update timestamp to keep this file fresh (prevent deletion)
             const time = new Date();
             fs.utimesSync(filePath, time, time);
             serveStream();
        } else {
             waitForBuffer();
        }

    } catch (error) {
        console.error("\nServer Error:", error.message);
        if (!res.headersSent) res.status(500).send("Error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🛡️ Auto-Cleaning Server running on port ${PORT}`));