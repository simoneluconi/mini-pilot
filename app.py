import sys
# Force UTF-8 stdio so the emoji-laden log/print statements below don't crash
# on Windows consoles that default to a legacy (non-UTF-8) codepage.
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import time
import json
import os
import csv
import io
import urllib.request
import urllib.parse
from flask import Flask, render_template, request, jsonify, make_response, url_for
from flask_socketio import SocketIO
import obsws_python as obs
import threading

app = Flask(__name__)
# 'threading' avoids the eventlet dependency (deprecated upstream) and its
# monkey-patching/DNS quirks; this app doesn't need eventlet-scale concurrency.
socketio = SocketIO(app, async_mode='threading', cors_allowed_origins="*")
triggered_webhooks = set()

@app.context_processor
def inject_asset_url():
    # Appends the file's mtime as a ?v= query param so browsers don't keep
    # serving a stale cached copy of static/css|js after we edit a file.
    def asset_url(filename):
        full_path = os.path.join(app.static_folder, filename)
        try:
            version = int(os.path.getmtime(full_path))
        except OSError:
            version = 0
        return f"{url_for('static', filename=filename)}?v={version}"
    return dict(asset_url=asset_url)

OBS_CONFIG_FILE = "obs_config.json"
obs_client = None
obs_connected = False
obs_error = ""

def load_obs_config():
    if os.path.exists(OBS_CONFIG_FILE):
        with open(OBS_CONFIG_FILE, 'r') as f:
            return json.load(f)
    return {"host": "localhost", "port": 4455, "password": "", "webhook_url": ""}

def connect_obs():
    global obs_client, obs_connected, obs_error
    config = load_obs_config()
    try:
        obs_client = obs.ReqClient(host=config['host'], port=config['port'], password=config['password'])
        obs_connected = True
        obs_error = ""
        print(f"✅ Connected to OBS at {config['host']}:{config['port']}!")
    except Exception as e:
        obs_client = None
        obs_connected = False
        obs_error = str(e)
        print(f"❌ OBS Connection Error: {e}")

connect_obs()

is_playing = False
start_time = 0
active_rundown = []
show_mode = "playback"
force_timeline_update = False

time_offset = 0.0
is_paused = False
pause_timestamp = 0.0

current_live_scene = None
current_preview_scene = None

COMPILATIONS_FILE = 'compilations.json'

def load_compilations():
    if os.path.exists(COMPILATIONS_FILE):
        with open(COMPILATIONS_FILE, 'r') as f:
            return json.load(f)
    return {}

# --- IOT FUNCTION FOR PHYSICAL TALLY LIGHTS ---
def trigger_physical_tally(scene_name):
    config = load_obs_config()
    webhook_url = config.get("webhook_url", "").strip()
    if webhook_url:
        try:
            # Send a POST request to the IoT device (e.g. ESP32, Raspberry)
            url = f"{webhook_url}?scene={urllib.parse.quote(scene_name)}"
            req = urllib.request.Request(url, method="POST")
            urllib.request.urlopen(req, timeout=0.5)
            print(f"💡 Tally hardware turned on for: {scene_name}")
        except Exception as e:
            print(f"⚠️ Webhook Tally Error: {e}")

# --- PAGE ROUTES ---
@app.route('/')
def index(): return render_template('index.html')

@app.route('/camera')
def camera_select(): return render_template('camera.html', scenes=get_obs_scenes())

@app.route('/talent')
def talent_monitor(): return render_template('talent.html')

# --- API AND CSV EXPORT ---
@app.route('/api/scenes')
def api_scenes(): return jsonify(get_obs_scenes())

@app.route('/api/transitions')
def api_transitions():
    if not obs_client: return jsonify(["Cut", "Fade"])
    try:
        resp = obs_client.get_scene_transition_list()
        return jsonify([t['transitionName'] for t in resp.transitions])
    except:
        return jsonify(["Cut", "Fade"])

@app.route('/api/compilations', methods=['GET', 'POST'])
def api_compilations():
    comps = load_compilations()
    if request.method == 'POST':
        data = request.json
        name = data.get('name')
        if not name: return jsonify({"error": "Missing name"}), 400
        comps[name] = data.get('rundown')
        with open(COMPILATIONS_FILE, 'w') as f:
            json.dump(comps, f)
        return jsonify({"status": "success", "compilations": list(comps.keys())})
    return jsonify(comps)

