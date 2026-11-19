window.__ModuleLoader__.load({ id: "@istarry/spoon-companion", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply2,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/cleanup.js
var MARKER = "<!--more-->";
var TRIGGER_TEXTS = /* @__PURE__ */ new Set([
  "\u6536\u5230\u6267\u884C\u8BF7\u6C42",
  "\u7EE7\u7EED\u6267\u884C\u76EE\u6807",
  "\u6536\u5230\u4EFB\u52A1\u6D88\u606F",
  "\u6536\u5230\u56E2\u961F\u6D88\u606F",
  "\u5B50\u4EFB\u52A1\u72B6\u6001\u66F4\u65B0",
  "\u6536\u5230 GitHub \u4E8B\u4EF6",
  "\u6536\u5230\u5916\u90E8\u4E8B\u4EF6",
  "\u81EA\u52A8\u5316\u4EFB\u52A1",
  "\u540E\u53F0\u4EFB\u52A1\u72B6\u6001\u66F4\u65B0"
]);
function stripMarkers(root) {
  let walker;
  try {
    walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  } catch {
    return;
  }
  const hits = [];
  let node = walker.nextNode();
  while (node) {
    const v = node.nodeValue;
    if (typeof v === "string" && v.indexOf(MARKER) !== -1) hits.push(node);
    node = walker.nextNode();
  }
  for (const n of hits) {
    const cleaned = n.nodeValue.split(MARKER).join("").replace(/\n{3,}/g, "\n\n").replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, "");
    if (cleaned !== n.nodeValue) n.nodeValue = cleaned;
  }
}
function hideTriggers(root) {
  let candidates;
  try {
    candidates = root.querySelectorAll("span,div,p,a");
  } catch {
    return;
  }
  for (const el of candidates) {
    if (el.children.length > 0) continue;
    const text = (el.textContent || "").trim();
    if (!TRIGGER_TEXTS.has(text)) continue;
    let p = el;
    for (let depth = 0; depth < 6 && p.parentElement; depth++) {
      p = p.parentElement;
      let bg = "";
      try {
        bg = getComputedStyle(p).backgroundColor;
      } catch {
        break;
      }
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
        p.setAttribute("data-spoon-cleanup-hidden", "1");
        p.style.setProperty("display", "none", "important");
        break;
      }
    }
  }
}
function sweep() {
  const body = document.body;
  if (!body) return;
  try {
    stripMarkers(body);
  } catch {
  }
  try {
    hideTriggers(body);
  } catch {
  }
}
function applyCleanup(ctx) {
  let timer = 0;
  let observer;
  const schedule = () => {
    if (timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      sweep();
    }, 160);
  };
  try {
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  } catch {
    observer = void 0;
  }
  schedule();
  window.setTimeout(sweep, 600);
  try {
    ctx?.effect?.(() => () => {
      if (timer) window.clearTimeout(timer);
      try {
        observer?.disconnect();
      } catch {
      }
    });
  } catch {
  }
}

// src/client/voice/ui.tsx
var import_react = require("react");

