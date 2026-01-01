const express = require('express');
const { spawn } = require('child_process');
const cors = require('cors');
const app = express();

// Allow your tablet to talk to your PC
app.use(cors());

app.post('/convert', (req, res) => {
    console.log('Stream started...');

    // Tell the tablet this is a file download
    res.header('Content-Disposition', 'attachment; filename="converted.mp4"');
    res.header('Content-Type', 'video/mp4');

    // Spawn FFmpeg
    // -i pipe:0  -> Read from the incoming request stream (Tablet)
    // -f mp4     -> Output format
    // movflags   -> Essential for streaming MP4 (moves metadata to front)
    // pipe:1     -> Write to the outgoing response stream (Back to Tablet)
    const ffmpeg = spawn('ffmpeg', [
        '-i', 'pipe:0',       
        '-c:v', 'copy',       // 'copy' is instant. Change to 'libx264' to compress (slower)
        '-c:a', 'copy',
        '-movflags', 'frag_keyframe+empty_moov', 
        '-f', 'mp4',
        'pipe:1'
    ]);

    // Pipe the upload stream into FFmpeg
    req.pipe(ffmpeg.stdin);

    // Pipe FFmpeg's output back to the response
    ffmpeg.stdout.pipe(res);

    // Log errors
    ffmpeg.stderr.on('data', (data) => {
        // Uncomment to see FFmpeg logs
        // console.log(`FFmpeg: ${data}`); 
    });

    ffmpeg.on('close', (code) => {
        console.log(`Conversion finished with code ${code}`);
    });
});

app.listen(3001, '0.0.0.0', () => {
    console.log('Converter Server running on port 3001');
});