@app.route('/api/export_csv/<project_name>')
def export_csv(project_name):
    comps = load_compilations()
    rundown = comps.get(project_name, [])
    
    si = io.StringIO()
    cw = csv.writer(si)
    cw.writerow(['Shot Number', 'Start Time (s)', 'End Time (s)', 'Camera/Scene', 'Movement', 'Transition', 'Duration', 'Director Note'])
    
    for i, clip in enumerate(rundown):
        cw.writerow([
            i + 1, 
            clip.get('start', 0), 
            clip.get('end', 0), 
            clip.get('scene', ''), 
            clip.get('movement', 'Static'), 
            clip.get('transition', 'Cut'), 
            clip.get('transition_duration', 0), 
            clip.get('note', '')
        ])
    
    output = make_response(si.getvalue())
    output.headers["Content-Disposition"] = f"attachment; filename={project_name}_rundown.csv"
    output.headers["Content-type"] = "text/csv"
    return output

def get_obs_scenes():
    if not obs_client: return ["Camera 1", "Camera 2", "Camera 3"]
    try:
        return [scene['sceneName'] for scene in obs_client.get_scene_list().scenes]
    except:
        return []

@socketio.on('req_obs_status')
def handle_obs_status():
    config = load_obs_config()
    socketio.emit('obs_status', {'connected': obs_connected, 'error': obs_error, 'host': config['host'], 'port': config['port'], 'webhook_url': config.get('webhook_url', '')}, room=request.sid)

@socketio.on('save_obs_config')
def handle_save_obs(data):
    with open(OBS_CONFIG_FILE, 'w') as f:
        json.dump({
            "host": data.get('host', 'localhost'), 
            "port": int(data.get('port', 4455)), 
            "password": data.get('password', ''),
            "webhook_url": data.get('webhook_url', '')
        }, f)
    connect_obs()
    socketio.emit('obs_status', {'connected': obs_connected, 'error': obs_error, 'host': data.get('host', 'localhost'), 'port': int(data.get('port', 4455)), 'webhook_url': data.get('webhook_url', '')})

@socketio.on('req_scenes_refresh')
def handle_scenes_refresh():
    socketio.emit('scenes_list', get_obs_scenes(), room=request.sid)
    try:
        if obs_client:
            resp = obs_client.get_scene_transition_list()
            socketio.emit('transitions_list', [t['transitionName'] for t in resp.transitions], room=request.sid)
    except: pass

def run_show():
    global is_playing, start_time, active_rundown, show_mode, force_timeline_update
    global time_offset, is_paused, pause_timestamp, triggered_webhooks, current_live_scene
    rundown = sorted(active_rundown, key=lambda x: x['start'])
    last_triggered_start = None

    while is_playing:
        if is_paused: elapsed = (pause_timestamp - start_time) + time_offset
        else: elapsed = (time.time() - start_time) + time_offset
        
        if elapsed < 0: elapsed = 0.0
        socketio.emit('timecode', {'time': elapsed})

        if show_mode == 'playback' and not is_paused:
            target_shot = None
            for item in rundown:
                if elapsed >= item["start"]:
                    item_type = item.get("itemType", item.get("type", "shot"))
                    
                    # Execute webhook
                    if item_type == "webhook":
                        wh_id = f"{item['start']}_{item.get('url')}"
                        if wh_id not in triggered_webhooks:
                            triggered_webhooks.add(wh_id)
                            trigger_custom_webhook(item)

                    # Update camera
                    if item_type == "shot":
                        target_shot = item
                else: break 

            if target_shot and (force_timeline_update or last_triggered_start != target_shot["start"]):
                last_triggered_start = target_shot["start"]
                force_timeline_update = False
                
                if obs_client:
                    t_name = target_shot.get("transition", "").strip()
                    if t_name and t_name.lower() not in ["cut", "taglio"]:
                        try:
                            obs_client.set_current_scene_transition(t_name)
                            obs_client.set_current_scene_transition_duration(int(target_shot.get("transition_duration", 300)))
                        except: pass
                    try:
                        obs_client.set_current_program_scene(target_shot["scene"])
                        trigger_physical_tally(target_shot["scene"])
                        current_live_scene = target_shot["scene"]
                    except: pass

        if show_mode == 'playback' and len(rundown) > 0 and not is_paused:
            if elapsed > rundown[-1].get("end", rundown[-1]["start"] + 10):
                 is_playing = False
                 socketio.emit('status', {'msg': 'Show Ended'})
                 if obs_client:
                     try: 
                         status = obs_client.get_record_status()
                         if status.output_active:
                             obs_client.stop_record()
                     except: pass
                 break
        socketio.sleep(0.05)

