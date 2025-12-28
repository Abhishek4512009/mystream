const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());

// Retrieve API Key from Environment Variables (Secure)
const API_KEY = process.env.GOOGLE_API_KEY;

app.get('/', (req, res) => {
    res.send("Server is running! Use /video/YOUR_FILE_ID to stream.");
});

app.get('/video/:fileId', async (req, res) => {
    const fileId = req.params.fileId;
    const range = req.headers.range;

    if (!API_KEY) {
        return res.status(500).send("Server Error: Missing API Key");
    }

    if (!range) {
        return res.status(400).send("Requires Range header");
    }

    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${API_KEY}`;

    try {
        // 1. Get Video Size
        const headResponse = await axios.head(driveUrl);
        const videoSize = Number(headResponse.headers['content-length']);

        // 2. Parse Range (Which part of the video does the browser want?)
        const CHUNK_SIZE = 10 ** 6; // 1MB chunks
        const start = Number(range.replace(/\D/g, ""));
        const end = Math.min(start + CHUNK_SIZE, videoSize - 1);
        const contentLength = end - start + 1;

        const headers = {
            "Content-Range": `bytes ${start}-${end}/${videoSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": contentLength,
            "Content-Type": "video/mp4",
        };

        res.writeHead(206, headers);

        // 3. Stream that chunk from Google
        const response = await axios({
            method: 'get',
            url: driveUrl,
            responseType: 'stream',
            headers: { Range: `bytes=${start}-${end}` },
        });

        response.data.pipe(res);

    } catch (error) {
        console.error("Error:", error.message);
        res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));