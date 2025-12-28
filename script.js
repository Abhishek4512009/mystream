// --- CONFIGURATION ---
const API_KEY = "AIzaSyBjkpshz3qevxyDDvqSyM0sF83F-DU2quI"; // From Step 1

const movies = [
    { 
        title: "My 4K Movie", 
        id: "1CwKOe66qu484pJoFcvqNrdI8IItyif36" // e.g., 1A2B3C...
    },
    { 
        title: "Vacation Video", 
        id: "1o5LMqPrsSoaXA8xOoB0z6HbwRfiwmpiL"
    }
];
// ---------------------

const grid = document.getElementById('video-grid');
const modal = document.getElementById('video-modal');
let player = null; // We will initialize this later

// 1. Build the Grid
movies.forEach(movie => {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.background = `linear-gradient(45deg, #222, #111)`;
    card.innerHTML = `<div class="card-title">${movie.title}</div>`;

    card.onclick = () => {
        openPlayer(movie.id);
    };

    grid.appendChild(card);
});

// 2. Open Player Logic
function openPlayer(fileId) {
    modal.style.display = 'flex';

    // The Magic Link: This uses the API to get the raw file stream
    // "alt=media" tells Google to stream the bytes, not show a webpage
   // We add '&acknowledgeAbuse=true' to tell Google "I trust this file, just give it to me."
const streamUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${API_KEY}&acknowledgeAbuse=true`;
    // Initialize Video.js if it doesn't exist yet
    if (!player) {
        player = videojs('my-player');
    }

    // Load the new video source
    player.src({ type: 'video/mp4', src: streamUrl });
    player.play();
}

// 3. Close Logic
function closePlayer() {
    modal.style.display = 'none';
    if (player) {
        player.pause();
    }
}
