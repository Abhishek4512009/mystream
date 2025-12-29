const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());

app.get('/video/:fileId', async (req, res) => {
    const fileId = req.params.fileId;
    const range = req.headers.range;

    if (!range) {
        return res.status(400).send("Requires Range header");
    }

    try {
        // Phase 1: Initial Request (Pretend to be a Browser)
        // We don't use the API here. We use the public download link.
        const driveUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
        
        const firstResponse = await axios({
            method: 'get',
            url: driveUrl,
            headers: {
                // Crucial: Spoof the User-Agent so Google thinks we are Chrome, not a bot
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
            validateStatus: false, // Don't throw error on 403/302 yet
        });

        // Phase 2: Handle "Virus Scan" Warning (For large files)
        // If Google sends us a warning page (HTML), we must find the "confirm" token.
        let finalUrl = driveUrl;
        
        if (firstResponse.headers['set-cookie']) {
            // Extract the download warning cookie
            const cookies = firstResponse.headers['set-cookie'];
            const downloadWarning = cookies.find(c => c.includes('download_warning'));
            
            if (downloadWarning) {
                // Construct the "Confirm" URL
                // The warning cookie usually contains the token we need
                const token = downloadWarning.split(';')[0].split('=')[1];
                finalUrl += `&confirm=${token}`;
            }
        }

        // Phase 3: Stream the Video
        const videoResponse = await axios({
            method: 'get',
            url: finalUrl,
            responseType: 'stream',
            headers: {
                'Range': range,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            }
        });

        // Forward headers
        res.set('Content-Range', videoResponse.headers['content-range']);
        res.set('Accept-Ranges', 'bytes');
        res.set('Content-Length', videoResponse.headers['content-length']);
        res.set('Content-Type', 'video/mp4');
        
        res.status(206);
        videoResponse.data.pipe(res);

    } catch (error) {
        console.error("Stream Failed:", error.message);
        if (error.response) {
            console.error("Google Status:", error.response.status);
            // If it's 403 here, it's definitely the "Quota Exceeded" lock
            if (error.response.status === 403) {
                 console.error("CRITICAL: This File ID is locked by Google. Use a new file.");
            }
        }
        res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`No-API Proxy running on port ${PORT}`));
