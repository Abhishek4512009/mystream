const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());

// Retrieve API Key
const API_KEY = process.env.GOOGLE_API_KEY;

app.get('/', (req, res) => {
    res.send("Stream Proxy Online");
});

app.get('/video/:fileId', async (req, res) => {
    const fileId = req.params.fileId;
    
    // 1. Get the Range from the Browser (e.g., "bytes=0-")
    const range = req.headers.range;

    if (!API_KEY) {
        return res.status(500).send("Error: Missing GOOGLE_API_KEY");
    }

    if (!range) {
        return res.status(400).send("Requires Range header");
    }

    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${API_KEY}`;

    try {
        // 2. Ask Google for exactly what the Browser asked for
        const response = await axios({
            method: 'get',
            url: driveUrl,
            responseType: 'stream',
            headers: {
                Range: range, // Forward the range request directly
            },
        });

        // 3. Copy Google's Headers to our Response
        // This includes "Content-Range", "Content-Length", "Content-Type"
        res.set('Content-Range', response.headers['content-range']);
        res.set('Accept-Ranges', response.headers['accept-ranges']);
        res.set('Content-Length', response.headers['content-length']);
        res.set('Content-Type', response.headers['content-type']);

        // 4. Send the status code (usually 206 Partial Content)
        res.status(response.status);

        // 5. Pipe the video data to the user
        response.data.pipe(res);

    } catch (error) {
        // If the browser stops the stream (common), just ignore it
        if (error.code === 'ECONNRESET' || error.message === 'aborted') {
            return; 
        }

        console.error("Stream Error:", error.message);
        if (error.response) {
            console.error("Google Error Details:", error.response.status, error.response.data);
            res.sendStatus(error.response.status);
        } else {
            res.sendStatus(500);
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