def trigger_custom_webhook(item):
    def _send():
        try:
            url = item.get('url', '')
            method = item.get('method', 'POST')
            payload = item.get('payload', '')
            if not url: return
            
            print(f"🌐 Triggering Webhook: {method} {url}")
            req = urllib.request.Request(url, method=method)
            if method == 'POST' and payload:
                req.add_header('Content-Type', 'application/json')
                req.data = payload.encode('utf-8')
            urllib.request.urlopen(req, timeout=2.0)
        except Exception as e:
            print(f"⚠️ Custom Webhook Error: {e}")
            
    threading.Thread(target=_send).start()

@socketio.on('start_show')
def handle_start(data):
    global is_playing, start_time, active_rundown, show_mode, force_timeline_update, time_offset, is_paused, triggered_webhooks
    global current_live_scene, current_preview_scene
    if not is_playing:
        active_rundown = data.get('rundown', [])
        show_mode = data.get('mode', 'playback')
        obs_audio_source = data.get('obs_audio_source', '').strip()
        auto_record = data.get('auto_record', True)

        force_timeline_update = True
        time_offset = 0.0
        is_paused = False
        triggered_webhooks = set()
        current_live_scene = None
        current_preview_scene = None
        socketio.emit('hold_state', {'held': False})
        
        if obs_client:
            # 1. Start the music bed
            if obs_audio_source:
                try: obs_client.trigger_media_input_action(obs_audio_source, 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART')
                except Exception as e: print(f"Audio Start Error: {e}")

            # 2. Safely start recording
            if auto_record:
                try: 
                    status = obs_client.get_record_status()
                    if not status.output_active:
                        obs_client.start_record()
                        print("⏺️ OBS Master Recording Started automatically!")
                except Exception as e: 
                    print(f"⚠️ OBS Record Start Warning: {e}")

        socketio.emit('show_started', {'mode': show_mode}) 
        if show_mode == 'playback': socketio.emit('rundown_updated', active_rundown) 
        
        is_playing = True
        start_time = time.time()
        socketio.start_background_task(run_show)
        socketio.emit('status', {'msg': f'LIVE ({show_mode.upper()})'})

@socketio.on('change_mode')
def handle_change_mode(data):
    global show_mode, force_timeline_update
    show_mode = data.get('mode', 'playback')
    if show_mode == 'playback': force_timeline_update = True 
    socketio.emit('mode_changed', {'mode': show_mode})
    socketio.emit('status', {'msg': f'LIVE ({show_mode.upper()})'})

@socketio.on('stop_show')
def handle_stop():
    global is_playing, is_paused, current_live_scene, current_preview_scene
    is_playing = False
    is_paused = False
    current_live_scene = None
    current_preview_scene = None

    # Safely stop recording
    if obs_client:
        try: 
            status = obs_client.get_record_status()
            if status.output_active:
                obs_client.stop_record()
                print("⏹ OBS Master Recording Stopped.")
        except Exception as e: 
            print(f"⚠️ OBS Record Stop Warning: {e}")
        
    socketio.emit('status', {'msg': 'Stopped'})
    socketio.emit('hold_state', {'held': False})

@socketio.on('live_action')
def handle_live_action(data):
    global current_live_scene
    scene = data.get('scene')
    trans = data.get('transition', '').strip()
    dur = data.get('transition_duration') or 300

    if obs_client and scene:
        if trans and trans.lower() not in ["cut", "taglio"]:
            try:
                obs_client.set_current_scene_transition(trans)
                obs_client.set_current_scene_transition_duration(int(dur))
            except: pass
        try:
            obs_client.set_current_program_scene(scene)
            trigger_physical_tally(scene) # Turns on physical tally
        except: pass

    current_live_scene = scene
    socketio.emit('live_cut', {'scene': scene})

# --- STUDIO MODE: PREVIEW / PROGRAM ---
@socketio.on('set_preview_scene')
def handle_set_preview_scene(data):
    global current_preview_scene
    scene = data.get('scene')
    if not scene: return

    if obs_client:
        try:
            status = obs_client.get_studio_mode_enabled()
            if not status.studio_mode_enabled:
                obs_client.set_studio_mode_enabled(True)
        except Exception as e:
            print(f"⚠️ Studio Mode Enable Error: {e}")
        try:
            obs_client.set_current_preview_scene(scene)
        except Exception as e:
            print(f"⚠️ Set Preview Scene Error: {e}")

    current_preview_scene = scene
    socketio.emit('preview_changed', {'scene': scene})

@socketio.on('take_live')
def handle_take_live(data):
    global current_live_scene, current_preview_scene
    data = data or {}
    scene = current_preview_scene
    if not scene: return

    trans = data.get('transition', '').strip()
    dur = data.get('transition_duration') or 300
    # Whatever is in program right now is what the transition below will push
    # into preview - OBS's studio mode transition always swaps the two, no
    # matter which transition/duration is used, so this holds for all of them.
    previous_program = current_live_scene

    if obs_client:
        if trans and trans.lower() not in ["cut", "taglio"]:
            try:
                obs_client.set_current_scene_transition(trans)
                obs_client.set_current_scene_transition_duration(int(dur))
            except: pass
        try:
            obs_client.trigger_studio_mode_transition()
            current_preview_scene = previous_program
        except Exception as e:
            print(f"⚠️ Studio Mode Transition failed, falling back to direct cut: {e}")
            try: obs_client.set_current_program_scene(scene)
            except: pass
        trigger_physical_tally(scene)

    current_live_scene = scene
    socketio.emit('live_cut', {'scene': scene})
    if current_preview_scene:
        socketio.emit('preview_changed', {'scene': current_preview_scene})

@socketio.on('nudge_time')
def handle_nudge(data):
    global time_offset
    time_offset += data.get('amount', 0.0)

@socketio.on('toggle_hold')
def handle_toggle_hold():
    global is_paused, pause_timestamp, time_offset
    if not is_paused:
        is_paused = True
        pause_timestamp = time.time()
        socketio.emit('hold_state', {'held': True})
    else:
        is_paused = False
        time_offset -= (time.time() - pause_timestamp)
        socketio.emit('hold_state', {'held': False})

@socketio.on('send_urgent_message')
def handle_urgent_msg(data):
    socketio.emit('urgent_message', data)

@socketio.on('intercom_audio')
def handle_intercom_audio(data):
    # Legacy blob-based intercom, kept only for backwards compatibility.
    # Live clients now use the audio_stream PCM streaming events instead.
    socketio.emit('audio_broadcast', data, include_self=False)

@socketio.on('audio_stream')
def handle_audio_stream(data):
    socketio.emit('audio_stream', data, include_self=False)

@socketio.on('get_status_sync')
def handle_sync():
    global active_rundown, show_mode, is_playing, current_live_scene, current_preview_scene
    socketio.emit('rundown_updated', active_rundown, room=request.sid)
    socketio.emit('mode_changed', {'mode': show_mode}, room=request.sid)
    if is_playing:
        socketio.emit('show_started', {'mode': show_mode}, room=request.sid)
        socketio.emit('status', {'msg': f'LIVE ({show_mode.upper()})'}, room=request.sid)
        if current_live_scene:
            socketio.emit('live_cut', {'scene': current_live_scene}, room=request.sid)
        if current_preview_scene:
            socketio.emit('preview_changed', {'scene': current_preview_scene}, room=request.sid)

@socketio.on('req_director_sync')
def handle_director_sync():
    global active_rundown, show_mode, is_playing, is_paused, current_live_scene, current_preview_scene
    global start_time, time_offset, pause_timestamp
    elapsed = 0.0
    if is_playing:
        if is_paused: elapsed = (pause_timestamp - start_time) + time_offset
        else: elapsed = (time.time() - start_time) + time_offset
        if elapsed < 0: elapsed = 0.0
    socketio.emit('director_sync', {
        'is_playing': is_playing,
        'is_paused': is_paused,
        'mode': show_mode,
        'rundown': active_rundown,
        'elapsed': elapsed,
        'live_scene': current_live_scene,
        'preview_scene': current_preview_scene
    }, room=request.sid)

if __name__ == '__main__':
    if not os.path.exists(COMPILATIONS_FILE):
        with open(COMPILATIONS_FILE, 'w') as f: json.dump({}, f)
    socketio.run(app, debug=True, port=5000)