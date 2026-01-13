const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const path = require('path');
const ytSearch = require('yt-search');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs');
const os = require('os');
const ffmpegPath = require('ffmpeg-static'); // <--- NEW DEPENDENCY
const mongoose = require('mongoose');

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

// --- MONGODB CONNECTION ---
const MONGO_URI = "mongodb+srv://user:tn602025@cluster0.rstkwca.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.error("❌ MongoDB Error:", err));

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    folderId: { type: String, required: true },
    trackOrder: { type: [String], default: [] } // Store file sorting
});
const User = mongoose.model('User', UserSchema);

// --- ROUTES ---

// 1. REGISTER
app.post('/api/register', async (req, res) => {
    try {
        const { username, password } = req.body; // Removed folderId
        if (!username || !password) return res.status(400).json({ error: "Missing fields" });

        const existing = await User.findOne({ username });
        if (existing) return res.status(400).json({ error: "Username taken" });

        // 1. Create a Folder on Drive
        const folderMetadata = {
            name: `mystream_${username}`,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [SPECIFIC_FOLDER_ID] // Create inside the main app folder
        };
        const driveRes = await drive.files.create({
            resource: folderMetadata,
            fields: 'id'
        });
        const newFolderId = driveRes.data.id;

        // 2. Save User
        const newUser = new User({ username, password, folderId: newFolderId });
        await newUser.save();

        res.json({ success: true, folderId: newFolderId });
    } catch (err) {
        console.error("Register Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// 2. LOGIN
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });

        if (!user || user.password !== password) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        res.json({ success: true, folderId: user.folderId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/tracks', async (req, res) => {
    try {
        // Use provided folderId from query, or fallback to env var (default library)
        const targetFolderId = req.query.folderId || SPECIFIC_FOLDER_ID;

        const query = `mimeType contains 'audio/' and trashed = false and '${targetFolderId}' in parents`;
        const response = await drive.files.list({
            q: query,
            fields: 'files(id, name, mimeType, size)',
            pageSize: 100,
        });
        
        let files = response.data.files;

        // Sort if User context exists
        if (targetFolderId !== SPECIFIC_FOLDER_ID) {
            const user = await User.findOne({ folderId: targetFolderId });
            if (user && user.trackOrder && user.trackOrder.length > 0) {
                const orderMap = new Map(user.trackOrder.map((id, index) => [id, index]));
                files.sort((a, b) => {
                    const indexA = orderMap.has(a.id) ? orderMap.get(a.id) : 9999;
                    const indexB = orderMap.has(b.id) ? orderMap.get(b.id) : 9999;
                    return indexA - indexB;
                });
            }
        }

        res.json(files);
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

// --- LIBRARY MANAGEMENT ROUTES ---

// Copy track from Global to User
app.post('/api/library/add', async (req, res) => {
    const { fileId, folderId } = req.body;
    try {
        await drive.files.copy({
            fileId: fileId,
            resource: { parents: [folderId] }
        });
        res.json({ success: true });
    } catch (error) {
        console.error("Copy Error:", error);
        res.status(500).json({ error: "Failed to add song" });
    }
});

// Remove track from User Library
app.post('/api/library/remove', async (req, res) => {
    const { fileId } = req.body;
    try {
        await drive.files.delete({ fileId: fileId });
        res.json({ success: true });
    } catch (error) {
        console.error("Delete Error:", error);
        res.status(500).json({ error: "Failed to delete song" });
    }
});

// Reorder tracks
app.post('/api/library/reorder', async (req, res) => {
    const { folderId, newOrder } = req.body;
    try {
        await User.findOneAndUpdate(
            { folderId: folderId }, 
            { trackOrder: newOrder }
        );
        res.json({ success: true });
    } catch (error) {
        console.error("Reorder Error:", error);
        res.status(500).json({ error: "Failed to save order" });
    }
});

// --- NEW DOWNLOADER LOGIC (Download -> Convert -> Upload) ---
app.post('/api/download', async (req, res) => {
    const { songName, folderId } = req.body;
    if (!songName) return res.status(400).send('No song name provided');

    // Choose target folder: Provided one (user's) OR default global
    const targetFolder = folderId || SPECIFIC_FOLDER_ID;

    console.log(`🔎 Searching: ${songName} for folder: ${targetFolder}`);

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
            parents: [targetFolder] // Upload to the User's folder
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