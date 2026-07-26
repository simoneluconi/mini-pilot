        let myScene = ""; let currentMode = "playback"; let manualLiveScene = ""; let previewScene = ""; let isShowRunning = false; let wasLivePreviously = false;

        const body = document.body;
        const offlineOverlay = document.getElementById('offline-overlay'); const flashOverlay = document.getElementById('flash-overlay'); const masterTimecodeEl = document.getElementById('master-timecode'); const statusTextEl = document.getElementById('status-text'); const mainTimerEl = document.getElementById('main-timer'); const lyricsTrackEl = document.getElementById('lyrics-track'); const progContainerEl = document.getElementById('progress-container'); const progBarEl = document.getElementById('progress-bar'); const metadataBox = document.getElementById('metadata-box'); const shotNumberEl = document.getElementById('shot-number'); const shotTotalEl = document.getElementById('shot-total'); const shotMovementEl = document.getElementById('shot-movement'); const shotNoteEl = document.getElementById('shot-note'); const nextActionBox = document.getElementById('next-action-box'); const nextActionDetails = document.getElementById('next-action-details'); const upcomingListEl = document.getElementById('upcoming-list');

        socket.on('disconnect', () => { offlineOverlay.style.display = 'flex'; });
        socket.on('connect', () => { offlineOverlay.style.display = 'none'; if(myScene) socket.emit('get_status_sync'); });

        // Remember the last camera assigned on this device (survives an F5 refresh)
        (function restoreLastCamera() {
            const saved = localStorage.getItem('minipilot_camera_scene');
            const sel = document.getElementById('my-camera');
            if (saved && sel && Array.from(sel.options).some(o => o.value === saved)) sel.value = saved;
        })();

        function enterCameraMode() {
            myScene = document.getElementById('my-camera').value;
            localStorage.setItem('minipilot_camera_scene', myScene);
            document.getElementById('cam-badge').innerText = "CAM: " + myScene;
            document.getElementById('setup').style.display = 'none';
            document.getElementById('viewfinder').style.display = 'flex';
            ensurePlaybackCtx(); // unlock audio playback using this click's user gesture
            socket.emit('get_status_sync');
        }

        socket.on('show_started', (data) => { currentMode = data.mode; manualLiveScene = ""; previewScene = ""; isShowRunning = true; lyricsTrackEl.style.display = 'flex'; });
        socket.on('mode_changed', (data) => { currentMode = data.mode; if (currentMode === 'playback') { manualLiveScene = ""; previewScene = ""; } });
        socket.on('live_cut', (data) => { manualLiveScene = data.scene; });
        socket.on('preview_changed', (data) => { previewScene = data.scene; });

        function setStandby() {
            body.className = ''; statusTextEl.innerText = "STANDBY"; mainTimerEl.innerText = "--"; mainTimerEl.style.color = "#444"; mainTimerEl.classList.remove('warning-end'); progContainerEl.style.display = 'none'; metadataBox.classList.remove('visible'); nextActionBox.style.display = 'none'; wasLivePreviously = false;
            if (!isShowRunning) { lyricsTrackEl.style.display = 'none'; }
            upcomingListEl.innerHTML = `<span style="color: #555; font-style: italic;">Standby</span>`;
        }

        function triggerCutFlash() { flashOverlay.classList.add('flash'); setTimeout(() => { flashOverlay.classList.remove('flash'); }, 50); }

        socket.on('timecode', (data) => {
            const currentTime = data.time; masterTimecodeEl.innerText = formatTimecode(currentTime);
            const totalShotsCount = rundown.filter(c => c.type === 'shot').length;

            // Read the lyrics/cue text directly from the marker track
            let currentMarker = rundown.find(c => c.type === 'marker' && currentTime >= c.start && currentTime < c.end);
            if (currentMarker && currentMarker.text) lyricsTrackEl.innerHTML = `<span>${currentMarker.text}</span>`;
            else lyricsTrackEl.innerHTML = `<span style="color: #888; font-style: italic;">🎵 No active cue</span>`;

            if (currentMode === 'override' || currentMode === 'record') {
                if (myScene === manualLiveScene) {
                    upcomingListEl.innerHTML = `<span style="color: #ffcc00; font-style: italic;">Director is cutting manually</span>`;
                    if(!wasLivePreviously) triggerCutFlash();
                    wasLivePreviously = true; body.className = 'live'; statusTextEl.innerText = "ON AIR"; mainTimerEl.innerText = "LIVE"; mainTimerEl.style.color = "white"; mainTimerEl.classList.remove('warning-end'); progContainerEl.style.display = 'none'; nextActionBox.style.display = 'none'; shotNumberEl.innerText = "MANUAL CUT"; shotTotalEl.innerText = ""; shotMovementEl.style.display = "none"; shotNoteEl.innerText = "Director took manual control"; metadataBox.classList.add('visible');
                } else if (myScene === previewScene) {
                    upcomingListEl.innerHTML = `<span style="color: #ffcc00; font-style: italic;">Director is cutting manually</span>`;
                    wasLivePreviously = false; body.className = 'dir-preview'; statusTextEl.innerText = "PREVIEW"; mainTimerEl.innerText = "STANDBY"; mainTimerEl.style.color = "#ffcc00"; mainTimerEl.classList.remove('warning-end'); progContainerEl.style.display = 'none'; nextActionBox.style.display = 'none'; shotNumberEl.innerText = "IN PREVIEW"; shotTotalEl.innerText = ""; shotMovementEl.style.display = "none"; shotNoteEl.innerText = "Get ready — you may be cut live any moment"; metadataBox.classList.add('visible');
                } else {
                    upcomingListEl.innerHTML = `<span style="color: #ffcc00; font-style: italic;">Director is cutting manually</span>`;
                    setStandby();
                }
                return;
            }

            let isLive = false; let currentLiveShot = null; let nextShot = null; let futureShotsQueue = [];
            for (let clip of rundown) {
                if (clip.type === 'marker') continue; // Ignore markers when computing camera state
                if (clip.scene === myScene) {
                    if (currentTime >= clip.start && currentTime < clip.end) { isLive = true; currentLiveShot = clip; } 
                    else if (currentTime < clip.start) { if (!nextShot) nextShot = clip; futureShotsQueue.push(clip); }
                }
            }

            if (futureShotsQueue.length > 0) { upcomingListEl.innerHTML = futureShotsQueue.map(clip => `<div class="upcoming-item"><span class="upcoming-time">${formatTimecode(clip.start).slice(0,5)}</span> Shot #${clip.shotNumber || '?'}</div>`).join(''); } 
            else { upcomingListEl.innerHTML = `<span style="color: #555; font-style: italic;">No more scheduled shots</span>`; }

            if (isLive) {
                if(!wasLivePreviously) triggerCutFlash();
                wasLivePreviously = true; body.className = 'live'; statusTextEl.innerText = "ON AIR"; progContainerEl.style.display = 'block';
                const timeLeft = Math.max(0, currentLiveShot.end - currentTime); mainTimerEl.innerText = timeLeft.toFixed(1);
                
                if (timeLeft <= 3.0 && timeLeft > 0.1) { mainTimerEl.classList.add('warning-end'); } 
                else { mainTimerEl.classList.remove('warning-end'); mainTimerEl.style.color = "white"; }

                const duration = currentLiveShot.end - currentLiveShot.start; let percentage = (timeLeft / duration) * 100; percentage = Math.max(0, Math.min(100, percentage)); progBarEl.style.width = percentage + "%"; progBarEl.style.background = "#ff3b30";
                shotNumberEl.innerText = `SHOT #${currentLiveShot.shotNumber || '?'}`; shotTotalEl.innerText = `/ ${totalShotsCount}`; shotMovementEl.innerText = currentLiveShot.movement || "Static 🛑"; shotMovementEl.style.display = "block";
                
                if(currentLiveShot.note) { shotNoteEl.style.display = "block"; shotNoteEl.innerText = currentLiveShot.note; } 
                else { shotNoteEl.style.display = "none"; }
                
                if (nextShot) { nextActionBox.style.display = 'flex'; nextActionDetails.innerText = `Shot #${nextShot.shotNumber || '?'} - ${nextShot.movement || "Static 🛑"}`; } 
                else { nextActionBox.style.display = 'none'; }
                metadataBox.classList.add('visible');

            } else if (nextShot) {
                wasLivePreviously = false; mainTimerEl.classList.remove('warning-end'); const timeLeft = nextShot.start - currentTime; progContainerEl.style.display = 'block'; nextActionBox.style.display = 'none';
                let countdownWindow = 15; let percentage = (timeLeft / countdownWindow) * 100; percentage = Math.max(0, Math.min(100, percentage)); progBarEl.style.width = percentage + "%";

                if (timeLeft <= 3.0) { const blink = Math.floor(currentTime * 4) % 2 === 0; body.className = blink ? 'preview preview-blink' : 'preview'; statusTextEl.innerText = "GET READY!"; progBarEl.style.background = "#ffcc00"; } 
                else { body.className = 'preview'; statusTextEl.innerText = "PREVIEW"; progBarEl.style.background = "#34c759"; }

                mainTimerEl.innerText = timeLeft.toFixed(1); mainTimerEl.style.color = "white";
                shotNumberEl.innerText = `NEXT: SHOT #${nextShot.shotNumber || '?'}`; shotTotalEl.innerText = `/ ${totalShotsCount}`; shotMovementEl.innerText = nextShot.movement || "Static 🛑"; shotMovementEl.style.display = "block";
                
                if(nextShot.note) { shotNoteEl.style.display = "block"; shotNoteEl.innerText = nextShot.note; } else { shotNoteEl.style.display = "none"; }
                metadataBox.classList.add('visible');
            } else { setStandby(); }
        });

        socket.on('status', (data) => { if (!data.msg.includes('LIVE') && !data.msg.includes('ARMED')) { isShowRunning = false; manualLiveScene = ""; previewScene = ""; setStandby(); masterTimecodeEl.innerText = "00:00.0"; }});
