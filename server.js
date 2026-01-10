const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

// CONFIGURATION
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
// Ensure you upload 'service-account.json' to Render/your root folder
const KEY_FILE_PATH = path.join(__dirname, 'service-account.json');
// Optional: If you only want to scan a specific folder, put its ID here. 
// Leave null to scan the whole drive shared with the bot.
const SPECIFIC_FOLDER_ID = null; 

// AUTHENTICATION
const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE_PATH,
    scopes: SCOPES,
});

// ROUTE 1: List Audio Files
app.get('/api/tracks', async (req, res) => {
    try {
        const drive = google.drive({ version: 'v3', auth });
        
        let query = "mimeType contains 'audio/' and trashed = false";
        if (SPECIFIC_FOLDER_ID) {
            query += ` and '${SPECIFIC_FOLDER_ID}' in parents`;
        }

        const response = await drive.files.list({
            q: query,
            fields: 'files(id, name, mimeType, size)',
            pageSize: 100,
        });

        res.json(response.data.files);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error fetching file list');
    }
});

// ROUTE 2: Stream Audio
app.get('/api/stream/:fileId', async (req, res) => {
    const fileId = req.params.fileId;
    const range = req.headers.range;

    try {
        const drive = google.drive({ version: 'v3', auth });

        // Get file metadata for size
        const meta = await drive.files.get({ fileId, fields: 'size' });
        const fileSize = parseInt(meta.data.size);

        // Handle Range Headers (Required for seeking in Spotify-like players)
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;

            const head = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'audio/mpeg',
            };

            res.writeHead(206, head);

            const stream = await drive.files.get(
                { fileId, alt: 'media' },
                { responseType: 'stream', headers: { 'Range': `bytes=${start}-${end}` } }
            );
            
            stream.data.pipe(res);
        } else {
            const head = {
                'Content-Length': fileSize,
                'Content-Type': 'audio/mpeg',
            };
            res.writeHead(200, head);
            const stream = await drive.files.get(
                { fileId, alt: 'media' },
                { responseType: 'stream' }
            );
            stream.data.pipe(res);
        }

    } catch (error) {
        console.error('Stream Error:', error);
        res.status(500).end();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
