const express = require('express');
const https = require('https');
const cors = require('cors');
const app = express();

app.use(cors());

const API_KEY = process.env.GOOGLE_API_KEY;

app.get('/video/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    const range = req.headers.range;

    if (!API_KEY) return res.status(500).send("Error: Missing API Key");
    if (!range) return res.status(400).send("Requires Range header");

    // 1. GENERATE A RANDOM USER ID (Bypasses "User Rate Limit")
    const randomUser = Math.random().toString(36).substring(7);

    // 2. CONSTRUCT URL WITH "acknowledgeAbuse=true" (Bypasses 100MB Limit)
    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${API_KEY}&acknowledgeAbuse=true&quotaUser=${randomUser}`;

    const options = {
        headers: {
            'Range': range,
            'Accept': '*/*'
        }
    };

    // 3. NATIVE REQUEST (Fixes "Stops after 1 second" bug)
    const externalReq = https.get(driveUrl, options, (streamRes) => {

        // --- ERROR TRAP: Catch the specific 403 Reason ---
        if (streamRes.statusCode === 403) {
            console.error(`GOOGLE BLOCKED FILE ${fileId}. Status: 403`);
            
            // Read the error message to see WHY
            let errorData = '';
            streamRes.on('data', chunk => errorData += chunk);
            streamRes.on('end', () => {
                console.error("GOOGLE ERROR REASON:", errorData);
            });
            
            return res.status(403).send("Google Blocked This Request. Check Render Logs.");
        }

        // Pipe headers and video data directly to user
        res.writeHead(streamRes.statusCode, streamRes.headers);
        streamRes.pipe(res);
        
    });
    
    externalReq.on('error', (err) => {
        console.error("Network Error:", err.message);
        res.sendStatus(500);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
