        let isShowRunning = false;
        let stageEntered = false;

        const setupEl = document.getElementById('setup');
        const masterTimecodeEl = document.getElementById('master-timecode');
        const statusTextEl = document.getElementById('status-text');
        const lyricsTextEl = document.getElementById('lyrics-text');
        const progBarEl = document.getElementById('progress-bar');
        const currentTimerEl = document.getElementById('current-timer');

        function enterStageMode() {
            setupEl.style.display = 'none';
            stageEntered = true;
            ensurePlaybackCtx(); // unlock audio playback using this click's user gesture
            socket.emit('get_status_sync');
        }

        socket.on('connect', () => { if (stageEntered) socket.emit('get_status_sync'); });

        socket.on('show_started', () => { isShowRunning = true; statusTextEl.innerText = "ON AIR"; statusTextEl.classList.add('live'); });

        socket.on('timecode', (data) => {
            const currentTime = data.time;
            masterTimecodeEl.innerText = formatTimecode(currentTime);

            // The prompter reads the marker track directly instead of scene titles
            let currentMarker = rundown.find(c => c.type === 'marker' && currentTime >= c.start && currentTime < c.end);

            if (currentMarker && currentMarker.text) {
                lyricsTextEl.innerText = currentMarker.text;

                const timeLeft = Math.max(0, currentMarker.end - currentTime);
                const duration = currentMarker.end - currentMarker.start;
                let percentage = (timeLeft / duration) * 100;

                progBarEl.style.width = Math.max(0, Math.min(100, percentage)) + "%";
                currentTimerEl.innerText = timeLeft.toFixed(1);
            } else {
                lyricsTextEl.innerHTML = `<span style="color:#555;">—</span>`;
                progBarEl.style.width = "0%";
                currentTimerEl.innerText = "--";
            }
        });

        socket.on('status', (data) => {
            if (!data.msg.includes('LIVE') && !data.msg.includes('ARMED')) {
                isShowRunning = false;
                statusTextEl.innerText = "STANDBY";
                statusTextEl.classList.remove('live');
                masterTimecodeEl.innerText = "00:00.0";
                lyricsTextEl.innerHTML = `...`;
                progBarEl.style.width = "0%";
                currentTimerEl.innerText = "--";
            }
        });
