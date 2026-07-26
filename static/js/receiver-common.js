// Shared between camera.html and talent.html (both are read-only stage displays)
const socket = io();
let rundown = [];
let urgentTimeout;
const realTimeClockEl = document.getElementById('real-time-clock');

function formatTimecode(seconds) {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    const ms = Math.floor((seconds % 1) * 10).toString();
    return `${m}:${s}.${ms}`;
}

setInterval(() => {
    if (!realTimeClockEl) return;
    const now = new Date();
    realTimeClockEl.innerText = now.toLocaleTimeString('it-IT', { hour12: false });
}, 1000);

socket.on('rundown_updated', (data) => { rundown = data.sort((a, b) => a.start - b.start); });

socket.on('urgent_message', (data) => {
    document.getElementById('urgent-text').innerText = data.msg;
    document.getElementById('urgent-overlay').style.display = 'flex';
    clearTimeout(urgentTimeout);
    urgentTimeout = setTimeout(() => { document.getElementById('urgent-overlay').style.display = 'none'; }, 6000);
});

// --- INTERCOM AUDIO RECEIVE (realtime PCM streaming, continuous queue, click-free) ---
let playbackCtx = null;
let nextPlayTime = 0;
function ensurePlaybackCtx() {
    if (!playbackCtx) playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (playbackCtx.state === 'suspended') playbackCtx.resume();
    return playbackCtx;
}
socket.on('audio_stream', (data) => {
    try {
        const ctx = ensurePlaybackCtx();
        const floatData = new Float32Array(data.audio);
        const sampleRate = data.sampleRate || ctx.sampleRate;
        const buffer = ctx.createBuffer(1, floatData.length, sampleRate);
        buffer.copyToChannel(floatData, 0);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        const now = ctx.currentTime;
        if (nextPlayTime < now + 0.02) nextPlayTime = now + 0.05;
        source.start(nextPlayTime);
        nextPlayTime += buffer.duration;
    } catch (err) {
        console.error("Audio stream playback error:", err);
    }
});
