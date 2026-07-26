# 🎛️ Mini-Pilot Studio | Director Station for OBS

🚀 **Professional Timeline-Based Show Controller & Intercom system — directly linked to OBS**

Mini-Pilot Studio is a powerful, web-based control room designed to automate and manage live broadcasts, talk shows, and events. It transforms your browser into a fully-fledged Director Station with a Non-Linear Timeline Editor (NLE), automating OBS scene switches, triggering external devices via Webhooks, and providing real-time cues for your crew.

![Timeline](demo/timeline.gif)

![Tally](demo/tally.gif)

---

## 🎯 What is this?

Think of it as an automated brain for your live production:

- 🎬 **Timeline Automation**: Plan your show in advance with precise durations  
- 🔴 **OBS Auto-Switching**: Automatically cuts and transitions between OBS scenes  
- 🎚️ **Studio Mode Switcher**: A real Preview/Program bus — send a scene to Preview (PRV), then TAKE it live via OBS's Studio Mode transition, or CUT straight to Program  
- 📋 **Live Auto-Scrolling Rundown**: A dynamic script that follows the show in real-time  
- 🎙️ **Realtime Intercom**: Low-latency streamed Push-To-Talk audio to your crew  
- 🌐 **Webhook Triggers**: Fire external events (lights, audio, Resolume, etc.)  
- 🎛️ **Manual Override**: Take control anytime with Quick Cuts  
- 🔄 **Resilient to refresh**: Reloading any screen (F5) re-syncs it to the live show automatically  

---

## 🧠 How it works

The system is powered by a **Python backend (Flask + Socket.IO)** that communicates with OBS Studio via WebSockets.

It serves different interfaces:

- **Director Station (`/`)** → Timeline, controls, NLE, Preview/Program switcher  
- **Cameraman View (`/camera`)** → Current/next shots, tally (including a "you're in preview" warning when the director arms your camera), intercom — responsive on phones/tablets  
- **Talent View (`/talent`)** → Prompter, cues, alerts — responsive on phones/tablets  

Every screen re-syncs itself from the server on load/reconnect, so refreshing the page or reconnecting after a dropped connection picks the show back up automatically.

---

## 🚀 Installation & Setup

### 1️⃣ Install OBS & Enable WebSockets

1. Install OBS Studio  
2. Go to: `Tools → WebSocket Server Settings`  
3. Enable WebSocket server  
4. Set port (default: `4455`)  
5. Enable authentication and generate password  

---

### 2️⃣ Install Python

Install Python 3.8+

⚠️ **IMPORTANT (Windows)**: enable **"Add Python to PATH"**

---

### 3️⃣ Setup the Project

```bash
pip install -r requirements.txt
```
---

### 4️⃣ Run the App

```bash
python app.py
```

Open:

👉 http://127.0.0.1:5000

---

## ⚙️ Connect to OBS

1. Open settings in UI  
2. Enter:
   - Host: `localhost`
   - Port: `4455`
   - Password: your OBS password  
3. Click **Connect**

✅ Status → **OBS Connected**

ℹ️ You don't need to enable Studio Mode yourself — the app switches it on in OBS automatically the first time you send a scene to Preview.

---

## 🎥 Director Workflow

### 1. Build the Show

- Add timeline items:
  - Camera shots  
  - Lyrics / cues  
  - Webhooks  
- Set duration & transitions  
- Drag to adjust timing  

---

### 2. Go Live

- Select mode (Auto / Manual / Record)  
- Click **ARM SHOW**  
- Press **GO! (SPACE)**  

---

### 3. Switching (Preview/Program)

Each scene has its own **PRV** / **CUT** buttons, stacked like a real switcher bus:

- **CUT** (or its hotkey) → instant cut straight to Program  
- **PRV** (or **Shift + hotkey**) → send the scene to Preview first  
- **TAKE** → push whatever is in Preview to Program via OBS's Studio Mode transition (falls back to a direct cut if Studio Mode isn't available)  

Pressing any of these while the show is in **Auto** automatically switches it to **Manual**, so you're never fighting the automation.

---

### 4. Communication

- 🔔 Stage Pager → send alerts  
- 🎙️ Hold PTT → talk to crew in realtime with streamed audio  

---

### 5. Save & Export

- 💾 Save project  
- 🗂️ Export CSV  
- 🖨️ Print script  

---

## 🧩 Project Structure

```
app.py
requirements.txt
templates/
 ├── index.html      Director Station page shell
 ├── camera.html     Cameraman View page shell
 └── talent.html     Talent View page shell
static/
 ├── css/
 │   ├── index.css
 │   ├── camera.css
 │   ├── talent.css
 │   └── receiver-common.css   shared by camera.html + talent.html
 └── js/
     ├── index.js
     ├── camera.js
     ├── talent.js
     └── receiver-common.js    shared by camera.html + talent.html
```

---

## 💡 Pro Tips

- 🖥️ Dual monitor: OBS + Director UI  
- 📱 Use local network for mobile access  
- 🎥 Auto-record on GO  

---

## ❤️ Contributing

Pull requests welcome!  
Ideas: vMix, MIDI, PTZ integrations 🚀
