const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const path = require('path');
const ytSearch = require('yt-search');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs');
const os = require('os');
const ffmpegPath = require('ffmpeg-static'); // <--- NEW DEPENDENCY

const app = express();
app.use(cors());
app.use(express.json());

// --- 1. ENVIRONMENT VARIABLES ---
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const SPECIFIC_FOLDER_ID = process.env.FOLDER_ID;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !SPECIFIC_FOLDER_ID) {
    console.error("❌ ERROR: Missing Environment Variables!");
    process.exit(1);
}

// --- 2. SETUP TOOLS ---
const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const binaryPath = path.join(__dirname, binaryName);
const ytDlpWrap = new YTDlpWrap(binaryPath);

// Cookies Logic
const LOCKED_COOKIES_PATH = '/etc/secrets/cookies.txt';
const WRITABLE_COOKIES_PATH = path.join(os.tmpdir(), 'cookies.txt');

try {
    if (fs.existsSync(LOCKED_COOKIES_PATH)) {
        fs.copyFileSync(LOCKED_COOKIES_PATH, WRITABLE_COOKIES_PATH);
        console.log(`✅ Cookies ready at: ${WRITABLE_COOKIES_PATH}`);
    }
} catch (err) {
    console.error("⚠️ Cookies setup failed:", err.message);
}

// --- 3. AUTH ---
const oauth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });


// --- ROUTES ---
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
        res.status(500).send('Error fetching tracks');
    }
});

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
            const stream = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream', headers: { 'Range': `bytes=${start}-${end}` } });
            stream.data.pipe(res);
        } else {
            res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'audio/mpeg' });
            const stream = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
            stream.data.pipe(res);
        }
    } catch (error) {
        console.error('Stream Error:', error.message);
        res.status(500).end();
    }
});

// --- NEW DOWNLOADER LOGIC (Download -> Convert -> Upload) ---
app.post('/api/download', async (req, res) => {
    const { songName } = req.body;
    if (!songName) return res.status(400).send('No song name provided');

    console.log(`🔎 Searching: ${songName}`);

    try {
        const searchResults = await ytSearch(songName);
        const video = searchResults.videos[0];
        if (!video) return res.status(404).send('Not found');

        console.log(`🚀 Found: ${video.title} - Starting Conversion...`);

        // Generate a clean filename for the temp folder
        const cleanTitle = video.title.replace(/[^a-zA-Z0-9]/g, '_'); 
        const tempFilePath = path.join(os.tmpdir(), `${cleanTitle}.mp3`);

        // 1. Download & Convert to File
        let ytArgs = [
            video.url,
            '-x',                    // Extract audio
            '--audio-format', 'mp3', // Convert to MP3
            '--ffmpeg-location', ffmpegPath, // Use the FFmpeg we installed
            '-o', tempFilePath,      // Output to temp file
            '--no-check-certificates',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        ];

        if (fs.existsSync(WRITABLE_COOKIES_PATH)) {
            ytArgs.push('--cookies', WRITABLE_COOKIES_PATH);
        }

        // Run the download
        await ytDlpWrap.execPromise(ytArgs);
        console.log("✅ Conversion finished. Uploading to Drive...");

        // 2. Upload the MP3 file
        const fileMetadata = {
            name: `${video.title}.mp3`,
            parents: [SPECIFIC_FOLDER_ID]
        };
        const media = {
            mimeType: 'audio/mpeg',
            body: fs.createReadStream(tempFilePath)
        };

        const driveResponse = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, name'
        });

        console.log(`🎉 Upload Complete: ${driveResponse.data.name}`);
        
        // 3. Cleanup (Delete temp file)
        fs.unlinkSync(tempFilePath);

        res.json({ success: true, file: driveResponse.data });

    } catch (error) {
        console.error('Download Failed:', error.message);
        res.status(500).send('Download failed. Check logs.');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
