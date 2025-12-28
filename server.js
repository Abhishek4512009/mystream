const express = require('express');
const https = require('https'); // Native Node.js module
const cors = require('cors');
const app = express();

app.use(cors());

const API_KEY = process.env.GOOGLE_API_KEY;

app.get('/video/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    const range = req.headers.range;

    if (!API_KEY) return res.status(500).send("Server Error: Key Missing");
    if (!range) return res.status(400).send("Requires Range header");

    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${API_KEY}`;

    // Native Node Request (No Axios)
    const options = {
        headers: {
            'Range': range,
            'Accept': '*/*'
        }
    };

    https.get(driveUrl, options, (streamRes) => {
        // If Google says "Forbidden" (403), tell the user
        if (streamRes.statusCode === 403) {
            console.error("Google Blocked Request. Check API Key or File Permissions.");
            return res.status(403).send("Google Blocked Request");
        }

        // Forward Google's headers to the Browser
        res.writeHead(streamRes.statusCode, streamRes.headers);

        // Pipe the video data directly
        streamRes.pipe(res);
        
    }).on('error', (err) => {
        console.error("Stream Error:", err.message);
        res.sendStatus(500);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
