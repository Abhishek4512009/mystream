const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const path = require('path');
const ytSearch = require('yt-search');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. ENVIRONMENT VARIABLES ---
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const SPECIFIC_FOLDER_ID = process.env.FOLDER_ID;

// Safety Check
if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !SPECIFIC_FOLDER_ID) {
    console.error("❌ ERROR: Missing Environment Variables!");
    process.exit(1);
}

// --- 2. YT-DLP CONFIGURATION ---
const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const binaryPath = path.join(__dirname, binaryName);
const ytDlpWrap = new YTDlpWrap(binaryPath);

// --- 3. COOKIES FIX (CRITICAL) ---
// We copy the locked secret file to a writable temporary folder
const LOCKED_COOKIES_PATH = '/etc/secrets/cookies.txt';
const WRITABLE_COOKIES_PATH = path.join(os.tmpdir(), 'cookies.txt');

try {
    if (fs.existsSync(LOCKED_COOKIES_PATH)) {
        fs.copyFileSync(LOCKED_COOKIES_PATH, WRITABLE_COOKIES_PATH);
        console.log(`✅ Cookies copied to writable path: ${WRITABLE_COOKIES_PATH}`);
    }
} catch (err) {
    console.error("⚠️ Could not copy cookies:", err.message);
}

// --- 4. GOOGLE AUTHENTICATION ---
const oauth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
);

oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });


// --- ROUTE: List Files ---
app.get('/api/tracks', async (req, res) => {
    try {
        const query = `mimeType contains 'audio/' and trashed = false and '${SPECIFIC_FOLDER_ID}' in parents`;
        const response = await drive.files.list({
            q: query,
            fields: 'files(id, name, mimeType, size)',
            pageSize: 100,
        });
        res.json(response.data.files);
    } catch (error) {
        console.error("List Error:", error.message);
        res.status(500).send('Error fetching tracks');
    }
});

// --- ROUTE: Stream ---
app.get('/api/stream/:fileId', async (req, res) => {
    const { fileId } = req.params;
    const { range } = req.headers;

    try {
        const meta = await drive.files.get({ fileId, fields: 'size' });
        const fileSize = parseInt(meta.data.size);

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'audio/mpeg',
            });

            const stream = await drive.files.get(
                { fileId, alt: 'media' },
                { responseType: 'stream', headers: { 'Range': `bytes=${start}-${end}` } }
            );
            stream.data.pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': 'audio/mpeg',
            });
            const stream = await drive.files.get(
                { fileId, alt: 'media' },
                { responseType: 'stream' }
            );
            stream.data.pipe(res);
        }
    } catch (error) {
        console.error('Stream Error:', error.message);
        res.status(500).end();
    }
});

// --- ROUTE: Download ---
app.post('/api/download', async (req, res) => {
    const { songName } = req.body;
    if (!songName) return res.status(400).send('No song name provided');

    console.log(`🔎 Searching: ${songName}`);

    try {
        const searchResults = await ytSearch(songName);
        const video = searchResults.videos[0];
        if (!video) return res.status(404).send('Not found');

        console.log(`🚀 Found: ${video.title}`);

        // Construct yt-dlp arguments
        let ytArgs = [
            video.url,
            '-f', 'bestaudio/best', // Changed to be more flexible
            '-o', '-',
            '--no-check-certificates',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        ];

        // Use the writable cookies if they exist
        if (fs.existsSync(WRITABLE_COOKIES_PATH)) {
            console.log("🍪 Using writable cookies...");
            ytArgs.push('--cookies', WRITABLE_COOKIES_PATH);
        } else {
            console.log("⚠️ No cookies found. YouTube might block this.");
        }

        // Stream via yt-dlp
        let ytStream = ytDlpWrap.execStream(ytArgs);

        const fileMetadata = {
            name: `${video.title}.mp3`,
            parents: [SPECIFIC_FOLDER_ID]
        };
        const media = {
            mimeType: 'audio/mpeg',
            body: ytStream
        };

        const driveResponse = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, name'
        });

        console.log(`✅ Uploaded: ${driveResponse.data.name}`);
        res.json({ success: true, file: driveResponse.data });

    } catch (error) {
        console.error('Download Failed:', error.message);
        res.status(500).send('Download failed. Check server logs.');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
