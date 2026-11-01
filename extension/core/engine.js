// The bundled voice engine (aglink-voice-engine.exe, engine/ in this repo):
// started while voice is on, spoken to in JSON lines. call() sends a request
// and resolves with its answer; on() hears the events ("ready", "mic",
// "status", "micError", "fatal"). See engine/Engine.cs for the requests.
"use strict";

const { spawn } = require("child_process");
const { EventEmitter } = require("events");

class Engine extends EventEmitter {
  // whisper: false starts the engine for reading only; ensureWhisper() adds
  // recognition later.
  constructor(exe, root, log = () => {}, { whisper = true } = {}) {
    super();
    this.withWhisper = whisper;
    this.exe = exe;
    this.root = root;
    this.log = log;
    this.proc = null;
    this.next = 1;
    this.waits = new Map();
    this.whisper = whisper ? "starting" : "idle";
  }

  // start resolves once the engine has said "ready" (Whisper may still be
  // coming up; status events follow), or rejects if it could not start.
  start() {
    if (this.proc) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };
      let p;
      try {
        p = spawn(this.exe, this.withWhisper ? [this.root] : [this.root, "--no-whisper"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } catch (e) {
        done(e);
        return;
      }
      this.proc = p;
      let buf = "";
      p.stdout.setEncoding("utf8").on("data", (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let m;
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          if (m.ev) {
            if (m.ev === "ready") done();
            else if (m.ev === "fatal") done(new Error(m.error || "engine failed"));
            else if (m.ev === "status" && m.whisper) this.whisper = m.whisper;
            this.emit(m.ev, m);
          } else if (this.waits.has(m.id)) {
            const w = this.waits.get(m.id);
            this.waits.delete(m.id);
            if (m.ok) w.resolve(m);
            else w.reject(new Error(m.error || "engine error"));
          }
        }
      });
      let errBuf = "";
      p.stderr.setEncoding("utf8").on("data", (c) => {
        errBuf += c;
        let i;
        while ((i = errBuf.indexOf("\n")) >= 0) {
          this.log(`engine: ${errBuf.slice(0, i).trimEnd()}`);
          errBuf = errBuf.slice(i + 1);
        }
      });
      p.on("error", (e) => done(e));
      p.on("exit", (code) => {
        if (this.proc === p) this.proc = null;
        for (const w of this.waits.values()) w.reject(new Error("engine stopped"));
        this.waits.clear();
        done(new Error(`engine exited (${code})`));
        this.emit("exit", code);
      });
    });
  }

  call(op, args = {}) {
    if (!this.proc) return Promise.reject(new Error("engine not running"));
    return new Promise((resolve, reject) => {
      const id = this.next++;
      this.waits.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, op, ...args }) + "\n");
    });
  }

  // ensureWhisper starts recognition in an engine started for reading only.
  async ensureWhisper() {
    if (this.whisper !== "idle") return;
    const r = await this.call("whisper");
    if (this.whisper === "idle") this.whisper = r.whisper;
  }

  // stop closes stdin: the engine turns off the mic, playback and Whisper and exits.
  stop() {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    try {
      p.stdin.end();
    } catch {}
    setTimeout(() => {
      try {
        p.kill();
      } catch {}
    }, 3000).unref();
  }

  get running() {
    return !!this.proc;
  }
}

module.exports = { Engine };
