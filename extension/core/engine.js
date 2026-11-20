// The bundled voice engine (aglink-voice-engine.exe, engine/ in this repo):
// started while voice is on, spoken to in JSON lines. call() sends a request
// and resolves with its answer; on() hears the events ("ready", "mic",
// "status", "micError", "fatal"). See engine/Engine.cs for the requests.
"use strict";

const { spawn } = require("child_process");
const { EventEmitter } = require("events");

// The engine says "ready" right after it starts: Whisper and the reading
// model load in the background afterwards (status events), so only .NET's
// own start-up, a cold disk or a virus scan of the exe is waited for here.
const START_TIMEOUT_MS = 30000;
// How long a request may wait for its answer. play answers when the reading
// ends (a long answer reads for minutes), so it has no limit; transcribe may
// queue behind another clip, each up to Whisper.cs's 2 min HTTP limit.
const CALL_TIMEOUT_MS = { play: 0, tts: 120000, transcribe: 300000, embed: 60000 };
const DEFAULT_CALL_TIMEOUT_MS = 20000;

class Engine extends EventEmitter {
  // whisper: false starts the engine for reading only; ensureWhisper() adds
  // recognition later. The timeout options are for the tests.
  constructor(exe, root, log = () => {}, { whisper = true, whisperServer = "", micCleanup = "off", startTimeoutMs = START_TIMEOUT_MS, callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS, callTimeouts = CALL_TIMEOUT_MS } = {}) {
    super();
    this.withWhisper = whisper;
    this.whisperServer = whisperServer; // "" = recognise locally; a URL = that remote whisper server
    this.micCleanup = micCleanup; // off | light | strong — tidy the clip before whisper
    this.exe = exe;
    this.root = root;
    this.log = log;
    this.startTimeoutMs = startTimeoutMs;
    this.callTimeoutMs = callTimeoutMs;
    this.callTimeouts = callTimeouts;
    this.proc = null;
    this.starting = null; // the start in flight, shared by every caller
    this.next = 1;
    this.waits = new Map(); // the running process's requests (a new map per process)
    this.whisper = whisper ? "starting" : "idle";
  }

  // start resolves once the engine has said "ready" (Whisper may still be
  // coming up; status events follow), or rejects if it could not start or did
  // not say so in time (it is then killed). A call while a start is in flight
  // gets that same start.
  start() {
    if (this.starting) return this.starting;
    if (this.proc) return Promise.resolve();
    const run = this.spawnEngine();
    this.starting = run;
    const clear = () => {
      if (this.starting === run) this.starting = null;
    };
    run.then(clear, clear);
    return run;
  }

  spawnEngine() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let p;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!err) return resolve();
        // A failed start (fatal, timeout) lets go of the process at once, so
        // the next start spawns afresh rather than finding it still there.
        if (p && this.proc === p) this.proc = null;
        try {
          if (p) p.kill();
        } catch {}
        reject(err);
      };
      try {
        const args = [this.root];
        if (!this.withWhisper) args.push("--no-whisper");
        if (this.whisperServer) args.push("--whisper-server=" + this.whisperServer);
        if (this.micCleanup && this.micCleanup !== "off") args.push("--mic-cleanup=" + this.micCleanup);
        p = spawn(this.exe, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } catch (e) {
        done(e);
        return;
      }
      this.proc = p;
      const waits = new Map();
      this.waits = waits;

      // gone is the one clean-up for a failed spawn ('error') and an ended
      // process ('exit'), whichever comes first: every waiting request is
      // refused with its timer cleared, and "exit" is told once.
      let ended = false;
      const gone = (why, code) => {
        if (ended) return;
        ended = true;
        if (this.proc === p) this.proc = null;
        for (const w of waits.values()) {
          clearTimeout(w.timer);
          w.reject(new Error(`engine stopped (${why})`));
        }
        waits.clear();
        done(new Error(`engine ${why}`));
        this.emit("exit", code);
      };

      if (this.startTimeoutMs > 0) {
        timer = setTimeout(() => {
          this.log(`engine: no "ready" after ${this.startTimeoutMs} ms — stopping it`);
          done(new Error("음성 엔진이 제때 켜지지 않았어요")); // kills it
          gone("did not start in time", null); // now, not when the kill lands: a new start may follow at once
        }, this.startTimeoutMs);
      }

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
          } else if (waits.has(m.id)) {
            const w = waits.get(m.id);
            waits.delete(m.id);
            clearTimeout(w.timer);
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
      p.stdin.on("error", () => {}); // a write to an engine that just died: 'exit' tidies up
      p.on("error", (e) => {
        done(e); // the cause itself (ENOENT, EACCES) rather than "stopped"
        gone(`failed: ${e.message}`, null);
      });
      p.on("exit", (code) => gone(`exited (${code})`, code));
    });
  }

  // call sends a request and resolves with its answer. It is refused if the
  // engine stops first or does not answer within the op's limit
  // (CALL_TIMEOUT_MS); a late answer is then dropped.
  call(op, args = {}) {
    if (!this.proc) return Promise.reject(new Error("engine not running"));
    const waits = this.waits;
    const limit = op in this.callTimeouts ? this.callTimeouts[op] : this.callTimeoutMs;
    return new Promise((resolve, reject) => {
      const id = this.next++;
      const w = { resolve, reject, timer: null };
      if (limit > 0) {
        w.timer = setTimeout(() => {
          if (waits.get(id) !== w) return;
          waits.delete(id);
          this.log(`engine: no answer to ${op} in ${limit} ms`);
          reject(new Error(`음성 엔진이 응답하지 않아요 (${op})`));
        }, limit);
      }
      waits.set(id, w);
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

module.exports = { Engine, START_TIMEOUT_MS, CALL_TIMEOUT_MS, DEFAULT_CALL_TIMEOUT_MS };
