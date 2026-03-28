# 🎛️ Mini-Pilot Studio | Director Station for OBS

🚀 **Professional Timeline-Based Show Controller & Intercom system — directly linked to OBS**

Mini-Pilot Studio is a powerful, web-based control room designed to automate and manage live broadcasts, talk shows, and events. It transforms your browser into a fully-fledged Director Station with a Non-Linear Timeline Editor (NLE), automating OBS scene switches, triggering external devices via Webhooks, and providing real-time cues for your crew.

![Timeline](demo/timeline.gif.gif)

![Tally](demo/tally.gif.gif)

---

## 🎯 What is this?

Think of it as an automated brain for your live production:

- 🎬 **Timeline Automation**: Plan your show in advance with precise durations  
- 🔴 **OBS Auto-Switching**: Automatically cuts and transitions between OBS scenes  
- 📋 **Live Auto-Scrolling Rundown**: A dynamic script that follows the show in real-time  
- 🎙️ **Push-To-Talk (PTT) Intercom**: Speak directly to your crew via browser  
- 🌐 **Webhook Triggers**: Fire external events (lights, audio, Resolume, etc.)  
- 🎛️ **Manual Override**: Take control anytime with Quick Cuts  

---

## 🧠 How it works

The system is powered by a **Python backend (Flask + Socket.IO)** that communicates with OBS Studio via WebSockets.

It serves different interfaces:

- **Director Station (`/`)** → Timeline, controls, NLE  
- **Cameraman View (`/camera`)** → Current/next shots, tally, intercom  
- **Talent View (`/talent`)** → Prompter, cues, alerts  

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

### 3. Communication

- 🔔 Stage Pager → send alerts  
- 🎙️ Hold PTT → talk to crew  

---

### 4. Save & Export

- 💾 Save project  
- 🗂️ Export CSV  
- 🖨️ Print script  

---

## 🧩 Project Structure

```
app.py
requirements.txt
templates/
 ├── index.html
 ├── camera.html
 └── talent.html
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
