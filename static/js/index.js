        const socket = io();
        let items = new vis.DataSet([]);
        let timeline;
        let allCompilations = {};
        let isPlaying = false;
        let isArmed = false; 
        let editingId = null; 
        let isUiLocked = false; 
        let isUpdatingNumbers = false; 
        let currentLiveTime = 0;
        let lastRecordedItemId = null;
        let availableScenes = [];

        let loopGroups = [];        // [{id, name, scenes, interval, random}]
        let activeLoopId = null;
        let loopActive = false;
        let loopArmed = false;
        let editingLoopGroupId = null;

        const HOTKEYS = ['1','2','3','4','5','6','7','8','9','0','q','w','e','r','t','y','u','i','o','p'];
        const palette = ["#ff9900", "#34c759", "#007aff", "#af52de", "#ff2d55", "#5856d6", "#e5c07b"];
        let sceneColors = {};

        const groups = new vis.DataSet([
            { id: 'webhooks', content: '🌐 WEBHOOKS', style: 'color: var(--webhook-color); font-weight: bold; font-size: 11px;' },
            { id: 'markers', content: '📝 LYRICS / CUES', style: 'color: var(--warning-color); font-weight: bold; font-size: 11px;' },
            { id: 'shots', content: '🎥 CAMERAS', style: 'color: var(--accent-color); font-weight: bold; font-size: 11px;' }
        ]);

        // --- INTERCOM: PCM realtime streaming (ScriptProcessorNode -> audio_stream) ---
        const PTT_CHUNK_SIZE = 2048;
        let micStream = null;
        let micAudioCtx = null;
        let micSourceNode = null;
        let micProcessorNode = null;
        let pttActive = false;
        const pttBtn = document.getElementById('btn-ptt');

        navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
            micStream = stream;
        }).catch(err => {
            console.warn("Microphone access denied or unavailable for Intercom.", err);
            if (pttBtn) {
                pttBtn.title = "Microphone unavailable";
                pttBtn.classList.add('disabled');
                pttBtn.disabled = true;
            }
        });

        function ensureMicGraph() {
            if (!micStream) return false;
            if (!micAudioCtx) micAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (micAudioCtx.state === 'suspended') micAudioCtx.resume();
            if (!micProcessorNode) {
                micSourceNode = micAudioCtx.createMediaStreamSource(micStream);
                micProcessorNode = micAudioCtx.createScriptProcessor(PTT_CHUNK_SIZE, 1, 1);
                micProcessorNode.onaudioprocess = (e) => {
                    if (!pttActive) return;
                    const chunk = new Float32Array(e.inputBuffer.getChannelData(0));
                    socket.emit('audio_stream', { audio: chunk.buffer, sampleRate: micAudioCtx.sampleRate });
                };
                // Route through a silent gain node: keeps the processing graph alive
                // without echoing the director's own mic back out of their speakers.
                const silentGain = micAudioCtx.createGain();
                silentGain.gain.value = 0;
                micSourceNode.connect(micProcessorNode);
                micProcessorNode.connect(silentGain);
                silentGain.connect(micAudioCtx.destination);
            }
            return true;
        }

        const startRecord = () => {
            if (!pttBtn || pttBtn.disabled) return;
            if (!ensureMicGraph()) return;
            pttActive = true;
            pttBtn.classList.add('active');
            pttBtn.innerHTML = "🎙️ REC...";
        };

        const stopRecord = () => {
            if (!pttBtn) return;
            pttActive = false;
            pttBtn.classList.remove('active');
            pttBtn.innerHTML = "🎙️ PTT (HOLD)";
        };

        if (pttBtn) {
            pttBtn.addEventListener('mousedown', startRecord);
            pttBtn.addEventListener('mouseup', stopRecord);
            pttBtn.addEventListener('mouseleave', stopRecord);
            pttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startRecord(); });
            pttBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopRecord(); });
        }

        const container = document.getElementById('timeline');
        const options = { 
            height: '100%',
            start: new Date(-2000),
            end: new Date(60000), 
            editable: {
                add: false,
                updateTime: true,
                updateGroup: false, /* FIX: prevents dragging an item vertically to another track */
                remove: true,
                overrideItems: false
            }, 
            format: { minorLabels: { millisecond:'SSS', second: 's', minute: 'm:ss' }, majorLabels: { second: 'm:ss' } }, 
            showCurrentTime: false, 
            margin: { item: { horizontal: 0, vertical: 4 }, axis: 4 },
            groupOrder: function (a, b) {
                const order = { 'webhooks': 1, 'markers': 2, 'shots': 3 };
                return order[a.id] - order[b.id];
            },
            // vis-timeline's built-in XSS sanitizer strips class/style attributes from
            // item content by default, which breaks our own card markup below (it isn't
            // filtering untrusted input - we escape user text ourselves in escapeHtml()).
            xss: { disabled: true }
        };
        timeline = new vis.Timeline(container, items, groups, options);
        try { timeline.addCustomTime(new Date(0), 'cursor'); } catch(e) {}

        function safeGetCursorTime() {
            try { return timeline.getCustomTime('cursor').getTime(); } 
            catch (e) { 
                try { timeline.addCustomTime(new Date(0), 'cursor'); } catch(ex) {}
                return 0; 
            }
        }

        function updateActiveRundownRow(timeSec) {
            let sorted = items.get({ order: function(a,b) { return (a.start || new Date(0)) - (b.start || new Date(0)); } });
            
            let activeItems = sorted.filter(c => {
                if (!c.start || !c.end) return false;
                return timeSec >= c.start.getTime()/1000 && timeSec < c.end.getTime()/1000;
            });
            
            document.querySelectorAll('#live-rundown-table tbody tr').forEach(tr => tr.classList.remove('active-row'));
            
            activeItems.forEach(activeItem => {
                const activeTr = document.getElementById(`row-${activeItem.id}`);
                if (activeTr) {
                    activeTr.classList.add('active-row');
                    if (isPlaying && activeItem.itemType !== 'marker' && activeItem.itemType !== 'webhook') { 
                        activeTr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    }
                }
            });
        }

        timeline.on('timechange', function (event) {
            if (event.id === 'cursor' && !isPlaying) {
                try { updateActiveRundownRow(event.time.getTime() / 1000); } catch(e) {}
            }
        });

        function toggleItemType() {
            const type = document.getElementById('item-type').value;
            document.getElementById('shot-fields').style.display = type === 'shot' ? 'flex' : 'none';
            document.getElementById('marker-fields').style.display = type === 'marker' ? 'flex' : 'none';
            document.getElementById('webhook-fields').style.display = type === 'webhook' ? 'flex' : 'none';
        }

        function updateShotNumbers() {
            if(isUpdatingNumbers) return;
            isUpdatingNumbers = true;
            let sorted = items.get({ order: function(a,b) { return (a.start || new Date(0)) - (b.start || new Date(0)); } });
            let toUpdate = [];
            let shotCounter = 1;
            sorted.forEach((item) => {
                if(item.itemType === 'shot' || !item.itemType) {
                    if(item.shotNumber !== shotCounter) {
                        item.shotNumber = shotCounter;
                        item.content = createDisplayContent(item.scene, item.note, item.transition, item.transition_duration, item.movement, shotCounter);
                        toUpdate.push(item);
                    }
                    shotCounter++;
                }
            });
            if(toUpdate.length > 0) items.update(toUpdate);
            isUpdatingNumbers = false;
            renderRundownTable(sorted);
        }

        items.on('add', updateShotNumbers); items.on('update', updateShotNumbers); items.on('remove', updateShotNumbers);
        items.on('add', saveDraftLocally); items.on('update', saveDraftLocally); items.on('remove', saveDraftLocally);

        function renderRundownTable(sortedItems) {
            const tbody = document.querySelector('#live-rundown-table tbody');
            if (sortedItems.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #555; font-style: italic; padding: 20px;">No shots added yet...</td></tr>`;
                return;
            }
            
            let html = "";
            sortedItems.forEach(item => {
                if(!item.start) return;
                const sec = item.start.getTime() / 1000;
                const m = Math.floor(sec / 60).toString().padStart(2, '0');
                const s = Math.floor(sec % 60).toString().padStart(2, '0');
                const ms = Math.floor((sec % 1) * 10).toString();
                
                if (item.itemType === 'marker') {
                    html += `<tr id="row-${item.id}" onclick="jumpToTime(${item.start.getTime()})" style="background: rgba(255,204,0,0.05);">
                        <td colspan="5" style="color: #ffcc00; font-weight: bold; text-align: center; letter-spacing: 1px;">🚩 LYRIC / CUE: ${item.text}</td>
                        <td class="col-time">${m}:${s}.${ms}</td>
                    </tr>`;
                } else if (item.itemType === 'webhook') {
                    const displayName = item.name ? `${item.name} [${item.method}]` : item.method;
                    html += `<tr id="row-${item.id}" onclick="jumpToTime(${item.start.getTime()})" style="background: rgba(175, 82, 222, 0.05);">
                        <td colspan="5" style="color: var(--webhook-color); font-weight: bold; text-align: center; letter-spacing: 1px;">🌐 WEBHOOK: ${displayName} - ${item.url}</td>
                        <td class="col-time">${m}:${s}.${ms}</td>
                    </tr>`;
                } else {
                    let transText = item.transition === "Cut" ? "-" : `${item.transition} (${item.transition_duration}ms)`;
                    let moveText = item.movement ? item.movement.replace(/[^\w\s]/gi, '') : "Static"; 
                    
                    html += `<tr id="row-${item.id}" onclick="jumpToTime(${item.start.getTime()})">
                        <td class="col-shot">#${item.shotNumber}</td>
                        <td class="col-time">${m}:${s}.${ms}</td>
                        <td><span class="scene-badge" style="background: ${item.color}">${item.scene}</span></td>
                        <td>${moveText}</td>
                        <td style="color: #888; font-size: 11px;">${transText}</td>
                        <td style="color: #ccc; font-style: italic;">${item.note || ''}</td>
                    </tr>`;
                }
            });
            tbody.innerHTML = html;
            
            const evalTime = isPlaying ? currentLiveTime : safeGetCursorTime() / 1000;
            updateActiveRundownRow(evalTime);
        }

        function jumpToTime(ms) {
            if (isPlaying) return; 
            try { timeline.setCustomTime(new Date(ms), 'cursor'); } 
            catch(e) { try { timeline.addCustomTime(new Date(ms), 'cursor'); } catch(ex) {} }
            timeline.moveTo(new Date(ms), {animation: true});
            updateActiveRundownRow(ms / 1000);
        }
        function jumpToHome() { jumpToTime(0); }
        function jumpToPrev() {
            if (isPlaying) return;
            const currentMs = safeGetCursorTime();
            let sorted = items.get({ order: function(a,b) { return (b.start || new Date(0)) - (a.start || new Date(0)); } }); 
            for (let item of sorted) {
                if (item.start && item.start.getTime() < currentMs - 100) { jumpToTime(item.start.getTime()); break; }
            }
        }
        function jumpToNext() {
            if (isPlaying) return;
            const currentMs = safeGetCursorTime();
            let sorted = items.get({ order: function(a,b) { return (a.start || new Date(0)) - (b.start || new Date(0)); } });
            for (let item of sorted) {
                if (item.start && item.start.getTime() > currentMs + 100) { jumpToTime(item.start.getTime()); break; }
            }
        }

        function printRundown() {
            let sorted = items.get({ order: function(a,b) { return (a.start || new Date(0)) - (b.start || new Date(0)); } });
            if (sorted.length === 0) return alert("The rundown is empty!");
            const projName = document.getElementById('comp-name').value || "Untitled Show";
            let html = `<div class="print-header"><h1>🎥 Mini-Pilot Rundown</h1><p><strong>Project:</strong> ${projName} &nbsp;&nbsp;|&nbsp;&nbsp; <strong>Total Shots:</strong> ${sorted.filter(i=>i.itemType==='shot' || !i.itemType).length}</p></div><table><thead><tr><th style="width: 50px;">Shot</th><th style="width: 80px;">Time</th><th style="width: 150px;">Camera / Scene</th><th style="width: 100px;">Movement</th><th>Script / Note</th></tr></thead><tbody>`;
            sorted.forEach((item) => {
                if(!item.start || item.itemType === 'project_settings') return;
                const sec = item.start.getTime() / 1000;
                const m = Math.floor(sec / 60).toString().padStart(2, '0');
                const s = Math.floor(sec % 60).toString().padStart(2, '0');
                if (item.itemType === 'shot' || !item.itemType) {
                    html += `<tr><td><strong>#${item.shotNumber}</strong></td><td>${m}:${s}</td><td><strong>${item.scene}</strong></td><td>${item.movement || 'Static'}</td><td>${item.note || ''}</td></tr>`;
                }
            });
            html += `</tbody></table>`;
            document.getElementById('print-area').innerHTML = html;
            window.print();
        }

        function exportCSV() {
            const name = document.getElementById('comp-name').value;
            if(!name) return alert("Enter a project name and save it first!");
            fetch('/api/compilations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, rundown: getRawData() }) })
            .then(() => { window.location.href = `/api/export_csv/${encodeURIComponent(name)}`; });
        }

        function toggleLock() {
            isUiLocked = !isUiLocked;
            const btn = document.getElementById('btn-lock');
            
            if (isUiLocked) { 
                timeline.setOptions({ editable: false });
                btn.innerHTML = "🔒 Locked"; 
                btn.classList.add('locked'); 
            } else { 
                /* FIX: restore the safe edit options when unlocking */
                timeline.setOptions({ 
                    editable: { updateTime: true, updateGroup: false, remove: true } 
                });
                btn.innerHTML = "🔓 Unlocked"; 
                btn.classList.remove('locked'); 
            }
        }

        function openSettings() { document.getElementById('settings-modal').style.display = 'flex'; socket.emit('req_obs_status'); }
        function closeSettings() { document.getElementById('settings-modal').style.display = 'none'; }
        function saveObsSettings() {
            const host = document.getElementById('cfg-obs-host').value;
            const port = document.getElementById('cfg-obs-port').value;
            const pwd = document.getElementById('cfg-obs-pwd').value;
            const webhookUrl = document.getElementById('cfg-webhook-url').value;
            document.getElementById('cfg-obs-status').innerText = "Status: Connecting...";
            socket.emit('save_obs_config', {host: host, port: port, password: pwd, webhook_url: webhookUrl});
        }

        socket.on('obs_status', (data) => {
            const modalStatus = document.getElementById('cfg-obs-status');
            const globalBadge = document.getElementById('obs-global-indicator');
            document.getElementById('cfg-obs-host').value = data.host || "localhost";
            document.getElementById('cfg-obs-port').value = data.port || 4455;
            document.getElementById('cfg-webhook-url').value = data.webhook_url || "";
            if(data.connected) {
                modalStatus.innerText = "Status: 🟢 Connected"; modalStatus.style.color = "var(--success-color)";
                globalBadge.innerText = "🟢 OBS Connected"; globalBadge.classList.add('connected');
                socket.emit('req_scenes_refresh'); 
            } else {
                modalStatus.innerText = "Status: 🔴 Disconnected (" + (data.error || "Check config") + ")";
                modalStatus.style.color = "var(--danger-color)";
                globalBadge.innerText = "🔴 OBS Offline"; globalBadge.classList.remove('connected');
            }
        });
        socket.emit('req_obs_status');

        timeline.on('select', function (properties) {
            if (properties.items.length > 0 && !isUiLocked) {
                const item = items.get(properties.items[0]);
                editingId = item.id;
                
                document.getElementById('item-type').value = item.itemType || 'shot';
                toggleItemType();
                document.getElementById('item-duration').value = item.end && item.start ? item.end.getTime() - item.start.getTime() : 5000;
                
                if (item.itemType === 'marker') {
                    document.getElementById('marker-text').value = item.text || "";
                } else if (item.itemType === 'webhook') {
                    document.getElementById('webhook-name').value = item.name || "";
                    document.getElementById('webhook-method').value = item.method || 'POST';
                    document.getElementById('webhook-url').value = item.url || "";
                    document.getElementById('webhook-payload').value = item.payload || "";
                } else {
                    document.getElementById('scene-select').value = item.scene;
                    document.getElementById('clip-note').value = item.note || "";
                    document.getElementById('transition-select').value = item.transition || "Cut";
                    document.getElementById('clip-movement').value = item.movement || "";
                    updateTransitionUI();
                    document.getElementById('transition-duration').value = item.transition_duration || 300;
                }
                const btn = document.getElementById('btn-add-update');
                btn.innerText = "✓ Update"; btn.style.background = "var(--warning-color)"; btn.style.color = "#000";
            } else if (!isUiLocked) { resetForm(); }
        });

        function resetForm() {
            editingId = null; 
            /* FIX: does NOT reset the track type, to speed up rapid entry */
            document.getElementById('item-duration').value = 5000;
            document.getElementById('clip-note').value = ""; document.getElementById('clip-movement').value = "";
            document.getElementById('marker-text').value = "";
            document.getElementById('webhook-name').value = "";
            document.getElementById('webhook-method').value = "POST"; document.getElementById('webhook-url').value = ""; document.getElementById('webhook-payload').value = "";
            document.getElementById('transition-select').value = "Cut"; updateTransitionUI();
            document.getElementById('transition-duration').value = 300;
            const btn = document.getElementById('btn-add-update');
            btn.innerText = "+ Add Item"; btn.style.background = "var(--accent-color)"; btn.style.color = "#fff";
            timeline.setSelection([]);
        }

        function clearTimeline() {
            if(isUiLocked) return alert("Timeline is Locked! Unlock it first.");
            if(confirm("Are you sure you want to clear the entire timeline?")) { items.clear(); lastRecordedItemId = null; }
        }

        function updateTransitionUI() {
            const trans = document.getElementById('transition-select').value.toLowerCase();
            const durContainer = document.getElementById('duration-container');
            durContainer.style.display = (trans === 'cut' || trans === 'taglio') ? 'none' : 'block';
        }
        document.getElementById('transition-select').addEventListener('change', updateTransitionUI);

        document.getElementById('live-mode-select').addEventListener('change', function(e) {
            if (isPlaying) socket.emit('change_mode', { mode: e.target.value });
        });
        document.getElementById('live-mode-select').addEventListener('change', saveDraftLocally);
        document.getElementById('comp-name').addEventListener('input', saveDraftLocally);
        document.getElementById('obs-audio-source').addEventListener('input', saveDraftLocally);
        document.getElementById('obs-auto-record').addEventListener('change', saveDraftLocally);

        socket.on('scenes_list', (scenes) => {
            availableScenes = scenes;
            scenes.forEach((s, i) => sceneColors[s] = palette[i % palette.length]);
            document.getElementById('scene-select').innerHTML = scenes.map(s => `<option value="${s}">${s}</option>`).join('');
            renderSwitcherRows();
        });

        function loopButtonsHtml(rowType) {
            return loopGroups.map(g => {
                const isActive = g.id === activeLoopId;
                const cls = `switcher-btn switcher-btn-loop${isActive && loopActive ? ' loop-pulsing' : ''}${isActive && loopArmed ? ' loop-armed' : ''}`;
                const fn = rowType === 'prv' ? `armLoopPreview('${g.id}')` : `startLoopCycle('${g.id}')`;
                const idPrefix = rowType === 'prv' ? 'loop-btn-prv' : 'loop-btn-cut';
                const badge = isActive ? `<span class="loop-remaining-badge" style="display:none;"></span>` : '';
                return `<button class="${cls}" id="${idPrefix}-${g.id}" onclick="${fn}" title="${escapeHtml(g.name)} — Loop Group"><span class="key-badge">🔁</span><span>${escapeHtml(g.name)}</span>${badge}</button>`;
            }).join('');
        }

        function renderSwitcherRows() {
            const prvRow = document.getElementById('switcher-prv-row');
            const cutRow = document.getElementById('switcher-cut-row');
            prvRow.innerHTML = availableScenes.map((s, i) => {
                let keyName = i < HOTKEYS.length ? HOTKEYS[i].toUpperCase() : '-';
                return `<button class="switcher-btn" id="prv-btn-${i}" onclick="sendPreview(${i})" title="${s} — Shift+${keyName}: send to preview"><span class="key-badge">${keyName}</span><span>${s}</span></button>`;
            }).join('') + loopButtonsHtml('prv');
            cutRow.innerHTML = availableScenes.map((s, i) => {
                let keyName = i < HOTKEYS.length ? HOTKEYS[i].toUpperCase() : '-';
                return `<button class="switcher-btn" id="cut-btn-${i}" onclick="executeLiveCut(${i})" title="${s} — ${keyName}: direct cut"><span class="key-badge">${keyName}</span><span>${s}</span></button>`;
            }).join('') + loopButtonsHtml('cut');
        }

        socket.on('transitions_list', (transitions) => {
            if (transitions.length > 0) {
                document.getElementById('transition-select').innerHTML = transitions.map(t => `<option value="${t}">${t}</option>`).join('');
                updateTransitionUI();
            }
        });

        function refreshCompilationsList() {
            fetch('/api/compilations').then(r => r.json()).then(data => {
                allCompilations = data;
                const select = document.getElementById('comp-select');
                select.innerHTML = '<option value="">-- Load Existing Project --</option>' + Object.keys(data).map(name => `<option value="${name}">${name}</option>`).join('');
            });
        }
        refreshCompilationsList();
        restoreDraftLocally();
        socket.emit('req_director_sync');

        // --- RESIZABLE PANELS (drag the dividers; sizes persist across sessions) ---
        function sizeOf(el, axis) {
            const rect = el.getBoundingClientRect();
            return axis === 'x' ? rect.width : rect.height;
        }
        function setSize(el, axis, size) {
            // border-box so the px value we set matches what getBoundingClientRect()
            // reports back (padding/border would otherwise make the two drift apart).
            el.style.boxSizing = 'border-box';
            el.style.flex = `0 0 ${size}px`;
            if (axis === 'x') el.style.width = size + 'px';
            else el.style.height = size + 'px';
        }

        // Single-sided resize: only targetEl is pinned to a size, its flexible
        // sibling (e.g. col-right) absorbs the rest on its own via flex:1.
        function makeResizable(handleId, targetEl, axis, storageKey, min, max) {
            const handle = document.getElementById(handleId);
            if (!handle || !targetEl) return;

            const saved = parseInt(localStorage.getItem(storageKey));
            if (!isNaN(saved)) setSize(targetEl, axis, Math.max(min, Math.min(max, saved)));

            let dragging = false, startPos = 0, startSize = 0;
            handle.addEventListener('mousedown', (e) => {
                dragging = true;
                handle.classList.add('dragging');
                startPos = axis === 'x' ? e.clientX : e.clientY;
                startSize = sizeOf(targetEl, axis);
                document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
                document.body.style.userSelect = 'none';
                e.preventDefault();
            });
            window.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                const pos = axis === 'x' ? e.clientX : e.clientY;
                setSize(targetEl, axis, Math.max(min, Math.min(max, startSize + (pos - startPos))));
            });
            window.addEventListener('mouseup', () => {
                if (!dragging) return;
                dragging = false;
                handle.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                localStorage.setItem(storageKey, Math.round(sizeOf(targetEl, axis)));
            });
        }

        // Two-sided splitter: dragging transfers space directly between the two
        // neighboring panels (like VSCode/NLE panel splitters), rather than
        // affecting some unrelated third panel elsewhere on the page.
        function makeSplitter(handleId, prevEl, nextEl, axis, prevKey, nextKey, minPrev, maxPrev, minNext, maxNext) {
            const handle = document.getElementById(handleId);
            if (!handle || !prevEl || !nextEl) return;

            const savedPrev = parseInt(localStorage.getItem(prevKey));
            const savedNext = parseInt(localStorage.getItem(nextKey));
            if (!isNaN(savedPrev)) setSize(prevEl, axis, Math.max(minPrev, Math.min(maxPrev, savedPrev)));
            if (!isNaN(savedNext)) setSize(nextEl, axis, Math.max(minNext, Math.min(maxNext, savedNext)));

            let dragging = false, startPos = 0, startPrevSize = 0, startNextSize = 0;
            handle.addEventListener('mousedown', (e) => {
                dragging = true;
                handle.classList.add('dragging');
                startPos = axis === 'x' ? e.clientX : e.clientY;
                startPrevSize = sizeOf(prevEl, axis);
                startNextSize = sizeOf(nextEl, axis);
                document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
                document.body.style.userSelect = 'none';
                e.preventDefault();
            });
            window.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                const pos = axis === 'x' ? e.clientX : e.clientY;
                const delta = pos - startPos;
                const newPrev = Math.max(minPrev, Math.min(maxPrev, startPrevSize + delta));
                const appliedDelta = newPrev - startPrevSize;
                const newNext = Math.max(minNext, Math.min(maxNext, startNextSize - appliedDelta));
                setSize(prevEl, axis, newPrev);
                setSize(nextEl, axis, newNext);
            });
            window.addEventListener('mouseup', () => {
                if (!dragging) return;
                dragging = false;
                handle.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                localStorage.setItem(prevKey, Math.round(sizeOf(prevEl, axis)));
                localStorage.setItem(nextKey, Math.round(sizeOf(nextEl, axis)));
            });
        }

        makeResizable('handle-columns', document.querySelector('.col-left'), 'x', 'minipilot_size_colleft', 240, 800);
        makeSplitter('handle-upper-strip', document.querySelector('.workspace-upper'), document.querySelector('.live-control-strip'), 'y',
            'minipilot_size_upper', 'minipilot_size_strip', 80, 700, 150, 600);
        makeSplitter('handle-strip-bottom', document.querySelector('.live-control-strip'), document.querySelector('.workspace-bottom'), 'y',
            'minipilot_size_strip', 'minipilot_size_bottom', 150, 600, 80, 600);

        const MANUAL_VIEW_KEY = 'minipilot_manual_view';
        function applyManualView(active) {
            document.body.classList.toggle('manual-view-active', active);
            const btn = document.getElementById('btn-manual-view');
            if (btn) btn.classList.toggle('view-active', active);
        }
        function toggleManualView() {
            const active = !document.body.classList.contains('manual-view-active');
            applyManualView(active);
            localStorage.setItem(MANUAL_VIEW_KEY, active ? '1' : '0');
        }
        applyManualView(localStorage.getItem(MANUAL_VIEW_KEY) === '1');

        function escapeHtml(str) {
            return String(str ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        }

        function createDisplayContent(scene, note, trans, dur, movement, shotNum) {
            let moveIcon = "";
            if(movement === "Pan") moveIcon = "↔️"; else if(movement === "Tilt") moveIcon = "↕️";
            else if(movement === "Zoom In") moveIcon = "🔍"; else if(movement === "Zoom Out") moveIcon = "🔎"; else if(movement === "Tracking") moveIcon = "🎥";

            const hasTrans = trans && trans.toLowerCase() !== "cut" && trans.toLowerCase() !== "taglio";

            let html = `<div class="shot-card">`;
            html += `<div class="shot-card-accent"></div>`;
            html += `<div class="shot-card-body">`;
            html += `<div class="shot-card-top">`;
            html += `<span class="shot-card-num">#${shotNum || '?'}</span>`;
            html += `<span class="shot-card-scene">${escapeHtml(scene)}</span>`;
            if (moveIcon) html += `<span class="shot-card-move" title="${escapeHtml(movement)}">${moveIcon}</span>`;
            html += `</div>`;
            if (note) html += `<div class="shot-card-note">📝 ${escapeHtml(note)}</div>`;
            html += `</div>`;
            if (hasTrans) html += `<div class="shot-card-trans">⧉ ${escapeHtml(trans)} ${escapeHtml(dur)}ms</div>`;
            html += `</div>`;
            return html;
        }

        function addOrUpdateClip() {
            if(isUiLocked) return alert("Timeline is Locked! Unlock it first.");
            
            const type = document.getElementById('item-type').value;
            const durationMs = parseInt(document.getElementById('item-duration').value) || 5000;
            
            let clipData = { itemType: type, shotNumber: 0 };
            
            if (type === 'shot') {
                const sceneName = document.getElementById('scene-select').value;
                const note = document.getElementById('clip-note').value;
                const trans = document.getElementById('transition-select').value;
                const transDur = document.getElementById('transition-duration').value;
                const movement = document.getElementById('clip-movement').value;
                const color = sceneColors[sceneName] || "#555";
                
                clipData.group = 'shots';
                clipData.scene = sceneName; clipData.note = note; clipData.transition = trans;
                clipData.transition_duration = transDur; clipData.movement = movement; clipData.color = color;
                clipData.content = createDisplayContent(sceneName, note, trans, transDur, movement, "?");
                clipData.style = `--clip-color: ${color};`;
            } else if (type === 'marker') {
                const text = document.getElementById('marker-text').value;
                clipData.group = 'markers';
                clipData.text = text;
                clipData.content = `<div class="marker-card"><span class="marker-card-text">🚩 ${escapeHtml(text)}</span></div>`;
            } else if (type === 'webhook') {
                const name = document.getElementById('webhook-name').value;
                const method = document.getElementById('webhook-method').value;
                const url = document.getElementById('webhook-url').value;
                const payload = document.getElementById('webhook-payload').value;
                
                clipData.group = 'webhooks';
                clipData.name = name;
                clipData.method = method;
                clipData.url = url;
                clipData.payload = payload;
                const displayName = name || method;
                clipData.content = `<div class="webhook-card"><span class="webhook-card-text">🌐 ${escapeHtml(displayName)}</span></div>`;
            }

            if (editingId) { 
                clipData.id = editingId; 
                let oldItem = items.get(editingId);
                clipData.start = oldItem.start; clipData.end = oldItem.end;
                items.update(clipData); 
            } else {
                clipData.id = Date.now();
                const currentMs = safeGetCursorTime();
                clipData.start = new Date(currentMs); 
                clipData.end = new Date(currentMs + durationMs); 
                items.add(clipData);
                jumpToTime(currentMs + durationMs);
            }
            resetForm(); 
        }

        function logLiveRecordClip(sceneName, trans, transDur) {
            if (isUiLocked) return;
            const color = sceneColors[sceneName] || "#555";
            const displayContent = createDisplayContent(sceneName, "⏺️ Live Rec", trans, transDur, "", "?");
            const startMs = currentLiveTime * 1000;
            const newItemId = Date.now();

            if (lastRecordedItemId && items.get(lastRecordedItemId)) items.update({ id: lastRecordedItemId, end: new Date(startMs) });

            items.add({
                id: newItemId, group: 'shots', itemType: 'shot', content: displayContent, scene: sceneName, note: "Live Cut", transition: trans, transition_duration: transDur, movement: "", shotNumber: 0, color: color, style: `--clip-color: ${color};`, start: new Date(startMs), end: new Date(startMs + 10000)
            });
            lastRecordedItemId = newItemId;
        }

        // Taking manual control (PRV/CUT/TAKE) while the show is driving itself in Auto
        // would otherwise silently do nothing and fight the automation - so it instead
        // hands control to the director by switching the show into Manual mode first.
        // If nothing is live yet, PRV/CUT/TAKE would otherwise be a silent no-op -
        // instead, jump straight into a Manual-mode show so they always do something.
        function ensureManualMode() {
            if (!isPlaying) {
                document.getElementById('live-mode-select').value = 'override';
                return startShow('override') ? 'override' : null;
            }
            const select = document.getElementById('live-mode-select');
            if (select.value === 'playback') {
                select.value = 'override';
                socket.emit('change_mode', { mode: 'override' });
                saveDraftLocally();
            }
            return select.value;
        }

        function executeLiveCut(sceneIndex) {
            if (sceneIndex < 0 || sceneIndex >= availableScenes.length) return;
            const mode = ensureManualMode();
            if (!mode) return;

            const sceneName = availableScenes[sceneIndex];
            const trans = document.getElementById('transition-select').value || "Cut";
            const transDur = document.getElementById('transition-duration').value || 300;

            socket.emit('live_action', { scene: sceneName, transition: trans, transition_duration: transDur });

            if (mode === 'record') logLiveRecordClip(sceneName, trans, transDur);
        }

        function sendPreview(sceneIndex) {
            if (sceneIndex < 0 || sceneIndex >= availableScenes.length) return;
            const mode = ensureManualMode();
            if (!mode) return;

            socket.emit('set_preview_scene', { scene: availableScenes[sceneIndex] });
        }

        function takeLive() {
            if (!isPlaying) return;
            if (!currentPreviewSceneSync) return;
            const mode = ensureManualMode();
            if (!mode) return;

            const sceneName = currentPreviewSceneSync;
            const trans = document.getElementById('transition-select').value || "Cut";
            const transDur = document.getElementById('transition-duration').value || 300;

            socket.emit('take_live', { transition: trans, transition_duration: transDur });

            if (mode === 'record') logLiveRecordClip(sceneName, trans, transDur);
        }

        function armLoopPreview(groupId) {
            const mode = ensureManualMode();
            if (!mode) return;
            socket.emit('loop_arm_preview', { group_id: groupId });
        }

        function startLoopCycle(groupId) {
            const mode = ensureManualMode();
            if (!mode) return;
            socket.emit('loop_start_cycle', { group_id: groupId });
        }

        function openLoopConfig() {
            renderLoopGroupsList();
            document.getElementById('loop-group-editor').style.display = 'none';
            document.getElementById('loop-config-modal').style.display = 'flex';
        }
        function closeLoopConfig() {
            document.getElementById('loop-config-modal').style.display = 'none';
        }
        function renderLoopGroupsList() {
            document.getElementById('loop-groups-list').innerHTML = loopGroups.map(g => `
                <div class="loop-group-row">
                    <span>🔁 ${escapeHtml(g.name)} — ${g.scenes.length} scenes, ${g.interval}s${g.random ? ' 🔀' : ''}</span>
                    <span>
                        <button class="btn-secondary" onclick="editLoopGroup('${g.id}')">Edit</button>
                        <button class="btn-secondary" onclick="deleteLoopGroup('${g.id}')">Delete</button>
                    </span>
                </div>`).join('') || `<span style="color:#666; font-style: italic;">No loop groups yet.</span>`;
        }
        function newLoopGroup() {
            editingLoopGroupId = null;
            document.getElementById('loop-group-name-input').value = '';
            document.getElementById('loop-group-interval-input').value = 10;
            document.getElementById('loop-group-random-input').checked = false;
            document.getElementById('loop-group-scenes').innerHTML = availableScenes.map(s =>
                `<label class="loop-config-scene-item"><input type="checkbox" value="${escapeHtml(s)}"> ${escapeHtml(s)}</label>`).join('');
            document.getElementById('loop-group-editor').style.display = 'block';
        }
        function editLoopGroup(id) {
            const g = loopGroups.find(x => x.id === id);
            if (!g) return;
            editingLoopGroupId = id;
            document.getElementById('loop-group-name-input').value = g.name;
            document.getElementById('loop-group-interval-input').value = g.interval;
            document.getElementById('loop-group-random-input').checked = g.random;
            document.getElementById('loop-group-scenes').innerHTML = availableScenes.map(s =>
                `<label class="loop-config-scene-item"><input type="checkbox" value="${escapeHtml(s)}" ${g.scenes.includes(s) ? 'checked' : ''}> ${escapeHtml(s)}</label>`).join('');
            document.getElementById('loop-group-editor').style.display = 'block';
        }
        function deleteLoopGroup(id) {
            loopGroups = loopGroups.filter(g => g.id !== id);
            socket.emit('loop_configure_groups', { groups: loopGroups });
            renderLoopGroupsList();
        }
        function saveLoopGroupEditor() {
            const name = document.getElementById('loop-group-name-input').value.trim() || 'Loop';
            const scenes = Array.from(document.querySelectorAll('#loop-group-scenes input:checked')).map(cb => cb.value);
            const interval = parseFloat(document.getElementById('loop-group-interval-input').value) || 10;
            const random = document.getElementById('loop-group-random-input').checked;
            if (scenes.length === 0) return;
            const id = editingLoopGroupId || ('loop_' + Date.now());
            const next = loopGroups.filter(g => g.id !== id);
            next.push({ id, name, scenes, interval, random });
            loopGroups = next;
            socket.emit('loop_configure_groups', { groups: loopGroups });
            document.getElementById('loop-group-editor').style.display = 'none';
            renderLoopGroupsList();
        }
        socket.on('loop_groups_updated', (data) => {
            loopGroups = data.loop_groups || [];
            activeLoopId = data.active_loop_id;
            loopActive = !!data.loop_active;
            loopArmed = !!data.loop_armed;
            renderSwitcherRows();
            if (document.getElementById('loop-config-modal').style.display === 'flex') renderLoopGroupsList();
        });

        // Physical key codes (keyboard-layout independent): plain key = CUT, Shift+key = PRV
        const HOTKEY_CODES = ['Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9','Digit0','KeyQ','KeyW','KeyE','KeyR','KeyT','KeyY','KeyU','KeyI','KeyO','KeyP'];

        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

            if (e.code === 'Space' && isArmed) { e.preventDefault(); fireShow(); return; }

            // Scene hotkeys work even before a show is live - they'll quick-start one in
            // Manual mode - so they're checked before the isPlaying-only shortcuts below.
            const sceneIndex = HOTKEY_CODES.indexOf(e.code);
            if (sceneIndex !== -1) {
                e.preventDefault();
                if (e.shiftKey) sendPreview(sceneIndex);
                else executeLiveCut(sceneIndex);
                return;
            }

            if (!isPlaying) return;
            if (e.code === 'ArrowLeft') { e.preventDefault(); nudgeTime(-0.1); return; }
            if (e.code === 'ArrowRight') { e.preventDefault(); nudgeTime(0.1); return; }
            if (e.code === 'KeyH') { e.preventDefault(); toggleHold(); return; }
            if (e.code === 'Enter') { e.preventDefault(); takeLive(); return; }
        });

        function sendUrgentMessage() {
            const input = document.getElementById('urgent-msg');
            if(!input.value.trim()) return;
            socket.emit('send_urgent_message', { msg: input.value.trim() });
            input.value = "";
        }

        function getRawData() { 
            let sortedItems = items.get({ order: function(a,b) { return (a.start || new Date(0)) - (b.start || new Date(0)); } });
            let exportedData = sortedItems.map(item => {
                const startTime = item.start ? item.start.getTime() / 1000 : 0;
                const endTime = item.end ? item.end.getTime() / 1000 : startTime + 5;
                return {
                    itemType: item.itemType || 'shot',
                    type: item.itemType || 'shot',
                    text: item.text || "",
                    scene: item.scene || "",
                    note: item.note || "",
                    transition: item.transition || "Cut",
                    transition_duration: item.transition_duration || 300,
                    movement: item.movement || "",
                    color: item.color || "#007aff",
                    shotNumber: item.shotNumber || 0,
                    name: item.name || "",
                    method: item.method || "POST",
                    url: item.url || "",
                    payload: item.payload || "",
                    start: startTime,
                    end: endTime
                };
            }); 
            
            exportedData.push({
                itemType: 'project_settings',
                type: 'project_settings',
                auto_record: document.getElementById('obs-auto-record').checked,
                start: -1,
                end: -1
            });
            
            return exportedData;
        }

        function saveCompilation() { const name = document.getElementById('comp-name').value; if(!name) return alert("Enter a project name!"); fetch('/api/compilations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, rundown: getRawData() }) }).then(() => { alert('Project Saved!'); refreshCompilationsList(); }); }
        
        function applyProjectDataToTimeline(projectData) {
            items.clear();

            const settingsItem = projectData.find(i => i.itemType === 'project_settings' || i.type === 'project_settings');
            if(settingsItem) {
                document.getElementById('obs-auto-record').checked = settingsItem.auto_record === true;
            } else {
                document.getElementById('obs-auto-record').checked = false;
            }

            const timelineData = projectData.filter(i => i.itemType !== 'project_settings' && i.type !== 'project_settings').map((item, i) => {
                const itemType = item.itemType || item.type || 'shot';
                if (itemType === 'marker') {
                    return {
                        id: i, group: 'markers', itemType: 'marker', text: item.text,
                        content: `<div class="marker-card"><span class="marker-card-text">🚩 ${escapeHtml(item.text)}</span></div>`,
                        start: new Date(item.start * 1000), end: new Date(item.end * 1000)
                    };
                } else if (itemType === 'webhook') {
                    const displayName = item.name || item.method;
                    return {
                        id: i, group: 'webhooks', itemType: 'webhook', name: item.name, method: item.method, url: item.url, payload: item.payload,
                        content: `<div class="webhook-card"><span class="webhook-card-text">🌐 ${escapeHtml(displayName)}</span></div>`,
                        start: new Date(item.start * 1000), end: new Date(item.end * 1000)
                    };
                } else {
                    const color = item.color || sceneColors[item.scene] || "#007aff";
                    const displayContent = createDisplayContent(item.scene, item.note, item.transition, item.transition_duration, item.movement, i+1);
                    return { id: i, group: 'shots', itemType: 'shot', content: displayContent, scene: item.scene, note: item.note, transition: item.transition, transition_duration: item.transition_duration, movement: item.movement, shotNumber: i+1, color: color, style: `--clip-color: ${color};`, start: new Date(item.start * 1000), end: new Date(item.end * 1000) };
                }
            });
            items.add(timelineData);
        }

        function loadCompilation() {
            if(isUiLocked) return alert("Timeline is Locked! Unlock it before loading.");
            const name = document.getElementById('comp-select').value;
            if(!name || !allCompilations[name]) return;
            document.getElementById('comp-name').value = name;
            applyProjectDataToTimeline(allCompilations[name]);
            resetForm();
        }

        // --- LOCAL DRAFT AUTOSAVE (survives an F5 refresh while the show isn't live) ---
        const DRAFT_KEY = 'minipilot_draft_v1';
        function saveDraftLocally() {
            if (isPlaying) return; // while live the timeline reflects the live log/rundown, not the draft
            try {
                localStorage.setItem(DRAFT_KEY, JSON.stringify({
                    compName: document.getElementById('comp-name').value,
                    rundown: getRawData(),
                    audioSource: document.getElementById('obs-audio-source').value,
                    mode: document.getElementById('live-mode-select').value
                }));
            } catch(e) {}
        }

        function restoreDraftLocally() {
            try {
                const raw = localStorage.getItem(DRAFT_KEY);
                if (!raw) return;
                const draft = JSON.parse(raw);
                if (!draft || !Array.isArray(draft.rundown) || draft.rundown.length === 0) return;
                document.getElementById('comp-name').value = draft.compName || "";
                document.getElementById('obs-audio-source').value = draft.audioSource || "";
                if (draft.mode) document.getElementById('live-mode-select').value = draft.mode;
                applyProjectDataToTimeline(draft.rundown);
                resetForm();
            } catch(e) {}
        }

        function resetLiveUI() {
            isPlaying = false; isArmed = false;
            document.getElementById('btn-arm-show').style.display = 'flex';
            document.getElementById('btn-fire-show').style.display = 'none';
            document.getElementById('btn-fire-show').classList.remove('pulsing-live');
            const display = document.getElementById('master-status-display');
            if (display) display.classList.remove('active-live', 'active-armed');
            document.getElementById('status-bar').innerText = "00:00.0";
            document.getElementById('status-bar').style.color = "var(--warning-color)";
            lastRecordedItemId = null;
            document.getElementById('btn-hold').classList.remove('active');
            document.getElementById('btn-hold').innerHTML = "⏸ HOLD (H)";
            document.querySelectorAll('.switcher-btn').forEach(b => b.classList.remove('active'));
            manualLiveSceneSync = ""; currentPreviewSceneSync = "";
            document.getElementById('btn-take').disabled = true;

            loopActive = false; loopArmed = false; activeLoopId = null;
            document.querySelectorAll('.switcher-btn-loop').forEach(b => b.classList.remove('loop-pulsing', 'loop-armed'));
        }

        socket.on('status', (data) => { if (!data.msg.includes('LIVE') && !data.msg.includes('ARMED')) resetLiveUI(); });

        let manualLiveSceneSync = "";
        let currentPreviewSceneSync = "";
        socket.on('live_cut', (data) => { manualLiveSceneSync = data.scene; });
        socket.on('preview_changed', (data) => {
            currentPreviewSceneSync = data.scene;
            loopArmed = !!data.loop_armed;
            if (data.active_loop_id !== undefined) activeLoopId = data.active_loop_id;
            document.getElementById('btn-take').disabled = !currentPreviewSceneSync;
            renderSwitcherRows();
        });

        socket.on('director_sync', (data) => {
            manualLiveSceneSync = data.live_scene || "";
            currentPreviewSceneSync = data.preview_scene || "";
            if (data.mode) document.getElementById('live-mode-select').value = data.mode;

            loopGroups = data.loop_groups || [];
            activeLoopId = data.active_loop_id;
            loopActive = !!data.loop_active;
            loopArmed = !!data.loop_armed;
            renderSwitcherRows();

            if (data.is_playing) {
                isPlaying = true; isArmed = false;
                isUiLocked = true;
                timeline.setOptions({ editable: false });
                document.getElementById('btn-lock').innerHTML = "🔒 Locked";
                document.getElementById('btn-lock').classList.add('locked');
                applyProjectDataToTimeline(data.rundown || []);

                document.getElementById('btn-arm-show').style.display = 'none';
                const btnFire = document.getElementById('btn-fire-show');
                btnFire.style.display = 'flex'; btnFire.innerHTML = "🔴 ON AIR"; btnFire.classList.add('pulsing-live');
                const display = document.getElementById('master-status-display');
                if (display) { display.classList.remove('active-armed'); display.classList.add('active-live'); }

                currentLiveTime = data.elapsed || 0;
                if (data.is_paused) {
                    document.getElementById('btn-hold').classList.add('active');
                    document.getElementById('btn-hold').innerHTML = "▶ RESUME";
                    document.getElementById('status-bar').style.color = "#ff9900";
                } else {
                    document.getElementById('status-bar').style.color = "#ff3b30";
                }
            }
            document.getElementById('btn-take').disabled = !currentPreviewSceneSync;
        });

        socket.on('timecode', (data) => {
            currentLiveTime = data.time; const currentMs = data.time * 1000;
            const m = Math.floor(data.time / 60).toString().padStart(2, '0');
            const s = Math.floor(data.time % 60).toString().padStart(2, '0');
            const ms = Math.floor((data.time % 1) * 10).toString();
            document.getElementById('status-bar').innerText = `${m}:${s}.${ms}`;

            const loopCycling = data.loop_remaining !== undefined && data.loop_remaining !== null;
            loopActive = loopCycling;
            document.querySelectorAll('.switcher-btn-loop').forEach(b => {
                const isActiveGroupBtn = activeLoopId && b.id.endsWith(`-${activeLoopId}`);
                b.classList.toggle('loop-pulsing', loopCycling && isActiveGroupBtn);
                const badge = b.querySelector('.loop-remaining-badge');
                if (badge) {
                    badge.style.display = loopCycling && isActiveGroupBtn ? 'block' : 'none';
                    if (loopCycling && isActiveGroupBtn) badge.innerText = Math.ceil(data.loop_remaining) + 's';
                }
            });

            try { timeline.setCustomTime(new Date(currentMs), 'cursor'); } catch(e) {}
            
            updateActiveRundownRow(currentLiveTime);

            if (isPlaying) {
                const range = timeline.getWindow(); const windowWidth = range.end.valueOf() - range.start.valueOf();
                if (currentMs > range.start.valueOf() + (windowWidth * 0.8)) timeline.setWindow(range.start.valueOf() + (windowWidth * 0.5), range.end.valueOf() + (windowWidth * 0.5), {animation: true});
                
                let sorted = items.get({ order: function(a,b) { return (a.start||new Date(0)) - (b.start||new Date(0)); } });
                let currentGlobalClip = sorted.find(c => {
                    if (c.itemType === 'marker' || c.itemType === 'webhook' || !c.start || !c.end) return false;
                    return currentLiveTime >= c.start.getTime() / 1000 && currentLiveTime < c.end.getTime() / 1000;
                });
                let nextGlobalClip = sorted.find(c => {
                    if (c.itemType === 'marker' || c.itemType === 'webhook' || !c.start) return false;
                    return currentLiveTime < c.start.getTime() / 1000;
                });
                const mode = document.getElementById('live-mode-select').value;
                document.getElementById('btn-take').disabled = !(mode !== 'playback' && currentPreviewSceneSync);

                availableScenes.forEach((scene, i) => {
                    const prvBtn = document.getElementById(`prv-btn-${i}`);
                    const cutBtn = document.getElementById(`cut-btn-${i}`);
                    if (prvBtn) prvBtn.classList.remove('active');
                    if (cutBtn) cutBtn.classList.remove('active');
                    if (mode === 'override' || mode === 'record') {
                        if (manualLiveSceneSync === scene && cutBtn) cutBtn.classList.add('active');
                        if (currentPreviewSceneSync === scene && prvBtn) prvBtn.classList.add('active');
                    } else {
                        if (currentGlobalClip && currentGlobalClip.scene === scene && cutBtn) cutBtn.classList.add('active');
                        else if (nextGlobalClip && nextGlobalClip.scene === scene && prvBtn) prvBtn.classList.add('active');
                    }
                });
            }
        });

        function armShow() {
            if(!isUiLocked) toggleLock();
            isArmed = true;
            document.getElementById('btn-arm-show').style.display = 'none';
            document.getElementById('btn-fire-show').style.display = 'flex';
            const display = document.getElementById('master-status-display');
            if(display) display.classList.add('active-armed');
            document.getElementById('status-bar').innerText = "ARMED...";
            document.getElementById('status-bar').style.color = "#ff9900";
            
            try { timeline.setCustomTime(new Date(0), 'cursor'); } catch(e) {}
            timeline.setWindow(-2000, 60000, {animation: true});
        }

        // Shared by the normal ARM+GO flow and the PRV/CUT quick-start path below.
        function startShow(mode) {
            try {
                if (!isUiLocked) toggleLock();
                const rundownData = getRawData();
                isArmed = false; isPlaying = true;
                document.getElementById('btn-arm-show').style.display = 'none';
                const btnFire = document.getElementById('btn-fire-show');
                btnFire.style.display = 'flex'; btnFire.innerHTML = "🔴 ON AIR"; btnFire.classList.add('pulsing-live');
                const display = document.getElementById('master-status-display');
                if(display) { display.classList.remove('active-armed'); display.classList.add('active-live'); }
                document.getElementById('status-bar').style.color = "#ff3b30";
                const audioSource = document.getElementById('obs-audio-source').value;
                const autoRecord = document.getElementById('obs-auto-record').checked;

                socket.emit('start_show', { rundown: rundownData, mode: mode, obs_audio_source: audioSource, auto_record: autoRecord });
                resetForm();
                lastRecordedItemId = null;
                return true;
            } catch (error) {
                console.error(error);
                alert("Internal error while reading the timeline. Please check your data.");
                resetLiveUI();
                return false;
            }
        }

        function fireShow() {
            if (!isArmed) return;
            startShow(document.getElementById('live-mode-select').value);
        }
        
        function stopShow() { 
            socket.emit('stop_show'); 
            resetLiveUI(); 
            try { timeline.setCustomTime(new Date(0), 'cursor'); } catch(e) {} 
            const range = timeline.getWindow(); const width = range.end.valueOf() - range.start.valueOf(); 
            timeline.setWindow(-2000, -2000 + width, {animation: true}); 
        }
        
        function nudgeTime(amount) { if (!isPlaying) return; socket.emit('nudge_time', { amount: amount }); }
        function toggleHold() { if (!isPlaying) return; socket.emit('toggle_hold'); }
        
        socket.on('hold_state', (data) => {
            const holdBtn = document.getElementById('btn-hold');
            if (data.held) { holdBtn.classList.add('active'); holdBtn.innerHTML = "▶ RESUME"; document.getElementById('status-bar').style.color = "#ff9900"; } 
            else { holdBtn.classList.remove('active'); holdBtn.innerHTML = "⏸ HOLD (H)"; document.getElementById('status-bar').style.color = "#ff3b30"; }
        });
