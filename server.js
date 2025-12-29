const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());

// Helper function to find the "Real" Google Link
async function getDirectLink(fileId) {
    const initialUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
    
    try {
        // 1. Ask Google for the link, but DO NOT follow the redirect automatically
        const response = await axios({
            method: 'GET',
            url: initialUrl,
            maxRedirects: 0, // STOP at the first redirect
            validateStatus: status => status >= 200 && status < 400, // Accept 302 redirects
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        // 2. If we found a cookie warning (for large files), we need to confirm it
        if (response.headers['set-cookie']) {
            const cookies = response.headers['set-cookie'].join('');
            if (cookies.includes('download_warning')) {
                // Extract code and retry
                const confirmCode = cookies.match(/download_warning_a=[^;]*/)[0].split('=')[1];
                return `${initialUrl}&confirm=${confirmCode}`;
            }
        }

        // 3. If Google sent a "Location" header, that is the REAL link
        if (response.headers.location) {
            return response.headers.location;
        }

        // Fallback
        return initialUrl;

    } catch (err) {
        console.error("Link Fetch Error:", err.message);
        return null;
    }
}

app.get('/video/:fileId', async (req, res) => {
    const fileId = req.params.fileId;
    const range = req.headers.range;

  // ADD THIS INSTEAD:
if (!range) {
    range = 'bytes=0-'; // Default to start of video if no range is asked
}

    try {
        // STEP 1: Get the REAL long googleusercontent link
        const directLink = await getDirectLink(fileId);
        
        if (!directLink) {
             return res.status(404).send("Could not find direct link. Check File ID/Permissions.");
        }

        // STEP 2: Stream from that Real Link
        const videoResponse = await axios({
            method: 'get',
            url: directLink,
            responseType: 'stream',
            headers: {
                'Range': range,
            }
        });

        // STEP 3: Pipe it
        res.set('Content-Range', videoResponse.headers['content-range']);
        res.set('Accept-Ranges', 'bytes');
        res.set('Content-Length', videoResponse.headers['content-length']);
        res.set('Content-Type', 'video/mp4');
        res.status(206);
        
        videoResponse.data.pipe(res);

    } catch (error) {
        // If the browser closes the stream, ignore it
        if (error.code === 'ECONNRESET') return;
        
        console.error("Proxy Error:", error.message);
        if (error.response) {
            // This logs if Google sent a 403 or 404
             console.error("Google Response Status:", error.response.status);
        }
        res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Redirect-Proxy running on port ${PORT}`));