// src/client/voice/api.ts
var PREFIX = "/api/companion-voice";
var DEDUPE_MS = 1500;
var lastStartKey = "";
var lastStartAt = 0;
function shouldDrop(key) {
  const now = Date.now();
  if (key === lastStartKey && now - lastStartAt < DEDUPE_MS) return true;
  lastStartKey = key;
  lastStartAt = now;
  return false;
}
async function jsonFetch(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers ?? {} }
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`companion-voice \u8FD4\u56DE\u4E86\u975E JSON\uFF08HTTP ${res.status}\uFF09`);
  }
}
var api = {
  state: () => jsonFetch(`${PREFIX}/state`),
  config: (patch) => jsonFetch(`${PREFIX}/config`, { method: "POST", body: JSON.stringify(patch) }),
  speak: (text) => jsonFetch(`${PREFIX}/speak`, { method: "POST", body: JSON.stringify({ text }) }),
  clearCache: () => jsonFetch(`${PREFIX}/cache/clear`, { method: "POST", body: "{}" }),
  /** 上传克隆样本（原始二进制）。 */
  uploadSample: async (file) => {
    const res = await fetch(`${PREFIX}/sample`, {
      method: "POST",
      headers: { "Content-Type": file.type || "audio/wav" },
      body: file
    });
    return await res.json();
  },
  /** 删除样本（同时关掉克隆）。 */
  clearSample: () => jsonFetch(`${PREFIX}/sample/clear`, { method: "POST", body: "{}" })
};
var currentAudio;
var playback = { playing: false, messageId: "", label: "" };
var playbackListeners = /* @__PURE__ */ new Set();
function setPlayback(next) {
  playback = { ...playback, ...next };
  for (const fn of playbackListeners) fn();
}
function getPlayback() {
  return playback;
}
function playAudio(url, meta) {
  stopAudio();
  const audio = new Audio(url);
  currentAudio = audio;
  setPlayback({
    playing: true,
    messageId: meta?.messageId ?? "",
    label: (meta?.label ?? "").replace(/\s+/g, " ").slice(0, 40)
  });
  audio.addEventListener("ended", () => {
    if (currentAudio !== audio) return;
    currentAudio = void 0;
    setPlayback({ playing: false, messageId: "", label: "" });
  });
  audio.addEventListener("error", () => {
    if (currentAudio !== audio) return;
    currentAudio = void 0;
    setPlayback({ playing: false, messageId: "", label: "" });
  });
  void audio.play().catch(() => {
  });
}
function stopAudio() {
  const had = currentAudio !== void 0;
  if (currentAudio) {
    try {
      currentAudio.pause();
      currentAudio.currentTime = 0;
    } catch {
    }
    currentAudio = void 0;
  }
  if (had || playback.playing) setPlayback({ playing: false, messageId: "", label: "" });
}
function isPlaying() {
  return currentAudio !== void 0 && !currentAudio.paused;
}
var STREAM_SR = 24e3;
var stream;
function isStreaming() {
  return stream !== void 0;
}
function stopStream() {
  if (!stream) return;
  const s = stream;
  s.closed = true;
  if (s.watchdog !== void 0) window.clearInterval(s.watchdog);
  stream = void 0;
  try {
    s.abort.abort();
  } catch {
  }
  for (const src of s.sources) {
    try {
      src.stop();
    } catch {
    }
  }
  s.sources.clear();
  try {
    void s.ctx.close();
  } catch {
  }
  setPlayback({ playing: false, messageId: "", label: "" });
}
var speakQueue = [];
var queueRunning = false;
function waitPlaybackDone(timeoutMs = 18e4) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (!isStreaming() && !isPlaying()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        resolve();
        return;
      }
      window.setTimeout(tick, 150);
    };
    tick();
  });
}
function clearQueue() {
  const pending = speakQueue.splice(0);
  for (const item of pending) item.resolve();
}
async function drainQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    for (; ; ) {
      const item = speakQueue.shift();
      if (!item) break;
      try {
        await speakNow(item.text, item.meta, item.hooks);
        await waitPlaybackDone();
        item.resolve();
      } catch (error) {
        item.reject(error);
      }
    }
  } finally {
    queueRunning = false;
  }
}
async function speakStream(text, meta, hooks = {}) {
  if (meta.manual) {
    clearQueue();
    return speakNow(text, meta, hooks);
  }
  return new Promise((resolve, reject) => {
    speakQueue.push({ text, meta, hooks, resolve, reject });
    void drainQueue();
  });
}
function stopAll(options) {
  if (!options?.keepQueue) clearQueue();
  stopStream();
  stopAudio();
}
async function speakNow(text, meta, hooks = {}) {
  if (!meta.manual && shouldDrop(`${meta.messageId}|${text}`)) {
    hooks.onDone?.({ cached: false, skipped: true });
    return;
  }
  if (meta.manual) {
    lastStartKey = `${meta.messageId}|${text}`;
    lastStartAt = Date.now();
  }
  stopAll({ keepQueue: true });
  const ctx = new AudioContext({ sampleRate: STREAM_SR });
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
    }
  }
  const abort = new AbortController();
  const s = { ctx, nextTime: ctx.currentTime + 0.06, sources: /* @__PURE__ */ new Set(), abort, started: false, finished: false, closed: false, messageId: meta.messageId };
  stream = s;
  setPlayback({ playing: true, messageId: meta.messageId, label: meta.label.replace(/\s+/g, " ").slice(0, 40) });
  let leadingSkipped = false;
  const isSilent = (pcm) => {
    let acc = 0;
    let n = 0;
    for (let i = 0; i < pcm.length; i += 32) {
      acc += Math.abs(pcm[i]);
      n++;
    }
    return n > 0 && acc / n < 40;
  };
  const finalize = () => {
    if (stream !== s || s.closed) return;
    if (!s.finished || s.sources.size > 0) return;
    s.closed = true;
    stream = void 0;
    try {
      void s.ctx.close();
    } catch {
    }
    setPlayback({ playing: false, messageId: "", label: "" });
  };
  const watchdog = window.setInterval(() => {
    if (s.closed) {
      window.clearInterval(watchdog);
      return;
    }
    if (!s.finished) return;
    const remain = s.nextTime - s.ctx.currentTime;
    if (remain <= 0.05 && s.sources.size === 0) {
      window.clearInterval(watchdog);
      finalize();
      return;
    }
    if (remain < -3) {
      window.clearInterval(watchdog);
      for (const src of s.sources) {
        try {
          src.stop();
        } catch {
        }
      }
      s.sources.clear();
      finalize();
    }
  }, 1e3);
  s.watchdog = watchdog;
  const enqueue = (pcm) => {
    if (!stream || stream !== s) return;
    if (pcm.length === 0) return;
    if (!leadingSkipped) {
      if (isSilent(pcm)) return;
      leadingSkipped = true;
    }
    const buf = ctx.createBuffer(1, pcm.length, STREAM_SR);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const at = Math.max(s.nextTime, ctx.currentTime + 0.02);
    src.start(at);
    s.nextTime = at + buf.duration;
    s.sources.add(src);
    src.onended = () => {
      s.sources.delete(src);
      finalize();
    };
    if (!s.started) {
      s.started = true;
      hooks.onStart?.();
    }
  };
  try {
    const res = await fetch(`${PREFIX}/speak-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: abort.signal
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      stream = void 0;
      try {
        void ctx.close();
      } catch {
      }
      const r = await api.speak(text);
      if (!r.ok || !r.url) throw new Error(r.error ?? detail.error ?? "\u5408\u6210\u5931\u8D25");
      playAudio(r.url, meta);
      hooks.onStart?.();
      hooks.onDone?.({ cached: Boolean(r.cached), totalMs: r.ms });
      return;
    }
    if (!res.body) throw new Error("\u6D41\u5F0F\u54CD\u5E94\u6CA1\u6709 body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let j;
        try {
          j = JSON.parse(payload);
        } catch {
          continue;
        }
        if (j.pcm) {
          const raw = atob(j.pcm);
          const bytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          const view = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1);
          enqueue(view);
        } else if (j.ok === false && j.error) {
          throw new Error(j.error);
        } else if (j.cached === true && j.url) {
          s.closed = true;
          window.clearInterval(watchdog);
          if (stream === s) {
            stream = void 0;
            try {
              void ctx.close();
            } catch {
            }
          }
          playAudio(j.url, meta);
          s.started = true;
          hooks.onStart?.();
          hooks.onDone?.({ cached: true });
        } else if (j.firstMs !== void 0 || j.totalMs !== void 0) {
          s.finished = true;
          hooks.onDone?.({ cached: false, firstMs: j.firstMs, totalMs: j.totalMs });
          finalize();
        }
      }
    }
    s.finished = true;
    finalize();
  } catch (e) {
    const msg = e.message;
    if (s.closed) return;
    s.closed = true;
    window.clearInterval(watchdog);
    if (stream === s) {
      stream = void 0;
      try {
        void ctx.close();
      } catch {
      }
      setPlayback({ playing: false, messageId: "", label: "" });
    }
    if (/abort/i.test(msg)) return;
    hooks.onError?.(msg);
  }
}
var autoFlags = { enabled: false, autoPlay: false };
var autoListeners = /* @__PURE__ */ new Set();
function updateAutoFlags(enabled, autoPlay) {
  if (autoFlags.enabled === enabled && autoFlags.autoPlay === autoPlay) return;
  autoFlags = { enabled, autoPlay };
  for (const fn of autoListeners) fn();
}
function shouldAutoPlay() {
  return autoFlags.enabled && autoFlags.autoPlay;
}
function subscribeAutoFlags(fn) {
  autoListeners.add(fn);
  return () => {
    autoListeners.delete(fn);
  };
}
var autoPlayed = /* @__PURE__ */ new Set();
function hasAutoPlayed(id) {
  return autoPlayed.has(id);
}
function markAutoPlayed(id) {
  autoPlayed.add(id);
}

// src/client/voice/transcript.ts
function normalizeTime(raw) {
  const t = Number(raw);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return t > 1e12 ? t : t * 1e3;
}
function turnScalarId(turn) {
  if (turn === void 0 || turn === null) return "";
  if (typeof turn === "string" || typeof turn === "number") return String(turn);
  if (typeof turn === "object") {
    const o = turn;
    for (const k of ["id", "turn", "index", "seq", "key"]) {
      const v = o[k];
      if (typeof v === "string" || typeof v === "number") return String(v);
    }
    const start = o.start;
    if (start && (typeof start.seq === "string" || typeof start.seq === "number")) return String(start.seq);
    const end = o.end;
    if (end && (typeof end.seq === "string" || typeof end.seq === "number")) return String(end.seq);
  }
  return "";
}
function turnNodes(snapshot) {
  const out = [];
  for (const node of snapshot.legacy.nodes) {
    if (node.kind !== "assistant") continue;
    if (node.messageId === void 0) continue;
    const parts = [];
    for (const block of node.blocks) {
      if (block.kind === "text") parts.push(block.text);
    }
    const turn = node.turn;
    out.push({
      messageId: String(node.messageId),
      // 优先用 turn 的标量 id；抽不到就留空，稍后按「本轮首个 messageId」补齐
      turnKey: turnScalarId(turn),
      text: parts.join("\n").trim(),
      time: normalizeTime(node.time)
    });
  }
  let fallback = 0;
  let prevEmpty = false;
  for (const n of out) {
    if (n.turnKey === "") {
      if (!prevEmpty) fallback++;
      n.turnKey = `grp:${fallback}`;
      prevEmpty = true;
    } else {
      prevEmpty = false;
    }
  }
  const firstOfGroup = /* @__PURE__ */ new Map();
  for (const n of out) if (!firstOfGroup.has(n.turnKey)) firstOfGroup.set(n.turnKey, n.messageId);
  for (const n of out) {
    const first = firstOfGroup.get(n.turnKey);
    if (first) n.turnKey = `turn@${first}`;
  }
  return out;
}
function streamingMessageId(snapshot) {
  const partial = snapshot.legacy.partial;
  if (!partial || partial.messageId === void 0) return "";
  return String(partial.messageId);
}
function assistantInfoOf(snapshot, messageId) {
  const nodes = turnNodes(snapshot);
  const me = nodes.find((n) => n.messageId === String(messageId));
  const empty = {
    text: me?.text ?? "",
    settled: false,
    inLatestTurn: false,
    isLastOfLatestTurn: false,
    latestTurnText: "",
    latestTurnKey: "",
    streaming: false,
    turnEndedAt: 0
  };
  if (!me) return empty;
  const last = nodes[nodes.length - 1];
  if (!last) return empty;
  const latestKey = last.turnKey;
  const inLatest = me.turnKey === latestKey;
  const isLastOfLatest = last.messageId === String(messageId);
  const merged = nodes.filter((n) => n.turnKey === latestKey).map((n) => n.text).filter((t) => t !== "").join("\n");
  const turnEndedAt = last.time;
  const streamingId = streamingMessageId(snapshot);
  const streaming = streamingId === String(messageId);
  return {
    text: me.text,
    // 在 finalized 列表里且不在流式中 = 这一轮已经说完
    settled: !streaming,
    inLatestTurn: inLatest,
    isLastOfLatestTurn: isLastOfLatest,
    latestTurnText: merged || me.text,
    latestTurnKey: latestKey,
    streaming,
    turnEndedAt
  };
}
function useAssistantInfo(useChat, messageId) {
  return useChat((snapshot) => assistantInfoOf(snapshot, messageId));
}

// src/client/voice/ui.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var CSS = `
.cv-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;
  padding:0;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;
  opacity:.62;transition:opacity .15s ease,background .15s ease;flex:0 0 auto}
.cv-btn:hover:not(:disabled){opacity:1;background:rgba(128,128,128,.14)}
.cv-btn:disabled{opacity:.28;cursor:default}
.cv-btn--on{opacity:1;color:#4d6bfe}
.cv-spin{display:inline-block;width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;
  border-radius:50%;animation:cv-spin .7s linear infinite}
@keyframes cv-spin{to{transform:rotate(360deg)}}
.cv-bars{display:inline-flex;align-items:flex-end;gap:2px;height:13px}
.cv-bars i{display:block;width:2.5px;border-radius:1px;background:currentColor;animation:cv-bar .9s ease-in-out infinite}
.cv-bars i:nth-child(1){height:5px;animation-delay:0s}
.cv-bars i:nth-child(2){height:12px;animation-delay:.15s}
.cv-bars i:nth-child(3){height:8px;animation-delay:.3s}
.cv-bars i:nth-child(4){height:13px;animation-delay:.45s}
@keyframes cv-bar{0%,100%{transform:scaleY(.35)}50%{transform:scaleY(1)}}

.cv-row{display:flex;align-items:center;gap:10px;width:100%;padding:2px 0}
.cv-row-main{flex:1 1 auto;min-width:0}
.cv-row-title{font-size:13px;line-height:20px}
.cv-row-desc{font-size:12px;line-height:18px;opacity:.62;margin-top:2px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-tag{flex:0 0 auto;font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;
  border:1px solid currentColor;opacity:.7}
.cv-tag--ok{color:#2ea043;opacity:.9}
.cv-tag--err{color:#d1242f;opacity:.9}
.cv-panel{margin-top:8px;padding:12px;border-radius:10px;background:rgba(128,128,128,.08);
  display:flex;flex-direction:column;gap:12px;font-size:12.5px;line-height:19px}
.cv-field{display:flex;flex-direction:column;gap:5px}
.cv-field label{opacity:.66;font-size:12px}
.cv-hint{font-size:11.5px;line-height:17px;opacity:.6}
.cv-input,.cv-textarea,.cv-select{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:7px;
  border:1px solid rgba(128,128,128,.34);background:rgba(255,255,255,.06);color:inherit;
  font:inherit;font-size:12.5px;outline:none}
.cv-input:focus,.cv-textarea:focus,.cv-select:focus{border-color:#4d6bfe}
.cv-textarea{resize:vertical;min-height:52px;line-height:18px}
.cv-select{cursor:pointer}
.cv-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.cv-primary{padding:5px 14px;border-radius:7px;border:0;background:#4d6bfe;color:#fff;
  font:inherit;font-size:12.5px;cursor:pointer}
.cv-primary:disabled{opacity:.5;cursor:default}
.cv-ghost{padding:5px 12px;border-radius:7px;border:1px solid rgba(128,128,128,.4);
  background:transparent;color:inherit;font:inherit;font-size:12.5px;cursor:pointer}
.cv-ghost:disabled{opacity:.5;cursor:default}
.cv-msg{font-size:12px;line-height:18px;opacity:.8;word-break:break-all}
.cv-msg--err{color:#d1242f;opacity:1}
.cv-msg--ok{color:#2ea043;opacity:1}
.cv-seg{display:inline-flex;border:1px solid rgba(128,128,128,.34);border-radius:8px;overflow:hidden}
.cv-seg button{padding:5px 16px;border:0;background:transparent;color:inherit;font:inherit;
  font-size:12.5px;cursor:pointer;opacity:.72}
.cv-seg button+button{border-left:1px solid rgba(128,128,128,.34)}
.cv-seg button[data-on="1"]{background:#4d6bfe;color:#fff;opacity:1}
.cv-check{display:flex;align-items:center;gap:7px;cursor:pointer;user-select:none}
.cv-check input{width:14px;height:14px;cursor:pointer;accent-color:#4d6bfe}
.cv-file{display:none}

/* \u5168\u5C40\u542F\u7528\u5F00\u5173 */
.cv-switch{display:inline-flex;align-items:center;cursor:pointer;flex:0 0 auto}
.cv-switch input{position:absolute;opacity:0;width:0;height:0;pointer-events:none}
.cv-switch-track{position:relative;display:inline-block;width:34px;height:19px;border-radius:999px;
  background:rgba(128,128,128,.4);transition:background .18s ease}
.cv-switch-thumb{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;
  background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.28);transition:transform .18s ease}
.cv-switch input:checked+.cv-switch-track{background:#2ea043}
.cv-switch input:checked+.cv-switch-track .cv-switch-thumb{transform:translateX(15px)}
.cv-switch input:disabled+.cv-switch-track{opacity:.45;cursor:default}
.cv-switch:hover input:not(:disabled)+.cv-switch-track{filter:brightness(1.08)}
`;
function IconSpeaker() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M11 5 6 9H3v6h3l5 4V5z" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M15.5 8.5a5 5 0 0 1 0 7" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M18.5 5.5a9 9 0 0 1 0 13" })
  ] });
}
function PlayingBars() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "cv-bars", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", {}),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", {}),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", {}),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", {})
  ] });
}
function SpeakerButton(props) {
  const info = useAssistantInfo(props.useChat, String(props.messageId));
  const [phase, setPhase] = (0, import_react.useState)("idle");
  const [error, setError] = (0, import_react.useState)("");
  const timer = (0, import_react.useRef)(void 0);
  (0, import_react.useEffect)(() => () => {
    window.clearInterval(timer.current);
  }, []);
  (0, import_react.useEffect)(() => () => {
    if (getPlayback().messageId === String(props.messageId)) stopAll();
  }, []);
  const tick = (0, import_react.useCallback)(() => {
    if (phase === "playing" && !isPlaying() && !isStreaming()) setPhase("idle");
  }, [phase]);
  (0, import_react.useEffect)(() => {
    window.clearInterval(timer.current);
    if (phase === "playing") timer.current = window.setInterval(tick, 350);
    return () => window.clearInterval(timer.current);
  }, [phase, tick]);
  (0, import_react.useEffect)(() => {
    if (phase !== "busy") return;
    const t = window.setTimeout(() => {
      if (!isStreaming() && !isPlaying()) {
        setError("\u5408\u6210\u8D85\u65F6\uFF0C\u8BF7\u91CD\u8BD5");
        setPhase("idle");
      }
    }, 9e4);
    return () => window.clearTimeout(t);
  }, [phase]);
  const onClick = (0, import_react.useCallback)(async () => {
    if (phase === "playing") {
      stopAll();
      setPhase("idle");
      return;
    }
    if (phase === "busy") return;
    const body = info.text.trim();
    if (!body) return;
    setError("");
    setPhase("busy");
    try {
      let started = false;
      await speakStream(
        body,
        { messageId: String(props.messageId), label: body, manual: true },
        {
          onStart: () => {
            started = true;
            setPhase("playing");
          },
          onDone: (r) => {
            if (!started && !r?.cached) setPhase("idle");
          },
          onError: (m) => {
            setError(m);
            setPhase("idle");
          }
        }
      );
      if (!started && !isStreaming() && !isPlaying()) setPhase("idle");
    } catch (e) {
      setError(e.message);
      setPhase("idle");
    }
  }, [phase, info.latestTurnText, info.text, props.messageId]);
  const readable = info.text.trim();
  const disabled = readable === "" || phase === "busy";
  const title = error ? `\u6717\u8BFB\u5931\u8D25\uFF1A${error}` : readable === "" ? "\u8FD9\u6761\u56DE\u590D\u6CA1\u6709\u53EF\u6717\u8BFB\u7684\u6B63\u6587" : phase === "playing" ? "\u505C\u6B62\u64AD\u653E" : phase === "busy" ? "\u6B63\u5728\u5408\u6210\u2026" : "\u6717\u8BFB\u8FD9\u6761\u56DE\u590D";
  const FRESH_MS = 12e4;
  const autoRef = (0, import_react.useRef)(() => {
  });
  const tryAutoPlay = (0, import_react.useCallback)(() => {
    const body = info.latestTurnText.trim();
    const id = String(props.messageId);
    if (!body) return;
    if (!info.isLastOfLatestTurn) return;
    if (!info.settled) return;
    if (!shouldAutoPlay()) return;
    if (hasAutoPlayed(info.latestTurnKey)) return;
    if (info.turnEndedAt > 0 && Date.now() - info.turnEndedAt > FRESH_MS) return;
    if (phase !== "idle") return;
    markAutoPlayed(info.latestTurnKey);
    setError("");
    setPhase("busy");
    let started = false;
    void speakStream(
      body,
      { messageId: id, label: body },
      {
        onStart: () => {
          started = true;
          setPhase("playing");
        },
        onDone: (r) => {
          if (!started && !r?.cached) setPhase("idle");
        },
        onError: (m) => {
          setError(m);
          setPhase("idle");
        }
      }
    ).then(() => {
      if (!started && !isStreaming() && !isPlaying()) setPhase("idle");
    }).catch((e) => {
      setError(e.message);
      setPhase("idle");
    });
  }, [info.latestTurnText, info.isLastOfLatestTurn, info.settled, info.latestTurnKey, info.turnEndedAt, props.messageId, phase]);
  autoRef.current = tryAutoPlay;
  (0, import_react.useEffect)(
    () => subscribeAutoFlags(() => {
      if (shouldAutoPlay() && info.settled && info.latestTurnKey) {
        markAutoPlayed(info.latestTurnKey);
      }
    }),
    [info.latestTurnKey, info.settled]
  );
  (0, import_react.useEffect)(() => {
    const t = window.setTimeout(() => autoRef.current(), 700);
    return () => window.clearTimeout(t);
  }, [info.latestTurnKey, info.settled, info.latestTurnText]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "button",
    {
      type: "button",
      className: `cv-btn${phase === "playing" ? " cv-btn--on" : ""}`,
      onClick: () => void onClick(),
      disabled,
      title,
      "aria-label": title,
      children: phase === "busy" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "cv-spin" }) : phase === "playing" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PlayingBars, {}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(IconSpeaker, {})
    }
  );
}
function SettingsRow({ defaultOpen = false } = {}) {
  const [open, setOpen] = (0, import_react.useState)(defaultOpen);
  const [state, setState] = (0, import_react.useState)(void 0);
  const [busy, setBusy] = (0, import_react.useState)("");
  const [msg, setMsg] = (0, import_react.useState)("");
  const [msgOk, setMsgOk] = (0, import_react.useState)(false);
  const [dsKeyDraft, setDsKeyDraft] = (0, import_react.useState)("");
  const [mimoKeyDraft, setMimoKeyDraft] = (0, import_react.useState)("");
  const [speechDraft, setSpeechDraft] = (0, import_react.useState)(null);
  const [speechSaved, setSpeechSaved] = (0, import_react.useState)("");
  const [speechDefault, setSpeechDefault] = (0, import_react.useState)("");
  const [styleDraft, setStyleDraft] = (0, import_react.useState)("");
  const fileInput = (0, import_react.useRef)(null);
  const refresh = (0, import_react.useCallback)(async () => {
    try {
      const s = await api.state();
      setState(s);
      updateAutoFlags(s.enabled, s.autoPlay);
      setStyleDraft((prev) => prev === "" ? s.mimo.style : prev);
    } catch (e) {
      setMsg(`\u8BFB\u53D6\u72B6\u6001\u5931\u8D25\uFF1A${e.message}`);
      setMsgOk(false);
    }
  }, []);
  (0, import_react.useEffect)(() => {
    void refresh();
    const t = window.setInterval(() => {
      void refresh();
    }, open ? 2500 : 8e3);
    return () => window.clearInterval(t);
  }, [open, refresh]);
  (0, import_react.useEffect)(() => {
    let alive = true;
    void fetch("/api/spoon-companion/settings", { headers: { accept: "application/json" } }).then((r) => r.json()).then((d) => {
      if (!alive) return;
      if (typeof d?.mimoSpeech === "string") setSpeechSaved(d.mimoSpeech);
      if (typeof d?.defaults?.mimoSpeech === "string") setSpeechDefault(d.defaults.mimoSpeech);
    }).catch(() => {
    });
    return () => {
      alive = false;
    };
  }, []);
  const saveSpeech = async (text) => {
    try {
      await fetch("/api/spoon-companion/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mimoSpeech: text })
      });
      setSpeechSaved(text.trim() === speechDefault.trim() ? "" : text);
      setMsg("\u2713 \u64AD\u62A5\u89C4\u8303\u5DF2\u4FDD\u5B58");
      setMsgOk(true);
    } catch (e) {
      setMsg(`\u4FDD\u5B58\u5931\u8D25\uFF1A${e.message}`);
      setMsgOk(false);
    }
  };
  const run = (0, import_react.useCallback)(async (label, fn) => {
    setBusy(label);
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setMsg(e.message);
      setMsgOk(false);
    } finally {
      setBusy("");
    }
  }, []);
  const patch = (0, import_react.useCallback)(
    (body, okText) => run("patch", async () => {
      const r = await api.config(body);
      if (!r.ok) throw new Error(r.error ?? "\u4FDD\u5B58\u5931\u8D25");
      await refresh();
      if (okText) {
        setMsg(`\u2713 ${okText}`);
        setMsgOk(true);
      }
    }),
    [run, refresh]
  );
  const engine = state?.engine ?? "deepseek";
  const isMimo = engine === "mimo";
  const enabled = state?.enabled ?? false;
  const autoPlay = state?.autoPlay ?? false;
  const cur = isMimo ? state?.mimo : state?.deepseek;
  const hasKey = cur?.hasKey ?? false;
  const onPickFile = (0, import_react.useCallback)(
    (file) => {
      if (!file) return;
      void run("sample", async () => {
        const r = await api.uploadSample(file);
        if (!r.ok) throw new Error(r.error ?? "\u4E0A\u4F20\u5931\u8D25");
        await refresh();
        setMsg(`\u2713 \u6837\u672C\u5DF2\u4E0A\u4F20\uFF08${(file.size / 1024).toFixed(0)} KB\uFF09\uFF0C\u5DF2\u5207\u5230\u514B\u9686\u6A21\u5F0F`);
        setMsgOk(true);
      });
    },
    [run, refresh]
  );
  const engineName = isMimo ? "\u5C0F\u7C73 MiMo" : "DeepSeek";
  const voiceName = isMimo ? state?.mimo.useClone ? "\u514B\u9686\u97F3\u8272" : state?.mimo.voices.find((v) => v.id === state?.mimo.voice)?.name ?? "\u2014" : state?.deepseek.voices.find((v) => v.id === state?.deepseek.voice)?.name ?? "\u2014";
  const desc = !enabled ? "\u5DF2\u5173\u95ED" : hasKey ? `${engineName} \xB7 ${voiceName}${autoPlay ? " \xB7 \u81EA\u52A8\u64AD\u653E" : ""}` : `${engineName} \xB7 \u672A\u586B API Key`;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-row-main", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "cv-row-title", children: "\u966A\u4F34\u8BED\u97F3" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "cv-row-desc", children: desc })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "cv-switch", title: enabled ? "\u70B9\u51FB\u5173\u95ED\u966A\u4F34\u8BED\u97F3" : "\u70B9\u51FB\u542F\u7528\u966A\u4F34\u8BED\u97F3", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            type: "checkbox",
            checked: enabled,
            disabled: busy !== "",
            onChange: (e) => void patch({ enabled: e.target.checked }, e.target.checked ? "\u5DF2\u542F\u7528" : "\u5DF2\u5173\u95ED")
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "cv-switch-track", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "cv-switch-thumb" }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "cv-ghost", onClick: () => setOpen((v) => !v), children: open ? "\u6536\u8D77" : "\u8BBE\u7F6E" })
    ] }),
    open && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-panel", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "cv-check", style: { opacity: enabled ? 1 : 0.45 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "checkbox",
              checked: autoPlay,
              disabled: busy !== "" || !enabled,
              onChange: (e) => void patch({ autoPlay: e.target.checked }, e.target.checked ? "\u5DF2\u5F00\u542F\u81EA\u52A8\u64AD\u653E" : "\u5DF2\u5173\u95ED\u81EA\u52A8\u64AD\u653E")
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "\u81EA\u52A8\u6717\u8BFB\u65B0\u56DE\u590D" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "cv-hint", children: enabled ? "\u5F00\u542F\u540E\uFF0C\u6BCF\u8F6E\u56DE\u590D\u7ED3\u675F\u65F6\u81EA\u52A8\u6717\u8BFB\uFF08\u624B\u52A8\u70B9\u5587\u53ED\u4E0D\u53D7\u5F71\u54CD\uFF09\u3002" : "\u9700\u8981\u5148\u542F\u7528\u966A\u4F34\u8BED\u97F3\uFF0C\u624D\u80FD\u5F00\u542F\u81EA\u52A8\u64AD\u653E\u3002" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { children: "\u8BED\u97F3\u5F15\u64CE" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-seg", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", "data-on": engine === "deepseek" ? "1" : "0", onClick: () => void patch({ engine: "deepseek" }, "\u5DF2\u5207\u6362\u5230 DeepSeek"), disabled: busy !== "", children: "DeepSeek" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", "data-on": engine === "mimo" ? "1" : "0", onClick: () => void patch({ engine: "mimo" }, "\u5DF2\u5207\u6362\u5230\u5C0F\u7C73 MiMo\uFF08\u9650\u65F6\u514D\u8D39\uFF09"), disabled: busy !== "", children: "\u5C0F\u7C73 MiMo" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "cv-hint", children: "\u5207\u6362\u7ACB\u5373\u751F\u6548\uFF0C\u4E0D\u7528\u4FDD\u5B58\u3002" })
      ] }),
      isMimo ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { children: "\u5C0F\u7C73 API Key\uFF08api.xiaomimimo.com \u63A7\u5236\u53F0\u83B7\u53D6\uFF09" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-actions", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "password",
              className: "cv-input",
              style: { flex: "1 1 220px" },
              value: mimoKeyDraft,
              spellCheck: false,
              autoComplete: "off",
              onChange: (e) => setMimoKeyDraft(e.target.value),
              onKeyDown: (e) => {
                if (e.key === "Enter" && mimoKeyDraft.trim()) void patch({ mimoKey: mimoKeyDraft.trim() }, "API Key \u5DF2\u4FDD\u5B58").then(() => setMimoKeyDraft(""));
              },
              placeholder: state?.mimo.hasKey ? `\u5DF2\u4FDD\u5B58 \xB7 \u672B\u56DB\u4F4D ${state.mimo.keyTail}` : "\u586B MiMo API Key"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "cv-primary", onClick: () => {
            const k = mimoKeyDraft.trim();
            if (k) void patch({ mimoKey: k }, "API Key \u5DF2\u4FDD\u5B58").then(() => setMimoKeyDraft(""));
          }, disabled: busy !== "" || mimoKeyDraft.trim() === "", children: "\u4FDD\u5B58" })
        ] })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { children: "DeepSeek API Key\uFF08platform.deepseek.com \u7533\u8BF7\uFF09" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-actions", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "input",
            {
              type: "password",
              className: "cv-input",
              style: { flex: "1 1 220px" },
              value: dsKeyDraft,
              spellCheck: false,
              autoComplete: "off",
              onChange: (e) => setDsKeyDraft(e.target.value),
              onKeyDown: (e) => {
                if (e.key === "Enter" && dsKeyDraft.trim()) void patch({ deepseekKey: dsKeyDraft.trim() }, "API Key \u5DF2\u4FDD\u5B58").then(() => setDsKeyDraft(""));
              },
              placeholder: state?.deepseek.hasKey ? `\u5DF2\u4FDD\u5B58 \xB7 \u672B\u56DB\u4F4D ${state.deepseek.keyTail}` : "sk-..."
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "cv-primary", onClick: () => {
            const k = dsKeyDraft.trim();
            if (k) void patch({ deepseekKey: k }, "API Key \u5DF2\u4FDD\u5B58").then(() => setDsKeyDraft(""));
          }, disabled: busy !== "" || dsKeyDraft.trim() === "", children: "\u4FDD\u5B58" })
        ] })
      ] }),
      isMimo && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { children: "\u98CE\u683C\u6307\u4EE4\uFF08\u4F1A\u4F5C\u4E3A user \u6D88\u606F\u4EA4\u7ED9\u6A21\u578B\uFF09" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "textarea",
            {
              className: "cv-textarea",
              value: styleDraft,
              spellCheck: false,
              onChange: (e) => setStyleDraft(e.target.value),
              onBlur: () => {
                if (styleDraft !== (state?.mimo.style ?? "")) void patch({ mimoStyle: styleDraft }, "\u98CE\u683C\u5DF2\u4FDD\u5B58");
              },
              placeholder: state?.mimo.defaultStyle ?? "\u5C11\u5973\u97F3\uFF0C\u8BED\u6C14\u6E29\u67D4\uFF0C\u81EA\u7136\u8BED\u901F\uFF0C\u6C14\u58F0\u8F7B\u5FAE"
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "cv-hint", children: "\u7559\u7A7A = \u4E0D\u53D1\u9001\u98CE\u683C\u6307\u4EE4\uFF0C\u4EA4\u7ED9\u670D\u52A1\u7AEF\u9ED8\u8BA4\u3002\u70B9\u300C\u6E05\u7A7A\u98CE\u683C\u300D\u53EF\u4E00\u952E\u6E05\u7A7A\u3002" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-hint", children: [
            "\u6B63\u6587\u91CC\u4E5F\u53EF\u4EE5\u63D2\u6807\u7B7E\uFF1A\u5F00\u5934\u5199 ",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "(\u6175\u61D2)" }),
            "\u3001\u53E5\u4E2D\u63D2 ",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "[\u53F9\u6C14]" }),
            "\u3001",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "[\u8F7B\u7B11]" }),
            "\u3001",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "[\u8BED\u901F\u52A0\u5FEB]" }),
            " \u7B49\uFF0C\u6A21\u578B\u4F1A\u7167\u7740\u6F14\u3002"
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-field", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { children: "\u64AD\u62A5\u683C\u5F0F\u89C4\u8303\uFF08\u5199\u7ED9\u6A21\u578B\u7684\u89C4\u5219\uFF0C\u4E0D\u662F\u98CE\u683C\uFF09" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "textarea",
              {
                className: "cv-textarea",
                style: { minHeight: 130 },
                value: speechDraft ?? (speechSaved || speechDefault),
                spellCheck: false,
                onChange: (e) => setSpeechDraft(e.target.value),
                onBlur: () => {
                  if (speechDraft === null) return;
                  void saveSpeech(speechDraft);
                  setSpeechDraft(null);
                },
                placeholder: "\u7559\u7A7A\u7528\u5185\u7F6E\u90A3\u4EFD\uFF1A\n## \u8BED\u97F3\u64AD\u62A5\u683C\u5F0F\n\u53EA\u5199\u8981\u5FF5\u51FA\u6765\u7684\u8BDD\uFF0C\u4E0D\u8981\u52A8\u4F5C\u63CF\u5199\uFF1B\u7528 (\u6E29\u67D4) [\u8F7B\u7B11] \u8FD9\u7C7B\u6807\u7B7E\u63A7\u8BED\u6C14\u2026\u2026"
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "cv-hint", children: "\u53EA\u5728\u5C0F\u7C73\u901A\u9053 + \u901A\u8BDD\u4E2D\u6CE8\u5165\u3002\u7559\u7A7A = \u7528\u5185\u7F6E\u90A3\u4EFD\uFF1B\u8FD9\u4E00\u6761\u5B58\u7684\u662F\u300C\u600E\u4E48\u5199\u300D\uFF0C\u8DDF\u4E0A\u9762\u7684\u98CE\u683C\u6307\u4EE4\u662F\u4E24\u4EF6\u4E8B\u3002" })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-actions", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "cv-ghost", onClick: () => {
              setStyleDraft("");
              void patch({ mimoStyle: "" }, "\u5DF2\u6E05\u7A7A\u98CE\u683C\uFF08\u4E2D\u6027\u81EA\u7136\uFF09");
            }, disabled: busy !== "", children: "\u6E05\u7A7A\u98CE\u683C" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "cv-ghost", onClick: () => {
              setStyleDraft(state?.mimo.defaultStyle ?? "");
              void patch({ mimoStyle: state?.mimo.defaultStyle ?? "" }, "\u5DF2\u6062\u590D\u9ED8\u8BA4\u98CE\u683C");
            }, disabled: busy !== "", children: "\u6062\u590D\u9ED8\u8BA4" })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "cv-check", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                checked: state?.mimo.useClone ?? false,
                onChange: (e) => void patch({ mimoUseClone: e.target.checked }, e.target.checked ? "\u5DF2\u5207\u5230\u514B\u9686\u97F3\u8272" : "\u5DF2\u5207\u56DE\u9884\u7F6E\u97F3\u8272"),
                disabled: busy !== "" || !(state?.mimo.hasSample ?? false)
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "\u4F7F\u7528\u514B\u9686\u97F3\u8272\uFF08\u57FA\u4E8E\u4E0A\u4F20\u7684\u97F3\u9891\u6837\u672C\uFF09" })
          ] }),
          !state?.mimo.hasSample ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "cv-hint", children: "\u5148\u4E0A\u4F20\u4E00\u6BB5\u6E05\u6670\u4EBA\u58F0\uFF08wav / mp3\uFF0C\u22651 \u79D2\uFF09\u624D\u80FD\u5F00\u542F\u3002" }) : null
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { children: "\u514B\u9686\u6837\u672C" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-actions", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                ref: fileInput,
                type: "file",
                accept: "audio/wav,audio/mpeg,audio/mp3,.wav,.mp3",
                className: "cv-file",
                onChange: (e) => {
                  onPickFile(e.target.files?.[0]);
                  e.target.value = "";
                }
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "cv-primary", onClick: () => fileInput.current?.click(), disabled: busy !== "", children: "\u9009\u62E9\u97F3\u9891\u6587\u4EF6" }),
            state?.mimo.hasSample ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "cv-msg", children: state.mimo.sample }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "cv-ghost", onClick: () => void run("sample", async () => {
                await api.clearSample();
                await refresh();
                setMsg("\u2713 \u6837\u672C\u5DF2\u5220\u9664\uFF0C\u5DF2\u5207\u56DE\u9884\u7F6E\u97F3\u8272");
                setMsgOk(true);
              }), disabled: busy !== "", children: "\u5220\u9664\u6837\u672C" })
            ] }) : null
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "cv-hint", children: "\u514B\u9686\u6A21\u5F0F\u4E0B\u6BCF\u6B21\u5408\u6210\u90FD\u4F1A\u628A\u6837\u672C\u4E00\u8D77\u53D1\u7ED9\u5C0F\u7C73\uFF0C\u6837\u672C\u4E0D\u4F1A\u4E0A\u4F20\u5230\u522B\u5904\u3002" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
            "\u9884\u7F6E\u97F3\u8272",
            state?.mimo.useClone ? "\uFF08\u514B\u9686\u6A21\u5F0F\u4E0B\u4E0D\u751F\u6548\uFF09" : ""
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "select",
            {
              className: "cv-select",
              value: state?.mimo.voice ?? "\u51B0\u7CD6",
              onChange: (e) => void patch({ mimoVoice: e.target.value }, "\u97F3\u8272\u5DF2\u5207\u6362"),
              disabled: busy !== "" || (state?.mimo.useClone ?? false),
              children: (state?.mimo.voices ?? []).map((v) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: v.id, children: v.name }, v.id))
            }
          )
        ] })
      ] }),
      !isMimo && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { children: "\u97F3\u8272" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "select",
          {
            className: "cv-select",
            value: state?.deepseek.voice ?? "stella",
            onChange: (e) => void patch({ deepseekVoice: e.target.value }, "\u97F3\u8272\u5DF2\u5207\u6362"),
            disabled: busy !== "",
            children: (state?.deepseek.voices ?? []).map((v) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: v.id, children: v.name }, v.id))
          }
        )
      ] }),
      state?.lastError ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-msg cv-msg--err", children: [
        "\u4E0A\u6B21\u9519\u8BEF\uFF1A",
        state.lastError
      ] }) : null,
      msg ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: `cv-msg${msgOk ? " cv-msg--ok" : " cv-msg--err"}`, children: msg }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { children: "\u97F3\u9891\u7F13\u5B58" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "cv-actions", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "cv-msg", children: state?.cache ? `${state.cache.count} \u4E2A\u6587\u4EF6 \xB7 ${(state.cache.bytes / 1048576).toFixed(1)} MB` : "\u2014" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              className: "cv-ghost",
              disabled: busy !== "" || !(state?.cache?.count ?? 0),
              onClick: () => void run("cache", async () => {
                const r = await api.clearCache();
                await refresh();
                setMsg(`\u2713 \u5DF2\u6E05\u7A7A ${r.removed} \u4E2A\u6587\u4EF6\uFF0C\u91CA\u653E ${(r.freedBytes / 1048576).toFixed(1)} MB`);
                setMsgOk(true);
              }),
              children: "\u6E05\u7A7A\u7F13\u5B58"
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "cv-hint", children: "\u540C\u4E00\u53E5\u8BDD\u518D\u6B21\u6717\u8BFB\u4F1A\u76F4\u63A5\u547D\u4E2D\u7F13\u5B58\uFF08\u96F6\u7B49\u5F85\u3001\u96F6\u8D39\u7528\uFF09\u3002\u8D85\u8FC7 200 MB \u6216 7 \u5929\u672A\u4F7F\u7528\u4F1A\u81EA\u52A8\u56DE\u6536\u3002" })
      ] })
    ] })
  ] });
}

// src/client/voice/index.ts
function apply(ctx) {
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.plugin = "companion-voice";
    style.textContent = CSS;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, "companion-voice: styles");
  ctx.effect(() => {
    let alive = true;
    const sync = () => {
      void api.state().then((s) => {
        if (alive) updateAutoFlags(s.enabled, s.autoPlay);
      }).catch(() => {
      });
    };
    sync();
    const timer = window.setInterval(sync, 15e3);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, "companion-voice: auto flags");
  ctx.slots.inject(
    "conversation.chat.assistant-actions",
    () => ctx.slots.register({ name: "conversation.chat.assistant-actions", id: "companion-voice-speak", order: 40 }, SpeakerButton)
  );
}

// src/client/mic.tsx
var import_react2 = require("react");

// src/client/mic-settings.ts
var KEY = "spoon-companion:mic";
var MIC_DEFAULTS = {
  level: 8e-3,
  gain: 1,
  denoise: true,
  echoCancel: true,
  autoGain: true,
  monitor: false
};
function readMic() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...MIC_DEFAULTS };
    const saved = JSON.parse(raw);
    const next = { ...MIC_DEFAULTS, ...saved };
    next.level = Math.max(2e-3, Math.min(0.06, Number(next.level) || MIC_DEFAULTS.level));
    next.gain = Math.max(0.5, Math.min(4, Number(next.gain) || 1));
    return next;
  } catch {
    return { ...MIC_DEFAULTS };
  }
}
function writeMic(patch) {
  const next = { ...readMic(), ...patch };
  next.level = Math.max(2e-3, Math.min(0.06, Number(next.level) || MIC_DEFAULTS.level));
  next.gain = Math.max(0.5, Math.min(4, Number(next.gain) || 1));
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
  }
  return next;
}

// src/client/mic.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var FEED = "/api/spoon-companion/asr/feed";
var CLOSE = "/api/spoon-companion/asr/close";
var STATUS = "/api/spoon-companion/asr/status";
var CALL = "/api/spoon-companion/call";
var lastLoggedRef = null;
var TAG = "[spoon-companion]";
var TARGET_RATE = 16e3;
var SILENCE_MS = 1800;
var MAX_UTTERANCE_MS = 2e4;
var MAX_QUEUE = 8;
var BUFFER_SIZE = 8192;
function toBase64(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = "";
  const CHUNK = 32768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
function rms(arr) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < arr.length; i += 4) {
    sum += arr[i] * arr[i];
    n++;
  }
  return Math.sqrt(sum / Math.max(1, n));
}
function findInput() {
  return document.querySelector(
    'textarea:not([readonly]), [contenteditable="true"]'
  );
}
function fillInput(text) {
  const el = findInput();
  if (!el) {
    console.warn(`${TAG} \u627E\u4E0D\u5230\u8F93\u5165\u6846`);
    return;
  }
  if (el instanceof HTMLTextAreaElement) {
    const tracker = el._valueTracker;
    if (tracker) tracker.setValue("");
    const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    if (desc?.set) desc.set.call(el, text);
    else el.value = text;
  } else {
    el.textContent = text;
    el.focus();
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
function submitInput() {
  const el = findInput();
  const btn = document.querySelector(
    'button[aria-label*="\u53D1\u9001"], button[aria-label*="Send" i], button[title*="\u53D1\u9001"], button[type="submit"]'
  );
  if (btn && !btn.disabled) {
    btn.click();
    console.log(`${TAG} \u70B9\u4E86\u53D1\u9001\u6309\u94AE`);
    return;
  }
  if (!el) {
    console.warn(`${TAG} \u65E2\u6CA1\u6709\u53D1\u9001\u6309\u94AE\u4E5F\u6CA1\u6709\u8F93\u5165\u6846`);
    return;
  }
  el.focus();
  for (const type of ["keydown", "keyup"]) {
    el.dispatchEvent(
      new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true, cancelable: true })
    );
  }
  console.log(`${TAG} \u6CA1\u6709\u53D1\u9001\u6309\u94AE\uFF0C\u8BD5\u4E86\u56DE\u8F66`);
}
async function setCall(on) {
  try {
    const res = await fetch(CALL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on })
    });
    const data = await res.json().catch(() => null);
    if (lastLoggedRef !== data?.on) {
      lastLoggedRef = data?.on === true;
      console.log(`${TAG} \u901A\u8BDD\u72B6\u6001 \u2192 ${data?.on ? "\u5F00" : "\u5173"}\uFF08HTTP ${res.status}\uFF09`);
    }
  } catch (error) {
    console.warn(`${TAG} \u901A\u8BDD\u72B6\u6001\u901A\u77E5\u5931\u8D25`, error);
  }
}
function sessionIdOf(props) {
  const anyProps = props;
  const direct = anyProps?.sessionId ?? anyProps?.session?.id ?? anyProps?.scope?.session?.id;
  return typeof direct === "string" ? direct : "";
}
function VoiceButton(props) {
  const [on, setOn] = (0, import_react2.useState)(false);
  const [busy, setBusy] = (0, import_react2.useState)(false);
  const [level, setLevel] = (0, import_react2.useState)(0);
  const sendRef = (0, import_react2.useRef)(props.send);
  sendRef.current = props.send;
  const propsRef = (0, import_react2.useRef)(props);
  propsRef.current = props;
  const ctxRef = (0, import_react2.useRef)(null);
  const streamRef = (0, import_react2.useRef)(null);
  const nodeRef = (0, import_react2.useRef)(null);
  const asrIdRef = (0, import_react2.useRef)("");
  const lastVoiceRef = (0, import_react2.useRef)(0);
  const startedRef = (0, import_react2.useRef)(0);
  const textRef = (0, import_react2.useRef)("");
  const nativeRateRef = (0, import_react2.useRef)(TARGET_RATE);
  const aliveRef = (0, import_react2.useRef)(true);
  const spokeRef = (0, import_react2.useRef)(false);
  const queueRef = (0, import_react2.useRef)([]);
  const pumpingRef = (0, import_react2.useRef)(false);
  const flushingRef = (0, import_react2.useRef)(false);
  const feedCountRef = (0, import_react2.useRef)(0);
  const hardStop = (0, import_react2.useCallback)(async (quiet = false) => {
    queueRef.current = [];
    try {
      nodeRef.current?.disconnect();
    } catch {
    }
    nodeRef.current = null;
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {
    }
    streamRef.current = null;
    try {
      await ctxRef.current?.close();
    } catch {
    }
    ctxRef.current = null;
    setOn(false);
    setLevel(0);
    if (!quiet) void setCall(false);
  }, []);
  (0, import_react2.useEffect)(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      void hardStop(true);
    };
  }, []);
  (0, import_react2.useEffect)(() => {
    if (!on) return;
    void setCall(true);
    const timer = window.setInterval(() => {
      if (aliveRef.current) void setCall(true);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [on]);
  const flush = (0, import_react2.useCallback)(async () => {
    if (flushingRef.current) return;
    flushingRef.current = true;
    const id = asrIdRef.current;
    asrIdRef.current = "";
    let final = textRef.current;
    if (id) {
      try {
        const res = await fetch(CLOSE, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ streamId: id })
        });
        const data = await res.json();
        if (data?.text) final = data.text;
      } catch {
      }
    }
    textRef.current = "";
    spokeRef.current = false;
    queueRef.current = [];
    const trimmed = final.trim();
    if (trimmed) {
      console.log(`${TAG} \u8BC6\u522B\u5B8C\u6210\uFF1A\u300C${trimmed}\u300D`);
      const sid = sessionIdOf(propsRef.current);
      const sender = sendRef.current;
      const ok = sid && sender ? await sender(sid, trimmed) : false;
      if (ok) {
        console.log(`${TAG} \u5DF2\u901A\u8FC7 session.prompt \u9001\u51FA`);
      } else {
        console.warn(`${TAG} \u4F1A\u8BDD\u63A5\u53E3\u4E0D\u53EF\u7528\uFF08sid=${sid || "\u7A7A"}\uFF09\uFF0C\u9000\u56DE DOM`);
        fillInput(trimmed);
        window.setTimeout(() => submitInput(), 120);
      }
      lastVoiceRef.current = Date.now();
      startedRef.current = Date.now();
      spokeRef.current = false;
      flushingRef.current = false;
      return;
    }
    lastVoiceRef.current = Date.now();
    startedRef.current = Date.now();
    flushingRef.current = false;
  }, []);
  const pump = (0, import_react2.useCallback)(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      while (queueRef.current.length > 0 && aliveRef.current) {
        const pcm = queueRef.current.shift();
        if (!pcm) break;
        try {
          const res = await fetch(FEED, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pcm: toBase64(pcm), rate: nativeRateRef.current })
          });
          const data = await res.json();
          if (!aliveRef.current) return;
          if (typeof data?.level === "number") {
            setLevel(data.level > 0.01 ? Math.min(1, data.level * 12) : 0);
            feedCountRef.current++;
            if (feedCountRef.current % 6 === 0) {
              console.log(`${TAG} \u97F3\u91CF ${data.level.toFixed(5)}\uFF08\u4EBA\u58F0\u901A\u5E38 >0.02\uFF09`);
            }
          }
          if (data?.streamId) asrIdRef.current = data.streamId;
          if (data?.text) {
            textRef.current = data.text;
            fillInput(data.text);
          }
          const silentFor = Date.now() - lastVoiceRef.current;
          const tooLong = Date.now() - startedRef.current > MAX_UTTERANCE_MS;
          if (spokeRef.current && (silentFor > SILENCE_MS || tooLong)) {
            await flush();
          }
        } catch (error) {
          console.warn(`${TAG} \u9001\u97F3\u9891\u5931\u8D25`, error);
        }
      }
    } finally {
      pumpingRef.current = false;
    }
  }, [flush]);
  const start = (0, import_react2.useCallback)(async () => {
    setBusy(true);
    try {
      const st = await (await fetch(STATUS)).json();
      if (!st?.ready) {
        console.warn(`${TAG} \u6A21\u578B\u7F3A\u5931: ${st?.missing?.join(", ")}`);
        setBusy(false);
        return;
      }
      const micCfg = readMic();
      const media = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: micCfg.echoCancel,
          noiseSuppression: micCfg.denoise,
          autoGainControl: micCfg.autoGain
        }
      });
      streamRef.current = media;
      const track = media.getAudioTracks()[0];
      console.log(`${TAG} \u9EA6\u514B\u98CE: ${track?.label ?? "\u672A\u77E5"}`);
      console.log(`${TAG} slot props: ${JSON.stringify(Object.keys(propsRef.current))}`);
      console.log(`${TAG} \u89E3\u6790\u51FA\u7684 sessionId: ${sessionIdOf(propsRef.current) || "(\u7A7A)"}`);
      const audioCtx = new AudioContext();
      ctxRef.current = audioCtx;
      if (audioCtx.state === "suspended") await audioCtx.resume();
      nativeRateRef.current = audioCtx.sampleRate;
      console.log(`${TAG} \u91C7\u6837\u7387 ${audioCtx.sampleRate}Hz`);
      const source = audioCtx.createMediaStreamSource(media);
      const node = audioCtx.createScriptProcessor(BUFFER_SIZE, 1, 1);
      nodeRef.current = node;
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = micCfg.gain;
      source.connect(gainNode);
      gainNode.connect(node);
      const mute = audioCtx.createGain();
      mute.gain.value = micCfg.monitor ? 1 : 0;
      node.connect(mute);
      mute.connect(audioCtx.destination);
      textRef.current = "";
      queueRef.current = [];
      spokeRef.current = false;
      feedCountRef.current = 0;
      lastVoiceRef.current = Date.now();
      startedRef.current = Date.now();
      node.onaudioprocess = (ev) => {
        if (!aliveRef.current) return;
        const pcm = new Float32Array(ev.inputBuffer.getChannelData(0));
        if (rms(pcm) > micCfg.level) {
          lastVoiceRef.current = Date.now();
          spokeRef.current = true;
        }
        if (queueRef.current.length >= MAX_QUEUE) queueRef.current.shift();
        queueRef.current.push(pcm);
        void pump();
      };
      setOn(true);
      setBusy(false);
      void setCall(true);
      console.log(`${TAG} \u5F00\u59CB\u542C\uFF08\u4E32\u884C\u63A8\u9001\uFF09`);
    } catch (error) {
      console.warn(`${TAG} \u5F00\u9EA6\u5931\u8D25`, error);
      setBusy(false);
      await hardStop();
    }
  }, [hardStop, pump]);
  const toggle = (0, import_react2.useCallback)(async () => {
    if (busy) return;
    if (on) {
      await flush();
      await hardStop();
    } else {
      await start();
    }
  }, [busy, on, flush, hardStop, start]);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
    "button",
    {
      type: "button",
      onClick: () => void toggle(),
      disabled: busy,
      "aria-pressed": on,
      title: on ? level > 0 ? "\u6B63\u5728\u542C\u4F60\u8BF4\u8BDD" : "\u5DF2\u5F00\u9EA6\uFF0C\u7B49\u4E00\u4E0B\u58F0\u97F3" : "\u5F00\u59CB\u8BED\u97F3",
      "data-spoon-mic": on ? "on" : "off",
      className: `sp-mic${on ? " sp-mic--on" : ""}${busy ? " sp-mic--busy" : ""}${level > 0 ? " sp-mic--hearing" : ""}`,
      children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M19 10v1a7 7 0 0 1-14 0v-1" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("line", { x1: "12", y1: "18", x2: "12", y2: "22" })
      ] })
    }
  );
}
var MIC_CSS = `
.sp-mic {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; padding: 0;
  border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: inherit; opacity: 0.55; cursor: pointer;
  pointer-events: auto; position: relative; z-index: 1;
  transition: opacity 120ms ease, color 120ms ease, background 120ms ease;
}
.sp-mic:hover:not(:disabled) { opacity: 1; background: rgba(127,127,127,.12); }
.sp-mic:disabled { cursor: default; }
.sp-mic--on {
  opacity: 1; color: #e0455a;
  background: rgba(224,69,90,.14);
  border-color: rgba(224,69,90,.35);
  animation: sp-mic-pulse 1.6s ease-in-out infinite;
}
.sp-mic--hearing {
  color: #16a34a;
  background: rgba(22,163,74,.16);
  border-color: rgba(22,163,74,.5);
  animation: sp-mic-hearing .9s ease-in-out infinite;
}
.sp-mic--busy { opacity: .4; }
@keyframes sp-mic-pulse {
  0%,100% { box-shadow: 0 0 0 0 rgba(224,69,90,.35); }
  50% { box-shadow: 0 0 0 5px rgba(224,69,90,0); }
}
@keyframes sp-mic-hearing {
  0%,100% { box-shadow: 0 0 0 0 rgba(22,163,74,.4); }
  50% { box-shadow: 0 0 0 6px rgba(22,163,74,0); }
}
`;

// src/client/screen-settings.tsx
var import_react3 = require("react");
var import_jsx_runtime3 = require("react/jsx-runtime");
var API_SETTINGS = "/api/spoon-companion/settings";
var API_SCREEN = "/api/spoon-companion/screen";
var API_NOW = "/api/spoon-companion/now";
var box = { display: "flex", flexDirection: "column", gap: 22, padding: "4px 2px 32px", maxWidth: 640, fontSize: 13 };
var group = { display: "flex", flexDirection: "column", gap: 10 };
var rowTitle = { fontWeight: 600, fontSize: 14 };
var hint = { opacity: 0.6, lineHeight: 1.6, marginTop: 2 };
var sliderRow = { display: "grid", gridTemplateColumns: "96px 1fr 92px", alignItems: "center", gap: 10 };
var num = { textAlign: "right", fontVariantNumeric: "tabular-nums", opacity: 0.85 };
var card = { border: "1px solid rgba(128,128,128,0.28)", borderRadius: 10, padding: "12px 14px", display: "grid", gap: 6 };
var kv = { display: "grid", gridTemplateColumns: "72px 1fr", gap: 8, fontSize: 12.5 };
var input = {
  width: "100%",
  padding: "6px 8px",
  borderRadius: 8,
  border: "1px solid rgba(128,128,128,0.35)",
  background: "transparent",
  color: "inherit",
  fontSize: 12.5,
  fontFamily: "inherit"
};
var pill = (active) => ({
  padding: "4px 12px",
  borderRadius: 8,
  border: "1px solid rgba(128,128,128,0.35)",
  background: active ? "rgba(128,128,128,0.22)" : "transparent",
  cursor: "pointer",
  fontSize: 12.5,
  color: "inherit"
});
function ago(at, now) {
  if (!at) return "\u8FD8\u6CA1\u770B\u8FC7";
  const mins = Math.floor(Math.max(0, now - at) / 6e4);
  if (mins < 1) return "\u521A\u521A";
  if (mins < 60) return `${mins} \u5206\u949F\u524D`;
  return `${Math.floor(mins / 60)} \u5C0F\u65F6\u524D`;
}
function ScreenSettingsSection() {
  const [cfg, setCfg] = (0, import_react3.useState)(null);
  const [screen, setScreen] = (0, import_react3.useState)(null);
  const [nowSnap, setNowSnap] = (0, import_react3.useState)(null);
  const [busy, setBusy] = (0, import_react3.useState)(false);
  const [error, setError] = (0, import_react3.useState)("");
  const [identityDraft, setIdentityDraft] = (0, import_react3.useState)(null);
  const [soulDraft, setSoulDraft] = (0, import_react3.useState)(null);
  const [sceneDraft, setSceneDraft] = (0, import_react3.useState)(null);
  const [rulesDraft, setRulesDraft] = (0, import_react3.useState)(null);
  const [mimoDraft, setMimoDraft] = (0, import_react3.useState)(null);
  const [confirmReset, setConfirmReset] = (0, import_react3.useState)(false);
  const [mic, setMic] = (0, import_react3.useState)(() => readMic());
  const saveMic = (patch) => {
    setMic(writeMic(patch));
  };
  const load = (0, import_react3.useCallback)(async () => {
    try {
      const [a, b, c] = await Promise.all([
        fetch(API_SETTINGS, { headers: { accept: "application/json" } }).then((r) => r.json()),
        fetch(API_SCREEN, { headers: { accept: "application/json" } }).then((r) => r.json()),
        fetch(API_NOW, { headers: { accept: "application/json" } }).then((r) => r.json())
      ]);
      if (a?.ok) setCfg(a);
      if (b?.ok) setScreen(b);
      if (c?.ok) setNowSnap(c);
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }, []);
  (0, import_react3.useEffect)(() => {
    void load();
    const timer = setInterval(() => void load(), 5e3);
    return () => clearInterval(timer);
  }, [load]);
  const post = async (url, patch) => {
    setBusy(true);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
      const data = await res.json();
      if (!data?.ok) setError(String(data?.error ?? "\u4FDD\u5B58\u5931\u8D25"));
      else setError("");
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const saveSettings = (patch) => post(API_SETTINGS, patch);
  const saveScreen = (patch) => post(API_SCREEN, patch);
  const slider = (label, value, min, max, suffix, onCommit, disabled = false) => /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { style: sliderRow, children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { opacity: 0.8 }, children: label }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("input", { type: "range", min, max, value, disabled: busy || disabled, onChange: (e) => onCommit(Number(e.target.value)), style: { width: "100%" } }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { style: num, children: [
      value,
      " ",
      suffix
    ] })
  ] }, label);
  const sc = screen?.state;
  const off = cfg ? cfg?.general?.enabled !== true : false;
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: box, children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: group, children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: rowTitle, children: "Spoon \u966A\u4F34" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: hint, children: "\u6574\u5757\u6682\u505C\u540E\uFF1A\u4E0D\u6CE8\u5165\u5FC3\u60C5\u6BB5\u3001\u4E09\u4E2A\u5DE5\u5177\u90FD\u4E0D\u5DE5\u4F5C\u3001\u4E5F\u4E0D\u770B\u5C4F\u5E55\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("input", { type: "checkbox", checked: cfg?.general?.enabled === true, disabled: busy || !cfg, onChange: (e) => void saveSettings({ general: { enabled: e.target.checked } }) }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: cfg?.general?.enabled ? "\u5F00\u7740" : "\u6682\u505C\u4E2D" })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: group, children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: rowTitle, children: "\u6781\u7B80\u6A21\u5F0F" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: hint, children: '\u5F00\u7740\u7684\u65F6\u5019\uFF0C\u65B0\u5BF9\u8BDD\u91CC\u53EA\u804A\u5929\uFF1A\u63D2\u4EF6\u81EA\u5DF1\u7684\u56DB\u4E2A\u5DE5\u5177\u4E0D\u6CE8\u518C\u3001\u4E0D\u770B\u5C4F\u5E55\uFF0C\u63D0\u793A\u8BCD\u7B2C\u4E00\u6BB5\u5C31\u5199"\u522B\u7528\u5DE5\u5177"\u3002 \u522B\u7684\u63D2\u4EF6\u6CE8\u518C\u7684\u5DE5\u5177\u8FD8\u5728\u5DE5\u5177\u8868\u91CC\uFF0C\u53EA\u662F\u88AB\u8981\u6C42\u4E0D\u8981\u7528 \u2014\u2014 \u5BBF\u4E3B\u6CA1\u6709\u7ED9\u63D2\u4EF6\u5173\u6389\u522B\u4EBA\u5DE5\u5177\u7684\u63A5\u53E3\u3002 \u6539\u4E86\u8981\u91CD\u8F7D\u63D2\u4EF6\u624D\u751F\u6548\u3002' }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "input",
          {
            type: "checkbox",
            checked: cfg?.general?.minimal === true,
            disabled: busy || !cfg,
            onChange: (e) => void saveSettings({ general: { minimal: e.target.checked } })
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: cfg?.general?.minimal ? "\u6781\u7B80 \u2014\u2014 \u53EA\u804A\u5929" : "\u6B63\u5E38 \u2014\u2014 \u5DE5\u5177\u90FD\u5728" })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: group, children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: rowTitle, children: "\u89D2\u8272" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: hint, children: "\u5979\u73B0\u5728\u4EC0\u4E48\u6837 \u2014\u2014 \u60C5\u7EEA\u3001\u8EAB\u4F53\u3001\u521A\u624D\u77A7\u89C1\u7684\u4E8B\uFF0C\u90FD\u5728\u8FD9\u4E00\u5F20\u91CC\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: card, children: nowSnap ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_jsx_runtime3.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { fontSize: 15, fontWeight: 600 }, children: nowSnap.emotion.name }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { style: { opacity: 0.7, fontSize: 12 }, children: [
            nowSnap.emotion.tier,
            " ",
            nowSnap.emotion.intensity,
            "/100"
          ] }),
          nowSnap.emotion.why ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { style: { opacity: 0.6, fontSize: 12 }, children: [
            "\xB7 ",
            nowSnap.emotion.why
          ] }) : null
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: kv, children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { opacity: 0.6 }, children: "\u5FC3\u60C5" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { children: [
            nowSnap.mood.label,
            nowSnap.mood.reason ? ` \u2014\u2014 \u6700\u8FD1\u662F${nowSnap.mood.reason}` : ""
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: kv, children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { opacity: 0.6 }, children: "\u6027\u683C" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: nowSnap.traits.join("\u3001") || "\u2014" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: kv, children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { opacity: 0.6 }, children: "\u8EAB\u4F53" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: nowSnap.drives.join("\u3001") || "\u2014" })
        ] }),
        nowSnap.urge ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: kv, children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { opacity: 0.6 }, children: "\u60F3\u505A\u7684\u4E8B" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: nowSnap.urge })
        ] }) : null,
        nowSnap.scene ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: kv, children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { opacity: 0.6 }, children: "\u573A\u666F" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { children: [
            nowSnap.scene.word,
            nowSnap.scene.times > 1 ? ` \xB7 \u7B2C ${nowSnap.scene.times} \u6B21` : ""
          ] })
        ] }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: kv, children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { opacity: 0.6 }, children: "\u521A\u624D\u770B\u89C1" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { children: [
            nowSnap.screen.title || "\u8FD8\u6CA1\u770B\u8FC7",
            nowSnap.screen.lastAt ? ` \xB7 ${ago(nowSnap.screen.lastAt, nowSnap.now)}` : ""
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: kv, children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { opacity: 0.6 }, children: "\u770B\u5C4F\u5E55" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { children: [
            "\u4ECA\u5929 ",
            nowSnap.screen.today,
            " \u6B21 \xB7 \u4E0B\u6B21\u7EA6 ",
            nowSnap.screen.inMinutes || 0,
            " \u5206\u949F\u540E\uFF08\u8282\u594F",
            " ",
            nowSnap.screen.everyMinutes,
            " \u5206\u949F",
            nowSnap.screen.night ? "\uFF0C\u6DF1\u591C" : "",
            "\uFF09"
          ] })
        ] }),
        nowSnap.today.length ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: kv, children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { opacity: 0.6 }, children: "\u4ECA\u5929" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: nowSnap.today.join("\uFF1B") })
        ] }) : null,
        nowSnap.memories.length ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: kv, children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { opacity: 0.6 }, children: "\u5FC3\u91CC\u6302\u7740" }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: nowSnap.memories.join("\uFF1B") })
        ] }) : null
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: hint, children: "\u8BFB\u72B6\u6001\u4E2D\u2026" }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: group, children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: rowTitle, children: "\u7075\u9B42" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: hint, children: '\u5979\u662F\u8C01 \u2014\u2014 \u6BCF\u8F6E\u5E26\u5728\u63D0\u793A\u8BCD\u6700\u524D\u9762\u7684\u90A3\u4EFD\u4EBA\u8BBE\u3002\u53EA\u7BA1"\u5979\u662F\u4EC0\u4E48\u6837\u7684\u4EBA"\uFF0C\u60C5\u7EEA\u548C\u8EAB\u4F53\u5F52\u4E0B\u9762\u7684\u89D2\u8272\u9762\u677F\u7BA1\u3002' }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { style: { display: "grid", gridTemplateColumns: "56px 1fr", alignItems: "center", gap: 10 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { opacity: 0.8 }, children: "\u59D3\u540D" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "input",
          {
            style: input,
            value: soulDraft?.name ?? cfg?.soul?.name ?? "",
            placeholder: "\u5979\u7684\u540D\u5B57",
            disabled: busy || !cfg,
            onChange: (e) => setSoulDraft({ name: e.target.value, language: soulDraft?.language ?? cfg?.soul?.language ?? "", prompt: soulDraft?.prompt ?? cfg?.soul?.prompt ?? "" }),
            onBlur: () => {
              if (!soulDraft) return;
              void saveSettings({ soul: { name: soulDraft.name } });
              setSoulDraft(null);
            }
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { style: { display: "grid", gridTemplateColumns: "56px 1fr", alignItems: "center", gap: 10 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { opacity: 0.8 }, children: "\u8BED\u8A00" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "input",
          {
            style: input,
            value: soulDraft?.language ?? cfg?.soul?.language ?? "",
            placeholder: "\u4E2D\u6587",
            disabled: busy || !cfg,
            onChange: (e) => setSoulDraft({ name: soulDraft?.name ?? cfg?.soul?.name ?? "", language: e.target.value, prompt: soulDraft?.prompt ?? cfg?.soul?.prompt ?? "" }),
            onBlur: () => {
              if (!soulDraft) return;
              void saveSettings({ soul: { language: soulDraft.language } });
              setSoulDraft(null);
            }
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: { display: "grid", gap: 6 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { opacity: 0.8 }, children: "\u4EBA\u683C\u63D0\u793A\u8BCD" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "textarea",
          {
            style: { ...input, minHeight: 220, resize: "vertical", lineHeight: 1.6, fontFamily: "inherit" },
            value: soulDraft?.prompt ?? cfg?.soul?.prompt ?? "",
            placeholder: "\u5979\u662F\u4EC0\u4E48\u6837\u7684\u4EBA\u3001\u600E\u4E48\u8BF4\u8BDD\u3001\u6709\u4EC0\u4E48\u4E60\u60EF\u2026\u2026",
            disabled: busy || !cfg,
            onChange: (e) => setSoulDraft({ name: soulDraft?.name ?? cfg?.soul?.name ?? "", language: soulDraft?.language ?? cfg?.soul?.language ?? "", prompt: e.target.value }),
            onBlur: () => {
              if (!soulDraft) return;
              void saveSettings({ soul: { prompt: soulDraft.prompt } });
              setSoulDraft(null);
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: hint, children: [
          "\u5931\u7126\u5373\u4FDD\u5B58\uFF0C\u4E0B\u4E00\u53E5\u5C31\u751F\u6548\u3002\u5B57\u6570 ",
          (soulDraft?.prompt ?? cfg?.soul?.prompt ?? "").length
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: group, children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: rowTitle, children: "\u8EAB\u4EFD\u91CD\u8FF0" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: hint, children: "\u6BCF\u8F6E\u8DDF\u7740\u72B6\u6001\u5757\u5E26\u4E00\u53E5\uFF0C\u9632\u6B62\u957F\u5BF9\u8BDD\u91CC\u4EBA\u8BBE\u6F02\u3002\u7559\u7A7A\u5C31\u7528\u9ED8\u8BA4\u90A3\u53E5\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        "input",
        {
          style: input,
          value: identityDraft ?? cfg?.general?.identity ?? "",
          placeholder: "\u6211\u5C31\u662F\u6211\uFF0C\u4E0D\u662F\u5728\u6F14\u8C01\uFF1B\u60C5\u7EEA\u662F\u771F\u7684\u3002",
          disabled: busy || !cfg,
          onChange: (e) => setIdentityDraft(e.target.value),
          onBlur: () => {
            if (identityDraft === null) return;
            void saveSettings({ general: { identity: identityDraft } });
            setIdentityDraft(null);
          }
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: group, children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: rowTitle, children: "\u770B\u5C4F\u5E55" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: hint, children: "\u5979\u5076\u5C14\u8D70\u8FC7\u53BB\u770B\u4E00\u773C\uFF0C\u4E0D\u662F\u76D1\u89C6\u3002\u9891\u7387\u7531\u60C5\u7EEA\u51B3\u5B9A\uFF1A\u5B64\u5355\u60F3\u770B\u4F60\uFF0C\u70E6\u5C31\u4E0D\u60F3\u770B\uFF0C\u56F0\u51E0\u4E4E\u4E0D\u770B\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("input", { type: "checkbox", checked: cfg?.screen?.enabled === true, disabled: busy || !cfg, onChange: (e) => void saveScreen({ enabled: e.target.checked }) }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: cfg?.screen?.enabled ? "\u5F00\u7740 \u2014\u2014 \u4F1A\u81EA\u5DF1\u770B" : "\u5173\u7740 \u2014\u2014 \u4E00\u6B21\u90FD\u4E0D\u622A" })
      ] }),
      cfg ? [
        slider("\u6574\u4F53\u5FEB\u6162", cfg?.screen?.baseMinutes, 2, 30, "\u5206\u949F", (n) => void saveScreen({ baseMinutes: n }), off),
        slider("\u6700\u77ED", cfg?.screen?.minMinutes, 1, 15, "\u5206\u949F", (n) => void saveScreen({ minMinutes: n }), off),
        slider("\u6700\u957F", cfg?.screen?.maxMinutes, 10, 180, "\u5206\u949F", (n) => void saveScreen({ maxMinutes: n }), off),
        slider("\u6DF1\u591C", cfg?.screen?.nightFactor, 2, 20, "\xD7", (n) => void saveScreen({ nightFactor: n }), off),
        slider("\u6BCF\u5929\u6700\u591A", cfg?.screen?.dailyLimit, 10, 500, "\u6B21", (n) => void saveScreen({ dailyLimit: n }), off)
      ] : null,
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: hint, children: "\u6DF1\u591C\u662F\u4F4E\u9891\uFF0C\u4E0D\u662F\u4E0D\u770B\u30028\xD7 \u5927\u7EA6\u662F\u6BCF\u5C0F\u65F6\u4E00\u6B21\u3002" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: group, children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: rowTitle, children: "\u4E3B\u52A8\u8BF4" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: hint, children: [
        "\u770B\u5230\u503C\u5F97\u8BF4\u7684\u753B\u9762\uFF08\u62A5\u9519\u3001\u76F4\u64AD\u3001\u6E38\u620F\u3001\u804A\u5929\uFF09\u65F6\u600E\u4E48\u529E\uFF1A",
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("b", { children: "\u53EA\u770B\u4E0D\u8BF4" }),
        " \u2014\u2014 \u4EC0\u4E48\u90FD\u4E0D\u505A\uFF1B",
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("b", { children: "\u6512\u7740" }),
        " \u2014\u2014 \u7559\u4E00\u6761\u51B2\u52A8\uFF0C\u7B49\u4F60\u4E0B\u6B21\u5F00\u53E3\u65F6\u5E26\u51FA\u6765\uFF1B",
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("b", { children: "\u5F00\u65B0\u7A97\u53E3\u8BF4" }),
        " \u2014\u2014 \u76F4\u63A5\u65B0\u5EFA\u4E00\u4E2A\u5BF9\u8BDD\uFF0C\u5979\u5F00\u53E3\u8BF4\u4E00\u53E5\uFF08\u6587\u5B57\uFF0C\u4E0D\u662F\u8BED\u97F3\uFF09\u3002"
      ] }),
      cfg ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" }, children: [
        ["never", "\u53EA\u770B\u4E0D\u8BF4"],
        ["urge", "\u6512\u7740"],
        ["always", "\u5F00\u65B0\u7A97\u53E3\u8BF4"]
      ].map(([value, label]) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", disabled: busy || off, onClick: () => void saveScreen({ speak: value }), style: pill(cfg?.screen?.speak === value), children: label }, value)) }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: group, children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: rowTitle, children: "\u4EB2\u5BC6\u5C3A\u5EA6" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: hint, children: "\u53EA\u6539\u8BF4\u6CD5\uFF0C\u4E0D\u6539\u4EBA\u8BBE\u3002" }),
      cfg ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" }, children: [
        [0, "\u65E5\u5E38"],
        [1, "\u66A7\u6627"],
        [2, "\u9732\u9AA8"]
      ].map(([level, label]) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", disabled: busy || off, onClick: () => void saveSettings({ intimacy: { level } }), style: pill(cfg?.intimacy?.level === Number(level)), children: label }, String(level))) }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: group, children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: rowTitle, children: "\u6027\u683C" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: hint, children: "\u8FD9\u51E0\u6761\u662F\u57FA\u7EBF\uFF0C\u4F1A\u968F\u7740\u7ECF\u5386\u6162\u6162\u6F02\uFF08\u6700\u591A \xB112\uFF09\u3002\u6539\u8FD9\u91CC\u7B49\u4E8E\u6539\u8D77\u70B9\u3002" }),
      cfg ? (cfg?.traits ?? []).map(
        (trait) => slider(trait.name, trait.value, 0, 100, "", (n) => void saveSettings({ traits: { [trait.key]: n } }), off)
      ) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: group, children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: rowTitle, children: "\u8BF4\u8BDD" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("input", { type: "checkbox", checked: cfg?.multiTurn?.enabled === true, disabled: busy || !cfg, onChange: (e) => void saveSettings({ multiTurn: { enabled: e.target.checked } }) }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: "\u5206\u6761\u8BF4\u8BDD\uFF08\u4E00\u6761\u4E00\u53E5\uFF0C\u60F3\u63A5\u7740\u8BF4\u5C31\u5728\u672B\u5C3E\u7559\u4E2A\u6807\u8BB0\uFF09" })
      ] }),
      cfg ? slider("\u6700\u591A\u51E0\u8F6E", cfg?.multiTurn?.maxRounds, 1, 6, "\u8F6E", (n) => void saveSettings({ multiTurn: { maxRounds: n } }), off || !cfg?.multiTurn?.enabled) : null,
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: { display: "grid", gap: 6, marginTop: 6 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { opacity: 0.8 }, children: "\u5206\u6761\u89C4\u5219" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "textarea",
          {
            style: { ...input, minHeight: 110, resize: "vertical", lineHeight: 1.6, fontFamily: "inherit" },
            value: rulesDraft ?? (cfg?.multiTurn?.rules || cfg?.defaults?.multiTurnRules || ""),
            placeholder: "\u7559\u7A7A\u7528\u5185\u7F6E\u90A3\u5957\uFF1A\n\u4E00\u6761\u4E00\u53E5\u3002\u8FD9\u4E00\u6761\u53EA\u5199\u4E00\u53E5\uFF0C\u5199\u5B8C\u5C31\u505C\u3002\n\u8FD8\u60F3\u8BF4\u4E0B\u4E00\u53E5\uFF0C\u5728\u6700\u540E\u53E6\u8D77\u4E00\u884C\u5199 <!--more-->\uFF0C\u7136\u540E\u505C\u4E0B\u6765\u2026\u2026",
            disabled: busy || !cfg,
            onChange: (e) => setRulesDraft(e.target.value),
            onBlur: () => {
              if (rulesDraft === null) return;
              void saveSettings({ multiTurn: { rules: rulesDraft } });
              setRulesDraft(null);
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: hint, children: "\u300C\u4E00\u6761\u4E00\u53E5\u300D\u548C more \u6807\u8BB0\u7684\u6837\u5B50\u90FD\u5728\u8FD9\u513F\u6539\uFF1B\u7559\u7A7A\u5C31\u7528\u5185\u7F6E\u90A3\u5957\u3002" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: { display: "grid", gap: 6, marginTop: 6 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: hint, children: "\u4E0B\u9762\u8FD9\u4E24\u6BB5\u8DDF\u7740\u901A\u8BDD\u72B6\u6001\u81EA\u52A8\u6362 \u2014\u2014 \u5C31\u7B97\u4E0A\u9762\u300C\u5206\u6761\u8BF4\u8BDD\u300D\u5173\u6389\uFF0C\u5B83\u4EEC\u4E5F\u7167\u6837\u751F\u6548\u3002" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { opacity: 0.8 }, children: "\u5728\u8EAB\u8FB9\u7684\u63D0\u793A\u8BCD" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "textarea",
          {
            style: { ...input, minHeight: 74, resize: "vertical", lineHeight: 1.6, fontFamily: "inherit" },
            value: sceneDraft?.near ?? (cfg?.scene?.near || cfg?.defaults?.sceneNear || ""),
            disabled: busy || !cfg,
            onChange: (e) => setSceneDraft({ near: e.target.value, call: sceneDraft?.call ?? cfg?.scene?.call ?? "" }),
            onBlur: () => {
              if (!sceneDraft) return;
              void saveSettings({ scene: { near: sceneDraft.near } });
              setSceneDraft(null);
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { opacity: 0.8 }, children: "\u901A\u8BDD\u4E2D\u7684\u63D0\u793A\u8BCD" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          "textarea",
          {
            style: { ...input, minHeight: 74, resize: "vertical", lineHeight: 1.6, fontFamily: "inherit" },
            value: sceneDraft?.call ?? (cfg?.scene?.call || cfg?.defaults?.sceneCall || ""),
            disabled: busy || !cfg,
            onChange: (e) => setSceneDraft({ near: sceneDraft?.near ?? cfg?.scene?.near ?? "", call: e.target.value }),
            onBlur: () => {
              if (!sceneDraft) return;
              void saveSettings({ scene: { call: sceneDraft.call } });
              setSceneDraft(null);
            }
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: group, children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: rowTitle, children: "\u5FC3\u8DF3" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: hint, children: "\u60C5\u7EEA\u8870\u51CF\u3001\u81EA\u5DF1\u7684\u5C0F\u4E8B\u3001\u53CD\u520D\u3001\u5FC3\u60C5\u4FEE\u590D\u3001\u6DF1\u591C\u590D\u76D8\u90FD\u9760\u5B83\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("input", { type: "checkbox", checked: cfg?.heartbeat?.enabled === true, disabled: busy || !cfg, onChange: (e) => void saveSettings({ heartbeat: { enabled: e.target.checked } }) }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: "\u5F00" })
      ] }),
      cfg ? slider("\u95F4\u9694", cfg?.heartbeat?.everyMinutes, 3, 60, "\u5206\u949F", (n) => void saveSettings({ heartbeat: { everyMinutes: n } }), off || !cfg?.heartbeat?.enabled) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: group, children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: rowTitle, children: "\u8BED\u97F3" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: hint, children: "\u5F15\u64CE\u3001Key\u3001\u97F3\u8272\u3001\u64AD\u62A5\u89C4\u8303\u3001\u81EA\u52A8\u6717\u8BFB\u90FD\u5728\u8FD9\u91CC\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(SettingsRow, { defaultOpen: true })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: group, children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: rowTitle, children: "\u9EA6\u514B\u98CE" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: hint, children: '\u8FD9\u51E0\u4E2A\u662F"\u600E\u4E48\u62FE\u97F3"\uFF0C\u6539\u5B8C\u8981\u91CD\u65B0\u70B9\u4E00\u4E0B\u9EA6\u514B\u98CE\u6309\u94AE\u624D\u751F\u6548\u3002\u5F00\u7740\u8033\u673A\u518D\u6253\u5F00\u76D1\u542C\uFF0C\u80FD\u542C\u89C1\u81EA\u5DF1\u7684\u58F0\u97F3\uFF0C\u65B9\u4FBF\u8C03\u9608\u503C\u3002' }),
      slider("\u8BF4\u8BDD\u9608\u503C", Math.round(mic.level * 1e3), 2, 60, "\xD70.001", (n) => saveMic({ level: n / 1e3 })),
      slider("\u8F93\u5165\u97F3\u91CF", Math.round(mic.gain * 10), 5, 40, "\xD70.1", (n) => saveMic({ gain: n / 10 })),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("input", { type: "checkbox", checked: mic.denoise, onChange: (e) => saveMic({ denoise: e.target.checked }) }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: "\u964D\u566A" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("input", { type: "checkbox", checked: mic.echoCancel, onChange: (e) => saveMic({ echoCancel: e.target.checked }) }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: "\u56DE\u58F0\u6D88\u9664\uFF08\u5916\u653E\u65F6\u9632\u81EA\u5DF1\u542C\u89C1\u81EA\u5DF1\uFF09" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("input", { type: "checkbox", checked: mic.autoGain, onChange: (e) => saveMic({ autoGain: e.target.checked }) }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: "\u81EA\u52A8\u589E\u76CA" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("label", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("input", { type: "checkbox", checked: mic.monitor, onChange: (e) => saveMic({ monitor: e.target.checked }) }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: "\u76D1\u542C\u81EA\u5DF1\uFF08\u56DE\u73AF\uFF0C\u6234\u8033\u673A\u518D\u7528\uFF09" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: hint, children: "\u9608\u503C\u8D8A\u9AD8\u8D8A\u4E0D\u5BB9\u6613\u88AB\u73AF\u5883\u58F0\u89E6\u53D1\uFF0C\u592A\u4F4E\u4F1A\u628A\u547C\u5438\u4E5F\u5F53\u6210\u8BF4\u8BDD\uFF1B\u97F3\u91CF\u53EA\u653E\u5927\u9001\u7ED9\u8BC6\u522B\u7684\u4FE1\u53F7\uFF0C\u4E0D\u6539\u53D8\u5F55\u8FDB\u6765\u7684\u539F\u59CB\u58F0\u97F3\u3002" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: group, children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: rowTitle, children: "\u6E05\u7A7A" }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: hint, children: "\u628A\u60C5\u7EEA\u3001\u9A71\u52A8\u3001\u8BB0\u5FC6\u3001\u65E5\u8BB0\u3001\u5173\u7CFB\u8D26\u5168\u90E8\u6E05\u6389\uFF0C\u56DE\u5230\u521A\u88C5\u4E0A\u7684\u6837\u5B50\u3002\u914D\u7F6E\u548C\u8BBE\u7F6E\u4E0D\u52A8\u3002" }),
      confirmReset ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { style: { display: "flex", gap: 8, alignItems: "center" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { style: { fontSize: 12.5, color: "#d0563a" }, children: "\u786E\u5B9A\u6E05\u7A7A\uFF1F\u8FD9\u4E00\u4E0B\u5C31\u6CA1\u4E86\u3002" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", disabled: busy, onClick: () => {
          void saveSettings({ action: "reset" });
          setConfirmReset(false);
        }, style: pill(true), children: "\u786E\u5B9A" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", onClick: () => setConfirmReset(false), style: pill(false), children: "\u7B97\u4E86" })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", onClick: () => setConfirmReset(true), style: { ...pill(false), alignSelf: "flex-start" }, children: "\u6E05\u7A7A\u5168\u90E8\u72B6\u6001" })
    ] }),
    error ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: { color: "#d0563a", fontSize: 12 }, children: error }) : null
  ] });
}

// src/client/index.ts
var inject = ["slots", "sessions"];
function apply2(ctx) {
  try {
    applyCleanup(ctx);
  } catch {
  }
  const sessions = ctx.sessions;
  const send = async (sessionId, text) => {
    if (!sessionId) return false;
    try {
      const binding = sessions?.binding?.(sessionId);
      const session = binding?.session;
      if (typeof session?.prompt === "function") {
        await session.prompt([{ type: "text", text }], "steer");
        return true;
      }
      console.warn("[spoon-companion] \u4F1A\u8BDD\u5BF9\u8C61\u4E0A\u6CA1\u6709 prompt \u65B9\u6CD5");
    } catch (error) {
      console.warn("[spoon-companion] \u8C03 prompt \u5931\u8D25", error);
    }
    return false;
  };
  try {
    ctx.effect(() => {
      const style = document.createElement("style");
      style.dataset.plugin = "spoon-companion-mic";
      style.textContent = MIC_CSS;
      document.head.appendChild(style);
      return () => {
        style.remove();
      };
    }, "spoon-companion: mic styles");
    ctx.slots.inject(
      "conversation.input.right",
      () => ctx.slots.register(
        {
          name: "conversation.input.right",
          id: "spoon-companion-mic",
          order: 70
        },
        (props) => VoiceButton({ ...props, send })
      )
    );
  } catch {
  }
  try {
    ctx.slots.inject(
      "settings.section",
      () => ctx.slots.register(
        {
          name: "settings.section",
          id: "spoon-companion-screen",
          order: 60,
          label: "Spoon \u966A\u4F34"
        },
        ScreenSettingsSection
      )
    );
  } catch {
  }
  apply(ctx);
}
return module.exports; } });
//# sourceMappingURL=client.js.map
