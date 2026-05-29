import { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from "react";

// ════════════════════════════════════════════════════════════════════════════
// § BUILD-TIME FLAG — wycina dane DEMO z bundla produkcyjnego (MUST FIX #3)
// ════════════════════════════════════════════════════════════════════════════
//
// Vite zastąpi __VELARFLOW_DEMO__ wartością literałową w czasie buildu:
//   • dev / preview → true   (DEMO_USERS, MOCK_OWNERS, MOCK_APARTMENTS w bundlu)
//   • production    → false  (Terser wytnie cały blok jako dead code)
//
// Wymaga konfiguracji w vite.config.js (patrz /docs/build-flags.md):
//   define: { __VELARFLOW_DEMO__: JSON.stringify(process.env.MODE !== "production") }
//
// Fallback bez Vite (CRA, Artifact, plain Node): jeśli zmienna jest niezdefiniowana,
// wpada na true — czyli zawsze widać dane demo. To bezpieczne dla developmentu.
// W produkcji MUSI być zdefiniowana, inaczej hasło Demo#2026! trafi do bundla.
// ════════════════════════════════════════════════════════════════════════════
// eslint-disable-next-line no-undef
const __DEMO_BUILD__ = (typeof __VELARFLOW_DEMO__ !== "undefined") ? __VELARFLOW_DEMO__ : true;

// ════════════════════════════════════════════════════════════════════════════
// § CONFIG — jeden centralny obiekt konfiguracji (#61)
// ════════════════════════════════════════════════════════════════════════════
const CONFIG = Object.freeze({
  supabase: {
    url:     "https://YOUR_PROJECT.supabase.co",
    anonKey: "YOUR_ANON_KEY",
  },
  timeouts: {
    fetch:        10_000,
    fetchRetry:   15_000,
    refresh:       8_000,
    refreshMutex: 12_000,
    signOut:       5_000,
    toast:         3_500,
    debounce:        150,
  },
  limits: {
    payloadBytes:    50_000,
    queueMaxSize:       100,
    queueTtlMs:   7 * 24 * 60 * 60 * 1000,
    queueMaxRetries:      3,
    auditMaxEntries:    200,
    auditEntryMaxBytes: 500,
    auditPruneDays:      30,
    storageMaxKB:        64,
    loginMaxAttempts:     5,
    loginBlockMs:   15 * 60 * 1000,
    sanitizeMaxDepth:    10,
    rateLimiterPrunMs: 24 * 60 * 60 * 1000,
  },
  // FIX #20 + MUST-3: twardsze sprawdzenie środowiska
  // isDemo === true tylko gdy URL Supabase jest placeholderem ORAZ build to dev
  isDemo: (() => {
    const url = "https://YOUR_PROJECT.supabase.co";
    const urlLooksDemo = !url.startsWith("https://")
      || url.includes("YOUR_PROJECT")
      || url.includes("placeholder")
      || url === "https://YOUR_PROJECT.supabase.co";
    // Produkcyjny build z prawdziwym URL → isDemo=false bez wyjątków
    return urlLooksDemo && __DEMO_BUILD__;
  })(),
});

// ════════════════════════════════════════════════════════════════════════════
// § TYPES — runtime type guards (#60)
// Zastępują TypeScript w środowisku bez kompilatora.
// ════════════════════════════════════════════════════════════════════════════
const is = {
  string:   (v) => typeof v === "string",
  number:   (v) => typeof v === "number" && !isNaN(v),
  object:   (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  array:    (v) => Array.isArray(v),
  nonEmpty: (v) => typeof v === "string" && v.trim().length > 0,
  positiveInt: (v) => Number.isInteger(v) && v > 0,

  // Runtime guards dla kluczowych kształtów danych
  session: (v) =>
    is.object(v) &&
    is.string(v.access_token) && v.access_token.length > 10 &&
    is.string(v.refresh_token) && v.refresh_token.length > 0 &&
    is.number(v.expires_at),

  user: (v) =>
    is.object(v) &&
    is.nonEmpty(v.email) &&
    is.nonEmpty(v.role) &&
    is.nonEmpty(v.name),

  dbResult: (v) => is.object(v) && typeof v.ok === "boolean",

  queueOp: (v) =>
    is.object(v) &&
    ["insert", "update", "delete"].includes(v.op) &&
    is.nonEmpty(v.table),
};

const assert = (condition, message) => {
  if (!condition) throw new AppError(message, "validation");
};

// ════════════════════════════════════════════════════════════════════════════
// § ERRORS — jeden standard error shape (#27, #28, #29)
// ════════════════════════════════════════════════════════════════════════════

// Jednolita mapa statusów HTTP (#17, #24)
const HTTP_STATUS = {
  400: { type: "validation",  msg: "Nieprawidłowe dane" },
  401: { type: "auth",        msg: "Sesja wygasła — zaloguj się ponownie" },
  403: { type: "forbidden",   msg: "Brak dostępu" },
  404: { type: "not_found",   msg: "Zasób nie istnieje" },
  409: { type: "conflict",    msg: "Konflikt danych — odśwież stronę" },
  422: { type: "validation",  msg: "Dane nie przeszły walidacji serwera" },
  429: { type: "rate_limit",  msg: "Zbyt wiele żądań — poczekaj chwilę" },
  500: { type: "server",      msg: "Błąd serwera (500)" },
  502: { type: "server",      msg: "Serwer niedostępny (502)" },
  503: { type: "server",      msg: "Serwis czasowo niedostępny (503)" },
};

class AppError extends Error {
  // FIX #28: jeden sposób rzucania błędów w całej aplikacji
  constructor(message, type = "unknown", context = "", status = null) {
    super(message);
    this.name = "AppError";
    this.type = type;       // auth | forbidden | validation | not_found | conflict | rate_limit | server | network | timeout | unknown
    this.context = context;
    this.status = status;
  }

  // Fabryki — czytelne w kodzie
  static auth    (msg, ctx)       { return new AppError(msg || HTTP_STATUS[401].msg, "auth",       ctx, 401); }
  static forbidden(msg, ctx)      { return new AppError(msg || HTTP_STATUS[403].msg, "forbidden",  ctx, 403); }
  static network (msg, ctx)       { return new AppError(msg || "Brak połączenia",    "network",    ctx); }
  static timeout (ctx)            { return new AppError("Timeout połączenia",        "timeout",    ctx); }
  static server  (status, ctx)    { return new AppError((HTTP_STATUS[status] || {}).msg || `HTTP ${status}`, "server", ctx, status); }
  static validation(msg, ctx)     { return new AppError(msg,                         "validation", ctx); }

  // FIX #3: klasyfikuje dowolny błąd → AppError
  // Używa type field i errType, nie msg.includes()
  static from(err, context = "") {
    if (err instanceof AppError) return err.context ? err : new AppError(err.message, err.type, context, err.status);

    // DbResult (ok:false)
    if (is.dbResult(err) && !err.ok) {
      if (err.status && HTTP_STATUS[err.status]) return new AppError(HTTP_STATUS[err.status].msg, HTTP_STATUS[err.status].type, context, err.status);
      return new AppError(err.message || "Błąd operacji", err.type || "unknown", context, err.status);
    }

    // Native Error z errType ustawionym przez _fetch
    if (err && err.errType === "timeout") return AppError.timeout(context);
    if (err && err.errType === "network") return AppError.network(err.message, context);

    return new AppError(err && err.message || String(err), "unknown", context);
  }

  // FIX #25: rozróżnienie user vs system errors
  isUserError()   { return ["validation", "not_found", "conflict"].includes(this.type); }
  isSystemError() { return ["server", "network", "timeout", "rate_limit"].includes(this.type); }
  isAuthError()   { return ["auth", "forbidden"].includes(this.type); }

  toToast() {
    const icons = { auth:"🔐", forbidden:"🚫", validation:"⚠️", not_found:"🔍", conflict:"🔄", rate_limit:"⏱", timeout:"⏱", network:"📡", server:"🔴", unknown:"⚠" };
    return { msg: `${icons[this.type] || "⚠"} ${this.message}`, type: this.type };
  }
}

// FIX #26: DbResult — spójny z AppError
const DbResult = {
  ok:   (data)         => ({ ok: true, data }),
  fail: (appError)     => ({ ok: false, error: appError }),
  fromHttpStatus: (status, context) => DbResult.fail(
    status && HTTP_STATUS[status]
      ? new AppError(HTTP_STATUS[status].msg, HTTP_STATUS[status].type, context, status)
      : AppError.server(status || 500, context)
  ),
};

// FIX #29: centralny logger — jeden punkt logowania
const Logger = {
  warn:  (ctx, msg, ...args) => console.warn(`[${ctx}]`, msg, ...args),
  error: (ctx, msg, ...args) => console.error(`[${ctx}]`, msg, ...args),
  info:  (ctx, msg, ...args) => console.info(`[${ctx}]`, msg, ...args),
};

// ════════════════════════════════════════════════════════════════════════════
// § STORAGE — izolowany wrapper localStorage (#41–#44)
// ════════════════════════════════════════════════════════════════════════════
const Storage = {
  _ns: "velarflow:",           // namespace prefix (#44)
  _maxKB: CONFIG.limits.storageMaxKB,

  // FIX #42: obsługa QuotaExceededError
  _write(key, value) {
    try {
      const serialized = JSON.stringify(value);
      // FIX #17: limit w bajtach (nie długości stringa) (#17)
      const bytes = new Blob([serialized]).size;
      if (bytes > this._maxKB * 1024) {
        Logger.warn("Storage", `Key "${key}" too large: ${bytes} B, skipping`);
        return false;
      }
      localStorage.setItem(this._ns + key, serialized);
      return true;
    } catch (e) {
      if (e && e.name === "QuotaExceededError" || e && e.code === 22) {
        Logger.warn("Storage", "QuotaExceeded — triggering cleanup");
        this._emergencyCleanup();
        // retry once
        try { localStorage.setItem(this._ns + key, JSON.stringify(value)); return true; } catch { return false; }
      }
      return false;
    }
  },

  _read(key) {
    try {
      const raw = localStorage.getItem(this._ns + key);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },

  // secure: obfuskacja base64 (nie szyfrowanie — jawna dokumentacja) (#16)
  setSecure(key, value) {
    try {
      const json = JSON.stringify(value);
      return this._write("sec:" + key, btoa(encodeURIComponent(json)));
    } catch { return false; }
  },
  getSecure(key) {
    try {
      const raw = this._read("sec:" + key);
      return raw ? JSON.parse(decodeURIComponent(atob(raw))) : null;
    } catch { return null; }
  },
  removeSecure(key) { try { localStorage.removeItem(this._ns + "sec:" + key); } catch {} },

  get(key)          { return this._read(key); },
  set(key, value)   { return this._write(key, value); },
  remove(key)       { try { localStorage.removeItem(this._ns + key); } catch {} },

  // FIX #8: prefix-scan (nie hardcoded lista)
  // FIX #44: tylko nasz namespace
  clearSecure() {
    const keys = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(this._ns + "sec:")) keys.push(k); } } catch {}
    keys.forEach(k => { try { localStorage.removeItem(k); } catch {} });
  },

  // FIX #22/#42: globalny cleanup
  cleanup() {
    this._pruneAudit();
    this._pruneQueue();
    this._pruneRateLimiter();
    this._migrateLegacyKeys();
  },

  // MUST-4: jednorazowa migracja kluczy storage.
  // Stara konwencja: domain services używały kluczy "velarflow_X" przekazywanych
  // do Storage.set, co wraps'owało je w "velarflow:velarflow_X" (duplikacja prefixu).
  // Nowa konwencja: Storage._ns = "velarflow:" jest jedynym prefiksem, klucze są krótkie.
  //
  // Mapa migracyjna: stary realny klucz w localStorage → nowy realny klucz.
  // Jeśli nowy istnieje (już zmigrowane), pomijamy. Stary klucz usuwamy.
  // Bezpieczne do wielokrotnego wywołania (idempotent).
  _migrateLegacyKeys() {
    const migrations = {
      "velarflow:velarflow_categories":  "velarflow:categories",
      "velarflow:velarflow_loans":       "velarflow:loans",
      "velarflow:velarflow_files":       "velarflow:files",
      "velarflow:velarflow_form_schema": "velarflow:form_schema",
      "velarflow:velarflow_equip_rooms": "velarflow:equip_rooms",
      "velarflow:velarflow_settings":    "velarflow:settings",
      "velarflow:velarflow_cleaning":    "velarflow:cleaning",
      "velarflow:velarflow_theme":       "velarflow:theme",
    };
    try {
      for (const [oldKey, newKey] of Object.entries(migrations)) {
        const oldVal = localStorage.getItem(oldKey);
        if (oldVal === null) continue;            // nic do migracji
        const newVal = localStorage.getItem(newKey);
        if (newVal === null) {
          localStorage.setItem(newKey, oldVal);
          Logger.info("Storage:migrate", `${oldKey} → ${newKey}`);
        }
        localStorage.removeItem(oldKey);
      }
    } catch (e) {
      Logger.warn("Storage:migrate", "failed:", e?.message);
    }
  },

  _pruneAudit() {
    try {
      const cutoff = new Date(Date.now() - CONFIG.limits.auditPruneDays * 86400000).toISOString();
      const all = this._read("audit") || [];
      this._write("audit", all.filter(e => is.string(e.ts) && e.ts > cutoff));
    } catch { /* storage may throw in incognito/quota */ }
  },

  _pruneQueue() {
    try {
      const cutoff = Date.now() - CONFIG.limits.queueTtlMs;
      const q = this._read("queue") || [];
      // FIX #11: safe date parsing
      this._write("queue", q.filter(op => {
        try { return new Date(op.ts).getTime() > cutoff; } catch { return false; }
      }));
    } catch { /* storage may throw in incognito/quota */ }
  },

  _pruneRateLimiter() {
    try {
      const data = this._read("rate") || {};
      const cutoff = Date.now() - CONFIG.limits.rateLimiterPrunMs;
      for (const k of Object.keys(data)) {
        if (is.number((data[k] || {}).lastAttempt) && data[k].lastAttempt < cutoff) delete data[k];
      }
      this._write("rate", data);
    } catch { /* storage may throw in incognito/quota */ }
  },

  _emergencyCleanup() {
    // Usuwa najstarsze wpisy audit i queue jeśli brakuje miejsca
    try { const a = this._read("audit") || []; this._write("audit", a.slice(0, 50)); } catch { /* ignore */ }
    try { this._write("queue", []); } catch { /* ignore */ }
  },

  // FIX #41: globalny rozmiar storage (przybliżony)
  getUsageKB() {
    let total = 0;
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(this._ns)) total += (localStorage.getItem(k) || "").length * 2; } } catch {}
    return Math.round(total / 1024);
  },
};

// ════════════════════════════════════════════════════════════════════════════
// § AUDIT LOG (#9)
// ════════════════════════════════════════════════════════════════════════════
const Audit = {
  log(action, user, details = {}) {
    try {
      // FIX #50: jeden JSON.stringify per wpis, nie dwa
      const entry = {
        ts:     new Date().toISOString(),
        action: String(action).slice(0, 50),
        user:   String(user && user.email || "?").slice(0, 100),
        role:   String(user && user.role  || "?").slice(0, 20),
      };
      // FIX #9: limit rozmiaru wpisu
      const detailsStr = JSON.stringify(details);
      if (detailsStr.length < CONFIG.limits.auditEntryMaxBytes - 100) Object.assign(entry, details);
      else entry._truncated = true;

      const all = Storage.get("audit") || [];
      all.unshift(entry);
      Storage.set("audit", all.slice(0, CONFIG.limits.auditMaxEntries));
    } catch {}
  },
  getRecent(n = 50) { return (Storage.get("audit") || []).slice(0, n); },
};

// ════════════════════════════════════════════════════════════════════════════
// § SANITIZE (#1, #2)
// ════════════════════════════════════════════════════════════════════════════

// FIX #1: usunięto HTML-encoding → data corruption. React escapuje przy render.
// Tylko znaki kontrolne i zero-width.
// FIX MUST-2: eslint-disable no-control-regex — to jest *cel* tej funkcji (sanitizer).
const stripCtrl = (v) => {
  if (!is.string(v)) return v;
  return v
    // eslint-disable-next-line no-control-regex
    .replace(/\x00/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
};

// FIX #1: cykliczne referencje przez WeakSet (#1), limit głębokości z sygnalizacją (#2)
const sanitize = (obj, _seen = new WeakSet(), depth = 0) => {
  if (is.string(obj))   return stripCtrl(obj);
  if (!is.object(obj) && !is.array(obj)) return obj;

  // FIX #1: ochrona przed circular refs
  if (is.object(obj) || is.array(obj)) {
    if (_seen.has(obj)) return "[Circular]";
    _seen.add(obj);
  }

  // FIX #2: limit z komunikatem (nie ciche ucięcie)
  if (depth >= CONFIG.limits.sanitizeMaxDepth) {
    Logger.warn("sanitize", `Max depth ${CONFIG.limits.sanitizeMaxDepth} reached`);
    return "[MaxDepth]";
  }

  if (is.array(obj)) return obj.map(i => sanitize(i, _seen, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = sanitize(v, _seen, depth + 1);
  return out;
};

// FIX #15: ochrona przed DoS przez zagnieżdżone payloady (#15)
const checkPayload = (data) => {
  try {
    const bytes = new Blob([JSON.stringify(data)]).size;
    if (bytes > CONFIG.limits.payloadBytes) throw AppError.validation(`Payload zbyt duży: ${bytes} B (max ${CONFIG.limits.payloadBytes})`);
  } catch (e) { if (e instanceof AppError) throw e; }
};

// ════════════════════════════════════════════════════════════════════════════
// § RATE LIMITER (#4, #18)
// ════════════════════════════════════════════════════════════════════════════
const RateLimiter = {
  // FIX #4: walidacja struktury odczytu — ochrona przed manipulacją
  _valid: (r) => is.object(r) && is.number(r.attempts) && r.attempts >= 0 && r.attempts <= CONFIG.limits.loginMaxAttempts + 1,

  _load() { return Storage.get("rate") || {}; },
  _save(d) { Storage.set("rate", d); },

  check(email) {
    const data = this._load(), r = data[email.toLowerCase()];
    if (!this._valid(r)) return { allowed: true };
    if (is.number(r.blockedUntil) && Date.now() < r.blockedUntil) {
      const mins = Math.ceil((r.blockedUntil - Date.now()) / 60000);
      return { allowed: false, message: `Za dużo prób. Poczekaj ${mins} min.` };
    }
    return { allowed: true };
  },

  record(email, success) {
    const data = this._load(), key = email.toLowerCase();
    if (success) { delete data[key]; this._save(data); return; }
    const r = this._valid(data[key]) ? { ...data[key] } : { attempts: 0 };
    r.attempts = Math.min(r.attempts + 1, CONFIG.limits.loginMaxAttempts + 1);
    r.lastAttempt = Date.now();
    if (r.attempts >= CONFIG.limits.loginMaxAttempts) {
      r.blockedUntil = Date.now() + CONFIG.limits.loginBlockMs;
      r.attempts = 0;
    }
    data[key] = r; this._save(data);
  },

  remaining(email) {
    const r = this._load()[email.toLowerCase()];
    return this._valid(r) ? Math.max(0, CONFIG.limits.loginMaxAttempts - r.attempts) : CONFIG.limits.loginMaxAttempts;
  },
};

// ════════════════════════════════════════════════════════════════════════════
// § AUTH MANAGER — globalny, jeden stan, getValidSession() (#1, #2, #3)
//
// ARCHITEKTURA SESJI:
//   Demo:       in-memory (_session) + sessionStorage (tab-scoped, nie localStorage)
//   Produkcja:  PKCE flow przez proxy → token w HttpOnly cookie
//
// PKCE PROXY (deploy na Supabase Edge lub Cloudflare Worker):
// ─────────────────────────────────────────────────────────────
// export default async function handler(req) {
//   const { code, code_verifier } = await req.json();
//   const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
//     method: "POST",
//     headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
//     body: JSON.stringify({ auth_code: code, code_verifier }),
//   });
//   const data = await res.json();
//   return new Response(JSON.stringify({ user: data.user }), {
//     headers: {
//       "Set-Cookie": `sb_token=${data.access_token}; HttpOnly; Secure; SameSite=Strict; Path=/`,
//       "Content-Type": "application/json",
//     },
//   });
// }
// ─────────────────────────────────────────────────────────────
//
// SUPABASE RLS (wklej w Dashboard → SQL Editor):
// ─────────────────────────────────────────────────────────────
// -- Tylko zalogowani mogą SELECT
// ALTER TABLE apartments ENABLE ROW LEVEL SECURITY;
// CREATE POLICY "auth_read" ON apartments FOR SELECT USING (auth.role()='authenticated');
// CREATE POLICY "manager_write" ON apartments FOR ALL USING (auth.jwt()->>'role'='manager');
// ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
// CREATE POLICY "auth_read" ON tasks FOR SELECT USING (auth.role()='authenticated');
// CREATE POLICY "manager_write" ON tasks FOR ALL USING (auth.jwt()->>'role'='manager');
// CREATE POLICY "worker_own" ON tasks FOR UPDATE USING (assigned_to=auth.jwt()->>'name');
// ALTER TABLE owners ENABLE ROW LEVEL SECURITY;
// CREATE POLICY "manager_only" ON owners FOR ALL USING (auth.jwt()->>'role'='manager');
// -- Constraints
// ALTER TABLE apartments ADD CONSTRAINT name_len CHECK (char_length(name) <= 80);
// ALTER TABLE tasks ADD CONSTRAINT title_len CHECK (char_length(title) <= 200);
// ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

// ── BroadcastChannel — pełna obsługa LOGIN/LOGOUT/SESSION_EXPIRED (#8) ──────
let _tabChannel = null;
const _broadcastAuth = (type, payload = {}) => {
  try { _tabChannel && _tabChannel.postMessage({ type, ts: Date.now(), ...payload }); } catch {}
};
try {
  if (typeof BroadcastChannel !== "undefined") {
    _tabChannel = new BroadcastChannel("velarflow_auth");
  }
} catch {}

// ── isExpired — pełna walidacja struktury sesji ──────────────────────────────
const isExpired = (session) => {
  if (!is.session(session)) return true;
  return Date.now() / 1000 > session.expires_at - 60;
};

// ── Session storage — sessionStorage (tab-scoped) zamiast localStorage (#1) ─
// sessionStorage: wygasa przy zamknięciu taba, nie między tabami → bezpieczniejszy
// niż localStorage, ale mniej bezpieczny niż HttpOnly cookie.
// Przy produkcji (PKCE proxy) token nie trafia do JS w ogóle.
const SessionStore = {
  _key: "velarflow_session",
  save(session) {
    try {
      if (!is.session(session)) return;
      sessionStorage.setItem(this._key, btoa(encodeURIComponent(JSON.stringify(session))));
    } catch {}
  },
  load() {
    try {
      const raw = sessionStorage.getItem(this._key);
      if (!raw) return null;
      const parsed = JSON.parse(decodeURIComponent(atob(raw)));
      return is.session(parsed) ? parsed : null;
    } catch { return null; }
  },
  clear() { try { sessionStorage.removeItem(this._key); } catch {} },
};

// ── Refresh mutex — module-level Promise (#6) ───────────────────────────────
let _refreshPromise = null;

const _doRefresh = async (session) => {
  if (!is.session(session)) return null;
  if (_refreshPromise) return _refreshPromise;

  const ctrl = new AbortController();
  let mutexTimer;

  const timeout$ = new Promise((_, rej) => {
    mutexTimer = setTimeout(() => {
      _refreshPromise = null;
      ctrl.abort();
      rej(AppError.timeout("refresh_mutex"));
    }, CONFIG.timeouts.refreshMutex);
  });

  _refreshPromise = Promise.race([
    (async () => {
      try {
        const fetchTimer = setTimeout(() => ctrl.abort(), CONFIG.timeouts.refresh);
        const res = await fetch(`${CONFIG.supabase.url}/auth/v1/token?grant_type=refresh_token`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "apikey": CONFIG.supabase.anonKey },
          body: JSON.stringify({ refresh_token: session.refresh_token }),
          signal: ctrl.signal,
        });
        clearTimeout(fetchTimer);

        // #5: rozróżnienie 401/403 vs inne błędy HTTP
        if (res.status === 401 || res.status === 403) {
          throw AppError.auth("Token odświeżania wygasł — wymagane ponowne logowanie");
        }
        if (!res.ok) throw AppError.server(res.status, "refresh");

        const data = await safeJson(res, "refresh");
        // #5: walidacja struktury
        if (!is.session(data)) {
          Logger.warn("refresh", "Invalid session structure returned:", Object.keys(data || {}));
          throw AppError.server(200, "refresh:invalid_structure");
        }

        SessionStore.save(data);
        _broadcastAuth("SESSION_REFRESHED");
        return data;
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw AppError.from(e, "refresh");
      } finally {
        _refreshPromise = null;
        clearTimeout(mutexTimer);
      }
    })(),
    timeout$,
  ]).catch(e => {
    _refreshPromise = null;
    Logger.warn("refresh:failed", e.message);
    throw e; // re-throw — caller decyduje o logout (#3)
  });

  return _refreshPromise;
};

// ── Auth Manager — jeden globalny stan (#2) ──────────────────────────────────
// Eksportuje: getValidSession(), currentUser, isAuthenticated
const AuthManager = (() => {
  // Prywatny stan — zmutowany tylko przez Auth operacje
  let _session = null;
  let _currentUser = null;
  let _listeners = new Set(); // notyfikacje dla useAuthState hooka

  const _notify = (event) => _listeners.forEach(fn => { try { fn(event); } catch {} });

  // ── getValidSession() — jeden punkt dostępu do sesji (#2) ─────────────────
  // Zawsze zwraca świeżą sesję albo wymusza logout.
  // Nigdy nie zwraca null po cichu (#3).
  const getValidSession = async () => {
    // 1. In-memory (najszybsze)
    if (_session && !isExpired(_session)) return _session;

    // 2. SessionStorage fallback
    const stored = SessionStore.load();
    if (stored && !isExpired(stored)) {
      _session = stored;
      return _session;
    }

    // 3. Refresh
    const toRefresh = stored || _session;
    if (!toRefresh || !toRefresh.refresh_token) {
      // #3: fail-safe — brak tokenu → natychmiastowy logout
      _forceLogout("no_refresh_token");
      throw AppError.auth("Brak tokenu sesji — zaloguj się ponownie");
    }

    try {
      const refreshed = await _doRefresh(toRefresh);
      _session = refreshed;
      _broadcastAuth("SESSION_REFRESHED");
      return refreshed;
    } catch (e) {
      // #3: KAŻDY błąd refresh → natychmiastowy logout + clear + redirect
      _forceLogout("refresh_failed");
      throw e instanceof AppError ? e : AppError.auth("Sesja wygasła — zaloguj się ponownie");
    }
  };

  // #3: twarde reguły logout — clear + notify
  const _forceLogout = (reason = "") => {
    Logger.info("AuthManager", `Force logout: ${reason}`);
    _session = null;
    _currentUser = null;
    _refreshPromise = null;
    SessionStore.clear();
    Storage.clearSecure();
    Storage.cleanup();
    _broadcastAuth("LOGOUT", { reason });
    _notify({ type: "LOGOUT", reason });
  };

  return {
    // ── Publiczne API ────────────────────────────────────────────────────────
    getValidSession,

    get currentUser() { return _currentUser; },
    get isAuthenticated() { return !!_currentUser; },

    // Nagłówki dla API requestów — sync (czyta z in-memory lub sessionStorage)
    getHeaders() {
      const s = (_session && !isExpired(_session)) ? _session : SessionStore.load();
      const h = {
        "Content-Type": "application/json",
        "apikey": CONFIG.supabase.anonKey,
        "Prefer": "return=representation",
      };
      if (s && s.access_token) h["Authorization"] = `Bearer ${s.access_token}`;
      return h;
    },

    // Subscribe na zmiany auth state (dla hooka useAuthState)
    subscribe(fn) { _listeners.add(fn); return () => _listeners.delete(fn); },

    // ── Sign In ───────────────────────────────────────────────────────────────
    async signIn(email, password) {
      // Rate limit check
      const check = RateLimiter.check(email);
      if (!check.allowed) throw new AppError(check.message, "rate_limit");

      const res = await apiRequest({
        method: "POST",
        path: "/auth/v1/token?grant_type=password",
        body: { email: email.toLowerCase().trim(), password },
        auth: false, // nie potrzeba tokenu przy logowaniu
        retries: 0,
      });

      const data = await safeJson(res, "signIn");
      if (!data || data.error) {
        RateLimiter.record(email, false);
        const rem = RateLimiter.remaining(email);
        const msg = (data && data.error_description || "Nieprawidłowy e-mail lub hasło")
          + (rem > 0 ? ` (pozostało prób: ${rem})` : "");
        throw new AppError(msg, "auth");
      }
      if (!is.session(data)) throw new AppError("Nieoczekiwana odpowiedź serwera", "server");

      RateLimiter.record(email, true);
      _session = data;
      SessionStore.save(data);

      const meta = data.user && data.user.user_metadata || {};
      _currentUser = {
        id:    data.user.id,
        email: data.user.email,
        role:  meta.role  || ROLES.WORKER,
        name:  meta.name  || data.user.email.split("@")[0],
      };

      Audit.log("LOGIN", _currentUser);
      _broadcastAuth("LOGIN", { email: _currentUser.email });
      _notify({ type: "LOGIN", user: _currentUser });
      return _currentUser;
    },

    // ── Sign In Demo ──────────────────────────────────────────────────────────
    signInDemo(email, password) {
      const check = RateLimiter.check(email);
      if (!check.allowed) throw new AppError(check.message, "rate_limit");

      const user = DEMO_USERS.find(u =>
        u.email === email.toLowerCase() && u.password === password
      );
      if (!user) {
        RateLimiter.record(email, false);
        const rem = RateLimiter.remaining(email);
        throw new AppError(
          `Nieprawidłowy e-mail lub hasło${rem < 5 ? ` (pozostało prób: ${rem})` : ""}`,
          "auth"
        );
      }

      RateLimiter.record(email, true);
      // Demo: sesja syntetyczna, in-memory only
      const fakeSession = {
        access_token: `demo_${Math.random().toString(36).slice(2)}`,
        refresh_token: `demo_refresh_${Math.random().toString(36).slice(2)}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600 * 8, // 8h
        user: { id: user.email, email: user.email, user_metadata: { role: user.role, name: user.name } },
      };
      _session = fakeSession;
      _currentUser = { id: user.email, email: user.email, role: user.role, name: user.name };

      Audit.log("LOGIN_DEMO", _currentUser);
      _broadcastAuth("LOGIN", { email: user.email });
      _notify({ type: "LOGIN", user: _currentUser });
      return _currentUser;
    },

    // ── Sign Out ──────────────────────────────────────────────────────────────
    async signOut() {
      Audit.log("LOGOUT", _currentUser);
      const s = _session;
      _forceLogout("user_initiated");

      // Best-effort server logout (nie blokuje UI)
      if (s && s.access_token && !CONFIG.isDemo) {
        try {
          const t = withTimeout(CONFIG.timeouts.signOut);
          await fetch(`${CONFIG.supabase.url}/auth/v1/logout`, {
            method: "POST",
            headers: { "apikey": CONFIG.supabase.anonKey, "Authorization": `Bearer ${s.access_token}` },
            signal: t.signal,
          });
          t.clear();
        } catch {}
      }
    },

    // ── Internal — używane przez apiRequest ────────────────────────────────────
    _forceLogout,
  };
})();

// ════════════════════════════════════════════════════════════════════════════
// § API CLIENT — centralny punkt wszystkich requestów (#4)
//
// apiRequest({ method, path, body, auth, retries, signal, ctx })
// → zawsze zwraca DbResult { ok, data } | { ok:false, error: AppError }
//
// Auto: token attach → auto-refresh → retry (tylko network) → timeout → interpret
// ════════════════════════════════════════════════════════════════════════════

const withTimeout = (ms) => {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(id) };
};

const safeJson = async (res, ctx = "") => {
  if (!res) { Logger.warn("safeJson", ctx, "undefined response"); return null; }
  let text = "";
  try {
    text = await res.text();
    if (!text.trim()) return null;
    return JSON.parse(text);
  } catch {
    Logger.warn("safeJson", ctx, `parse failed (status=${res && res.status}):`, text.slice(0, 150));
    return null;
  }
};

// #5: jeden format odpowiedzi dla WSZYSTKICH ścieżek
const interpretResponse = async (res, ctx) => {
  if (!res) return DbResult.fail(AppError.network("Brak odpowiedzi", ctx));
  if (res.ok) {
    const data = await safeJson(res, ctx);
    return DbResult.ok(data);
  }
  if (HTTP_STATUS[res.status]) return DbResult.fromHttpStatus(res.status, ctx);
  if (res.status >= 500) return DbResult.fromHttpStatus(500, ctx);
  return DbResult.fail(AppError.server(res.status, ctx));
};

/**
 * Centralny klient API — JEDYNA funkcja robiąca fetch w całej aplikacji (#4)
 *
 * @param {object} opts
 * @param {"GET"|"POST"|"PATCH"|"DELETE"} opts.method
 * @param {string}  opts.path         - relatywna ścieżka, np. "/rest/v1/apartments"
 * @param {object}  [opts.body]       - JSON body
 * @param {boolean} [opts.auth=true]  - czy dołączyć Authorization header
 * @param {number}  [opts.retries=1]  - liczba retry (tylko network errors)
 * @param {AbortSignal} [opts.signal] - zewnętrzny AbortSignal (unmount cleanup #13)
 * @param {string}  [opts.ctx]        - kontekst do logów
 * @returns {Promise<DbResult>}
 */
const apiRequest = async ({
  method = "GET",
  path,
  body,
  auth = true,
  retries = 1,
  signal: externalSignal,
  ctx = path,
}) => {
  // #16: checkPayloadSize dla każdego zapisu
  if (body && (method === "POST" || method === "PATCH")) {
    try { checkPayload(body); }
    catch (e) { return DbResult.fail(AppError.from(e, ctx)); }
  }

  const url = path.startsWith("http") ? path : `${CONFIG.supabase.url}${path}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // #13: łączymy wewnętrzny timeout z zewnętrznym signalem (unmount)
    const timeoutMs = attempt > 0 ? CONFIG.timeouts.fetchRetry : CONFIG.timeouts.fetch;
    const { signal: timeoutSignal, clear: clearTimer } = withTimeout(timeoutMs);

    // Łączymy dwa sygnały jeśli jest zewnętrzny
    let signal = timeoutSignal;
    let combinedController = null;
    if (externalSignal) {
      combinedController = new AbortController();
      const abort = () => combinedController.abort();
      externalSignal.addEventListener("abort", abort, { once: true });
      timeoutSignal.addEventListener("abort", abort, { once: true });
      signal = combinedController.signal;
    }

    try {
      // Pobierz ważny token (auto-refresh jeśli potrzeba)
      let headers = { "Content-Type": "application/json", "apikey": CONFIG.supabase.anonKey, "Prefer": "return=representation" };
      if (auth) {
        try {
          const session = await AuthManager.getValidSession();
          headers["Authorization"] = `Bearer ${session.access_token}`;
        } catch (authErr) {
          // getValidSession() już wywołał _forceLogout, re-throw dla callera
          clearTimer();
          return DbResult.fail(authErr instanceof AppError ? authErr : AppError.auth(undefined, ctx));
        }
      }

      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
      clearTimer();

      // #16: retry dla 5xx i 429 (transient)
      const retryable = (res.status === 429 || (res.status >= 500 && res.status < 600)) && attempt < retries;
      if (retryable) {
        const retryAfterHdr = res.headers && typeof res.headers.get === "function" ? res.headers.get("Retry-After") : null;
        const after = parseInt(retryAfterHdr || "0") * 1000;
        const wait = after > 0 ? after : Queue._backoff(attempt);
        await new Promise(r => setTimeout(r, Math.min(wait, 30_000)));
        continue;
      }

      // #1: jeśli 401 → force logout
      if (res.status === 401) {
        AuthManager._forceLogout("401_from_api");
        return DbResult.fail(AppError.auth(undefined, ctx));
      }

      return interpretResponse(res, ctx);

    } catch (err) {
      clearTimer();
      const extAborted = externalSignal && externalSignal.aborted;
      const isAbort = err && err.name === "AbortError";
      const isUnmount = isAbort && extAborted;          // abort pochodzi z zewnętrz
      const isTimeout = isAbort && !extAborted;          // abort pochodzi z timeoutu

      if (isUnmount) return DbResult.fail(AppError.from(Object.assign(new Error("Request cancelled"), { errType: "cancelled" }), ctx));
      if (isTimeout) {
        if (attempt === retries) return DbResult.fail(AppError.timeout(ctx));
        continue;
      }
      if (attempt === retries) return DbResult.fail(AppError.network(err.message, ctx));
      await new Promise(r => setTimeout(r, Queue._backoff(attempt)));
    }
  }
  return DbResult.fail(AppError.network("Przekroczono limit prób", ctx));
};

// ════════════════════════════════════════════════════════════════════════════
// § OFFLINE QUEUE — produkcyjna wersja (#6)
//
// Każda operacja ma:
//   updated_at  — wersjonowanie (conflict: last-write-wins)
//   status      — pending | syncing | failed
//   clientId    — idempotencja INSERT
//   retries     — licznik prób
//   lastRetry   — timestamp ostatniej próby
// ════════════════════════════════════════════════════════════════════════════

const Queue = (() => {
  let _flushing = false; // mutex

  const _norm    = (f) => String(f || "").trim().toLowerCase().replace(/\s+/g, "");
  const _backoff = (n)  => { const b = Math.min(1000 * Math.pow(2, n), 30_000); return Math.floor(b + Math.random() * 0.3 * b); };

  const _load = () => {
    // #13 (Storage): ochrona przed uszkodzonym JSON już w Storage._read
    return Storage.get("queue") || [];
  };
  const _save = (q) => Storage.set("queue", q);

  const _withTtl = (q) => {
    const cutoff = Date.now() - CONFIG.limits.queueTtlMs;
    return q.filter(op => { try { return new Date(op.ts).getTime() > cutoff; } catch { return false; } });
  };

  return {
    _backoff, // eksponowane dla apiRequest

    getAll()  { return _withTtl(_load()); },
    size()    { return _load().length; },

    /**
     * Enqueue operacji DB z walidacją i statusem.
     * #6: każdy rekord ma updated_at i status: pending
     */
    enqueue(op) {
      if (!is.queueOp(op)) { Logger.warn("Queue", "invalid op:", op); return null; }
      try {
        let q = _withTtl(_load());
        if (q.length >= CONFIG.limits.queueMaxSize) { Logger.warn("Queue", "full"); return null; }

        const now = new Date().toISOString();

        if (op.op === "update" || op.op === "delete") {
          const dk = `${op.table}:${op.op}:${_norm(op.filter)}`;
          q = q.filter(e => `${e.table}:${e.op}:${_norm(e.filter)}` !== dk);
          const entry = { ...op, id: dk, ts: now, updated_at: now, retries: 0, status: "pending" };
          q.push(entry);
          _save(q);
          return entry.id;
        } else {
          // INSERT: clientId garantuje idempotencję
          const clientId = op.clientId || `${op.table}:ins:${Date.now()}:${Math.random().toString(36).slice(2)}`;
          if (q.some(e => e.clientId === clientId)) return clientId; // już w kolejce
          const entry = { ...op, id: clientId, clientId, ts: now, updated_at: now, retries: 0, status: "pending" };
          q.push(entry);
          _save(q);
          return entry.id;
        }
      } catch (e) { Logger.error("Queue.enqueue", e.message); return null; }
    },

    _setStatus(id, status) {
      const q = _load().map(op => op.id === id ? { ...op, status } : op);
      _save(q);
    },

    markRetry(id) {
      const q = _load();
      const idx = q.findIndex(op => op.id === id);
      if (idx === -1) return;
      q[idx] = { ...q[idx], retries: (q[idx].retries || 0) + 1, lastRetry: Date.now(), status: "failed" };
      _save(q);
    },

    removeOp(id) { _save(_load().filter(op => op.id !== id)); },

    pruneExhausted() {
      const q = _load();
      const fresh = q.filter(op => (op.retries || 0) < CONFIG.limits.queueMaxRetries);
      const removed = q.length - fresh.length;
      if (removed > 0) { _save(fresh); Logger.info("Queue", `Pruned ${removed} exhausted ops`); }
      return removed;
    },

    /**
     * Flush kolejki — sekwencyjny, z backoff, mutex.
     * #6: conflict strategy: last-write-wins (updated_at na serwerze)
     */
    async flush(currentUser) {
      if (_flushing) return 0;
      _flushing = true;
      let flushed = 0;
      try {
        this.pruneExhausted();
        for (const op of this.getAll()) {
          if (op.lastRetry && Date.now() - op.lastRetry < _backoff(op.retries || 0)) continue;

          this._setStatus(op.id, "syncing");
          try {
            let result;
            if      (op.op === "insert") result = await apiRequest({ method: "POST",   path: `/rest/v1/${op.table}`, body: op.data, ctx: `queue:insert:${op.table}` });
            else if (op.op === "update") result = await apiRequest({ method: "PATCH",  path: `/rest/v1/${op.table}?${op.filter}`, body: op.data, ctx: `queue:update:${op.table}` });
            else if (op.op === "delete") result = await apiRequest({ method: "DELETE", path: `/rest/v1/${op.table}?${op.filter}`, ctx: `queue:delete:${op.table}` });

            if (result && result.ok) { this.removeOp(op.id); flushed++; }
            else if (result && result.error && result.error.isAuthError()) { this._setStatus(op.id, "failed"); break; }
            else this.markRetry(op.id);
          } catch { this.markRetry(op.id); }
        }
        if (flushed > 0) Audit.log("QUEUE_FLUSH", currentUser, { flushed });
      } finally { _flushing = false; }
      return flushed;
    },

    // #9: soft rate limit na mutacje (per user, client-side) (#9)
    _mutationCounts: {},
    _mutationWindow: 60_000, // 1 minuta
    _mutationLimit: 60,      // max 60 mutacji/minutę

    checkMutationRate(userId) {
      const now = Date.now();
      const key = userId || "anon";
      if (!this._mutationCounts[key]) this._mutationCounts[key] = [];
      // Usuń stare wpisy
      this._mutationCounts[key] = this._mutationCounts[key].filter(t => now - t < this._mutationWindow);
      if (this._mutationCounts[key].length >= this._mutationLimit) {
        return { allowed: false, message: "Zbyt wiele operacji — poczekaj chwilę" };
      }
      this._mutationCounts[key].push(now);
      return { allowed: true };
    },
  };
})();

// ════════════════════════════════════════════════════════════════════════════
// § DB SERVICE — używa apiRequest zamiast bezpośrednich fetchów (#4)
// ════════════════════════════════════════════════════════════════════════════

const createDb = (auth, queue) => {
  /**
   * Wrapper na apiRequest: jeśli network error → enqueue do Queue
   * #9: sprawdza rate limit przed każdą mutacją
   */
  const mutate = async (method, path, body, filter, ctx, signal) => {
    // #9: rate limit check
    const rateCheck = queue.checkMutationRate(auth.currentUser && auth.currentUser.id);
    if (!rateCheck.allowed) return DbResult.fail(new AppError(rateCheck.message, "rate_limit", ctx));

    const result = await apiRequest({ method, path, body, ctx, signal });

    if (!result.ok && (result.error && result.error.type === "network" || result.error && result.error.type === "timeout")) {
      // Enqueue dla trybu offline
      const table = path.replace("/rest/v1/", "").split("?")[0];
      if (method === "POST")   queue.enqueue({ op: "insert", table, data: body });
      if (method === "PATCH")  queue.enqueue({ op: "update", table, data: body, filter });
      if (method === "DELETE") queue.enqueue({ op: "delete", table, filter });
    }

    if (result.ok) Audit.log(method === "POST" ? "INSERT" : method === "PATCH" ? "UPDATE" : "DELETE", auth.currentUser, { path });

    return result;
  };

  return {
    select: (table, filter = "", signal) =>
      apiRequest({ method: "GET", path: `/rest/v1/${table}${filter ? "?" + filter : ""}`, ctx: `select:${table}`, signal }),

    insert: (table, data, signal) =>
      mutate("POST",   `/rest/v1/${table}`,        sanitize(data), null, `insert:${table}`, signal),

    update: (table, data, filter, signal) =>
      mutate("PATCH",  `/rest/v1/${table}?${filter}`, sanitize(data), filter, `update:${table}`, signal),

    delete: (table, filter, signal) =>
      mutate("DELETE", `/rest/v1/${table}?${filter}`, null, filter, `delete:${table}`, signal),
  };
};

const db = createDb(AuthManager, Queue);

// ════════════════════════════════════════════════════════════════════════════
// § HOOKS — useAuthState, useValidatedForm, useToast, useRequest,
//           useOnlineSync, useMultiTab, useAbortSignal
// ════════════════════════════════════════════════════════════════════════════

// useAuthState — subskrybuje AuthManager (#2)
const useAuthState = () => {
  const [user, setUser] = useState(AuthManager.currentUser);
  const [loading, setLoading] = useState(!AuthManager.isAuthenticated);

  useEffect(() => {
    // Restore session on mount
    const restore = async () => {
      setLoading(true);
      try {
        Storage.cleanup();
        if (CONFIG.isDemo) {
          // Demo: sprawdź in-memory state (setUser jest już wywołany przez signInDemo)
        } else {
          const session = SessionStore.load();
          if (session && !isExpired(session)) {
            // Mamy ważną sesję — pobierz user
            const res = await apiRequest({ method: "GET", path: "/auth/v1/user", ctx: "restore_session" });
            if (res.ok && res.data) {
              const meta = res.data.user_metadata || {};
              const u = { id: res.data.id, email: res.data.email, role: meta.role || ROLES.WORKER, name: meta.name || res.data.email.split("@")[0] };
              AuthManager._currentUser = u; // internal update
              setUser(u);
            } else {
              AuthManager._forceLogout("restore_failed");
            }
          }
        }
      } catch {}
      setLoading(false);
    };

    restore();

    // Subscribe na zmiany auth state
    const unsub = AuthManager.subscribe(event => {
      if (event.type === "LOGIN")  { setUser(AuthManager.currentUser); setLoading(false); }
      if (event.type === "LOGOUT") { setUser(null); setLoading(false); }
    });

    return unsub;
  }, []);

  return { user, loading, isAuthenticated: !!user };
};

// useAbortSignal — cancel request przy unmount (#13)
const useAbortSignal = () => {
  const ctrlRef = useRef(new AbortController());
  useEffect(() => {
    ctrlRef.current = new AbortController();
    return () => ctrlRef.current.abort();
  }, []);
  return ctrlRef.current.signal;
};

// useRequest — per-request loading + retry (#12)
const useRequest = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const signal = useAbortSignal();

  const execute = useCallback(async (fn) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fn(signal);
      if (!result && result.ok && result && result.error) setError(result.error);
      return result;
    } catch (e) {
      const appErr = AppError.from(e);
      setError(appErr);
      return DbResult.fail(appErr);
    } finally {
      setLoading(false);
    }
  }, [signal]);

  const retry = useCallback((fn) => execute(fn), [execute]);

  return { loading, error, execute, retry };
};

// useToast — #12 (#54)
const useToast = () => {
  const [toast, setToast] = useState(null);
  const timerRef = useRef(null);

  const show = useCallback((msg, type = "info") => {
    clearTimeout(timerRef.current);
    setToast({ msg, type });
    timerRef.current = setTimeout(() => setToast(null), CONFIG.timeouts.toast);
  }, []);

  const showError = useCallback((err, ctx = "") => {
    const appErr = AppError.from(err, ctx);
    const { msg, type } = appErr.toToast();
    show(msg, type);
    return appErr;
  }, [show]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return { toast, show, showError, clear: () => { clearTimeout(timerRef.current); setToast(null); } };
};

// useValidatedForm — z debounce i cleanup (#8, #9, #12)
const useValidatedForm = (initial, schemaKey) => {
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const timers = useRef({});

  useEffect(() => () => { Object.values(timers.current).forEach(clearTimeout); timers.current = {}; }, []);

  const validateField = useCallback((k, v) => {
    const rules = (SCHEMAS[schemaKey] || {})[k] || [];
    for (const rule of rules) { const e = rule(v); if (e) return e; }
    return null;
  }, [schemaKey]);

  const set = useCallback((k, v) => {
    setForm(f => ({ ...f, [k]: v }));
    if (!touched[k] && !submitted) return;
    clearTimeout(timers.current[k]);
    timers.current[k] = setTimeout(() => {
      const err = validateField(k, v);
      setErrors(prev => {
        if (!err) { if (!prev[k]) return prev; const c = { ...prev }; delete c[k]; return c; }
        if (prev[k] === err) return prev;
        return { ...prev, [k]: err };
      });
    }, CONFIG.timeouts.debounce);
  }, [touched, submitted, validateField]);

  const touch = (k) => setTouched(t => ({ ...t, [k]: true }));

  const submit = (onValid) => {
    setSubmitted(true);
    Object.values(timers.current).forEach(clearTimeout);
    timers.current = {};
    const { valid, errors: errs } = runValidation(schemaKey, form);
    setErrors(valid ? {} : errs);
    if (valid) onValid(sanitize(form));
    return valid;
  };

  const hasError = (k) => (touched[k] || submitted) ? (errors[k] || null) : null;
  return { form, set, touch, submit, errors, hasError };
};

// useOnlineSync — retry scheduler + flush (#35)
const useOnlineSync = (currentUser) => {
  const [online, setOnline] = useState(true);
  const [queueSize, setQueueSize] = useState(Queue.size());
  const intervalRef = useRef(null);
  const { show } = useToast();

  const flush = useCallback(async () => {
    if (!online || Queue.size() === 0) return;
    const n = await Queue.flush(currentUser);
    setQueueSize(Queue.size());
    if (n > 0) show(`✅ Zsynchronizowano ${n} operacji`, "success");
  }, [online, currentUser, show]);

  useEffect(() => {
    const onOnline  = () => { setOnline(true); flush(); };
    const onOffline = () => { setOnline(false); setQueueSize(Queue.size()); show("📡 Tryb offline", "network"); };

    window.addEventListener("online",  onOnline);
    window.addEventListener("offline", onOffline);
    intervalRef.current = setInterval(() => { if (navigator.onLine && Queue.size() > 0) flush(); }, 30_000);

    return () => {
      window.removeEventListener("online",  onOnline);
      window.removeEventListener("offline", onOffline);
      clearInterval(intervalRef.current);
    };
  }, [flush, show]);

  return { online, queueSize };
};

// useMultiTab — pełna synchronizacja (#8: LOGIN/LOGOUT/SESSION_EXPIRED) (#23, #48)
const useMultiTab = (onLogout, onLogin) => {
  useEffect(() => {
    // Storage event: sesja usunięta w innym tabie
    const onStorage = (e) => {
      if (e.key === "velarflow_session" && e.newValue === null) onLogout && onLogout("other_tab");
    };

    // BroadcastChannel: szybsza komunikacja (#8)
    let ch = null;
    try {
      if (typeof BroadcastChannel !== "undefined") {
        ch = new BroadcastChannel("velarflow_auth");
        ch.onmessage = (ev) => {
          const { type, reason } = ev.data || {};
          if (type === "LOGOUT")          onLogout && onLogout(reason || "other_tab");
          if (type === "SESSION_EXPIRED") onLogout && onLogout("session_expired");
          if (type === "LOGIN")           onLogin && onLogin();
        };
      }
    } catch (e) { Logger.warn("useMultiTab", "BroadcastChannel error:", e.message); } // #16: try/catch

    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      try { ch && ch.close(); } catch {}
    };
  }, [onLogout, onLogin]);
};

// useGlobalLoading — globalny loading state (#12)
const useGlobalLoading = () => {
  const [operations, setOperations] = useState(0);
  const start = useCallback(() => setOperations(n => n + 1), []);
  const stop  = useCallback(() => setOperations(n => Math.max(0, n - 1)), []);
  return { isLoading: operations > 0, start, stop };
};

// ════════════════════════════════════════════════════════════════════════════
// § ACCESS CONTROL
// ════════════════════════════════════════════════════════════════════════════
const ROLES = { MANAGER: "manager", WORKER: "worker", CLEANING: "cleaning_team", MAINTENANCE: "maintenance" };

const PERMISSIONS = {
  manager:       ["read:all","write:apartments","write:tasks","write:owners",
                  "delete:tasks","delete:apartments","view:sensitive","sync:kw","view:audit",
                  "write:cleaning","read:cleaning","write:settings"],
  worker:        ["read:all","read:cleaning","read:settings"], // read-only manager view
  cleaning_team: ["read:cleaning","write:cleaning","read:apartments_basic"],
  maintenance:   ["read:tasks","write:own_task_status"],
};

const can   = (user, action) => { if (!is.user(user)) return false; const p = PERMISSIONS[user.role]||[]; return p.includes(action)||p.includes("read:all"); };
const guard = (user, action, onDeny) => { if (!can(user, action)) { Audit.log("ACCESS_DENIED", user, {action}); onDeny && onDeny(AppError.forbidden(`Brak uprawnień: ${action}`).message); return false; } return true; };

// ── Standardowe listy (z PDF-ów "LISTA WYPOSAŻENIA" i "WYKAZ TEKSTYLIÓW") ──
const STANDARD_EQUIPMENT = [
  // Przedpokój
  { cat:"Przedpokój",   name:"Wieszak" },
  { cat:"Przedpokój",   name:"Lustro" },
  { cat:"Przedpokój",   name:"Szafa" },
  { cat:"Przedpokój",   name:"Szafka na buty" },
  { cat:"Przedpokój",   name:"Wycieraczka" },
  // Pokój dzienny
  { cat:"Pokój dzienny",name:"Telewizor" },
  { cat:"Pokój dzienny",name:"Szafka RTV" },
  { cat:"Pokój dzienny",name:"Sofa / sofa rozkładana" },
  { cat:"Pokój dzienny",name:"Fotel" },
  { cat:"Pokój dzienny",name:"Stół / stolik / ława" },
  { cat:"Pokój dzienny",name:"Krzesła" },
  { cat:"Pokój dzienny",name:"Podkładka na stół" },
  // Sypialnia
  { cat:"Sypialnia",    name:"Łóżko podwójne" },
  { cat:"Sypialnia",    name:"Łóżko pojedyncze" },
  { cat:"Sypialnia",    name:"Komoda" },
  { cat:"Sypialnia",    name:"Szafka nocna" },
  { cat:"Sypialnia",    name:"Lampka nocna" },
  { cat:"Sypialnia",    name:"Telewizor (sypialnia)" },
  { cat:"Sypialnia",    name:"Szafa (sypialnia)" },
  { cat:"Sypialnia",    name:"Lustro (sypialnia)" },
  { cat:"Sypialnia",    name:"Koc" },
  // Łazienka
  { cat:"Łazienka",     name:"Prysznic / wanna" },
  { cat:"Łazienka",     name:"Lustro (łazienka)" },
  { cat:"Łazienka",     name:"Uchwyt na ręczniki" },
  { cat:"Łazienka",     name:"Uchwyt na papier" },
  { cat:"Łazienka",     name:"Suszarka do włosów" },
  { cat:"Łazienka",     name:"Kosz na śmieci (łazienka)" },
  { cat:"Łazienka",     name:"Szczotka toaletowa" },
  { cat:"Łazienka",     name:"Dozownik na mydło" },
  { cat:"Łazienka",     name:"Pralka" },
  // Kuchnia
  { cat:"Kuchnia",      name:"Lodówka" },
  { cat:"Kuchnia",      name:"Czajnik elektryczny" },
  { cat:"Kuchnia",      name:"Płyta grzewcza" },
  { cat:"Kuchnia",      name:"Piekarnik" },
  { cat:"Kuchnia",      name:"Kuchenka mikrofalowa" },
  { cat:"Kuchnia",      name:"Toster / Opiekacz" },
  { cat:"Kuchnia",      name:"Ekspres do kawy" },
  { cat:"Kuchnia",      name:"Zmywarka" },
  { cat:"Kuchnia",      name:"Okap" },
  { cat:"Kuchnia",      name:"Garnki" },
  { cat:"Kuchnia",      name:"Patelnia" },
  { cat:"Kuchnia",      name:"Kubki / filiżanki" },
  { cat:"Kuchnia",      name:"Szklanki" },
  { cat:"Kuchnia",      name:"Kieliszki do wina" },
  { cat:"Kuchnia",      name:"Talerze płytkie" },
  { cat:"Kuchnia",      name:"Talerze głębokie" },
  { cat:"Kuchnia",      name:"Miseczki" },
  { cat:"Kuchnia",      name:"Talerzyki deserowe" },
  { cat:"Kuchnia",      name:"Sztućce" },
  { cat:"Kuchnia",      name:"Noże" },
  { cat:"Kuchnia",      name:"Korkociąg / otwieracz" },
  { cat:"Kuchnia",      name:"Otwieracz do konserw" },
  { cat:"Kuchnia",      name:"Nożyczki" },
  { cat:"Kuchnia",      name:"Chochelka" },
  { cat:"Kuchnia",      name:"Łyżki / szpatułki" },
  { cat:"Kuchnia",      name:"Deska do krojenia" },
  { cat:"Kuchnia",      name:"Solniczka" },
  { cat:"Kuchnia",      name:"Pieprzniczka" },
  { cat:"Kuchnia",      name:"Cukiernica" },
  { cat:"Kuchnia",      name:"Dozownik na płyn (kuchnia)" },
  { cat:"Kuchnia",      name:"Kosz na śmieci (kuchnia)" },
  // Taras
  { cat:"Taras",        name:"Stolik ogrodowy" },
  { cat:"Taras",        name:"Fotel / krzesło ogrodowe" },
  { cat:"Taras",        name:"Sofa ogrodowa" },
  { cat:"Taras",        name:"Sprzęt do grillowania" },
  // Dodatkowe
  { cat:"Dodatkowe",    name:"Router internetowy" },
  { cat:"Dodatkowe",    name:"Dekoder telewizyjny" },
  { cat:"Dodatkowe",    name:"Odkurzacz" },
  { cat:"Dodatkowe",    name:"Worki do odkurzacza" },
  { cat:"Dodatkowe",    name:"Żelazko" },
  { cat:"Dodatkowe",    name:"Deska do prasowania" },
  { cat:"Dodatkowe",    name:"Suszarka na pranie" },
  { cat:"Dodatkowe",    name:"Miotła" },
  { cat:"Dodatkowe",    name:"Szufelka ze zmiotką" },
  { cat:"Dodatkowe",    name:"Mop" },
  { cat:"Dodatkowe",    name:"Wiadro do mopa" },
  { cat:"Dodatkowe",    name:"Zasłony / rolety" },
  { cat:"Dodatkowe",    name:"Firany" },
  { cat:"Dodatkowe",    name:"Poduszki dekoracyjne" },
  { cat:"Dodatkowe",    name:"Leżak plażowy" },
  { cat:"Dodatkowe",    name:"Parawan" },
  { cat:"Dodatkowe",    name:"Łóżeczko dla dziecka" },
  { cat:"Dodatkowe",    name:"Krzesełko do karmienia" },
];

const STANDARD_TEXTILES = [
  { name:"Kołdra",              size:"160/200" },
  { name:"Poduszka",            size:"50/60"   },
  { name:"Poszwa (haft)",       size:"160/200" },
  { name:"Poszewka (haft)",     size:"50/70"   },
  { name:"Prześcieradło z gumką", size:"160/200" },
  { name:"Prześcieradło proste",  size:"220/240" },
  { name:"Ręcznik duży (550g)", size:"70/140"  },
  { name:"Ręcznik mały (550g)", size:"50/100"  },
  { name:"Dywanik łazienkowy",  size:"50/70"   },
  { name:"Podkład duży",        size:"160/200" },
];

// PAKIET 8a.1 — Service do edytowalnej globalnej listy tekstyliów.
// TODO (osobny pakiet): dodać `defaultQtyFormula` (np. "1 na osobę + 1 zapas") — wymaga decyzji co do
// wzoru (constant / formuła / per typ łóżka), więc na razie ilość liczona jak wcześniej w detalu apt.
const TextilesService = {
  _key: "textiles_defaults",  // MUST-4: bez prefiksu, Storage._ns dokleja "velarflow:"

  _seed() {
    return STANDARD_TEXTILES.map((t, i) => ({
      id: `tex_${i + 1}`,
      name: t.name,
      size: t.size,
      builtin: true,
      order: i,
    }));
  },

  getAll() {
    let list = Storage.get(this._key);
    if (!list || !Array.isArray(list) || list.length === 0) {
      list = this._seed();
      Storage.set(this._key, list);
    }
    return [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  },

  save(list) { Storage.set(this._key, list); },

  add(item) {
    const list = this.getAll();
    const maxOrder = list.reduce((m, t) => Math.max(m, t.order || 0), 0);
    const entry = {
      id: `tex_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
      name: (item.name || "").trim(),
      size: (item.size || "").trim(),
      builtin: false,
      order: maxOrder + 1,
    };
    if (!entry.name) return null;
    this.save([...list, entry]);
    return entry;
  },

  update(id, changes) {
    const list = this.getAll().map(t => t.id === id ? { ...t, ...changes, builtin: t.builtin } : t);
    this.save(list);
    return list;
  },

  remove(id) {
    this.save(this.getAll().filter(t => t.id !== id));
  },

  reorder(orderedIds) {
    const map = Object.fromEntries(orderedIds.map((id, i) => [id, i]));
    const list = this.getAll().map(t => ({ ...t, order: map[t.id] ?? t.order }));
    this.save(list);
    return list;
  },
};

// Pozycje używane w zamówieniach — dynamiczne, zależne od TextilesService
const getOrderItems = () => TextilesService.getAll().map(t => `${t.name} ${t.size}`);

// ── Settings — globalne ustawienia aplikacji ──────────────────────────────
// Kluczowe: szablony SMS dla ZARZĄDZANIE i OBSŁUGA oraz overrides per apt
const DEFAULT_SMS_TEMPLATES = {
  "ZARZĄDZANIE": `Dzień dobry,
Sprzątanie w apartamencie {aptName}.

Kod wejścia: {code}
WiFi: {wifi}

Uwagi:
- wymiana ręczników i pościeli
- uzupełnienie środków czystości
- sprawdzenie lodówki

VelarFlow`,
  "OBSŁUGA": `Dzień dobry,
Obsługa apartamentu {aptName}.

Kod wejścia: {code}
WiFi: {wifi}

Standardowe sprzątanie zgodnie z ustaleniami.

VelarFlow`,
};

// FIX 1.6 — ściąga zmiennych dla edytora szablonów SMS.
// UWAGA: lista odzwierciedla DOKŁADNIE tokeny podstawiane w Settings.render() —
// tylko te są realnie zamieniane przy wysyłce. Dodając nowy token tutaj, dodaj
// też odpowiedni .replace() w Settings.render().
const SMS_VARIABLES = [
  { name: "{aptName}",      example: "Apartament Demo 01",                description: "Nazwa apartamentu" },
  { name: "{code}",         example: "1234#",                            description: "Kod do skrytki / domofonu" },
  { name: "{wifi}",         example: "VelarWiFi / haslo123",             description: "Sieć WiFi (pierwsza linia pola WiFi)" },
  { name: "{address}",      example: "ul. Demonstracyjna 5/3, Warszawa", description: "Adres apartamentu" },
  { name: "{checkinTime}",  example: "16:00",                            description: "Godzina zameldowania" },
  { name: "{checkoutTime}", example: "11:00",                            description: "Godzina wymeldowania" },
];

// ── Categories — user-defined kategorie pozycji ──────────────────────────
// Każda kategoria ma własny sidebar entry jeśli showInNav=true
// Ikony dostępne w Icon component: home, check, tasks, users, building, key, info, calendar, star, tent, tree, car, package
const CATEGORY_ICONS = ["home","building","key","tent","tree","star","check","info","package","car","calendar","users"];
const CATEGORY_COLORS = ["#3B82F6","#A78BFA","#F59E0B","#10B981","#EF4444","#EC4899","#8B5CF6","#06B6D4","#14B8A6","#F97316"];

const Categories = {
  _key: "categories",  // MUST-4: bez prefiksu — Storage._ns dokleja "velarflow:"

  getAll() {
    const stored = Storage.get(this._key);
    if (stored && Array.isArray(stored) && stored.length > 0) {
      // PAKIET 8a.4 — sortowanie po `order` (fallback do 999 dla starych zapisów)
      return [...stored].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    }
    // Seed z dwóch wbudowanych kategorii (edytowalne ale z flagą builtin)
    const seed = [
      { id: "zarzadzanie", name: "ZARZĄDZANIE", color: "#3B82F6", icon: "building", showInNav: true,  builtin: true, order: 0 },
      { id: "obsluga",     name: "OBSŁUGA",     color: "#a78bfa", icon: "key",      showInNav: true,  builtin: true, order: 1 },
    ];
    this.save(seed);
    return seed;
  },

  save(list) { Storage.set(this._key, list); },

  getById(id) { return this.getAll().find(c => c.id === id); },
  getByName(name) { return this.getAll().find(c => c.name === name); },

  // Migracja: apartamenty używają `status` pola z nazwą kategorii — zwracamy kategorię po nazwie
  getForApt(apt) {
    return this.getByName(apt.status) || this.getById("zarzadzanie");
  },

  add(cat) {
    const list = this.getAll();
    const id = cat.id || cat.name.toLowerCase().replace(/\s+/g,"_").replace(/[^a-z0-9_]/g,"").slice(0,30) + "_" + Date.now().toString(36);
    const maxOrder = list.reduce((m, c) => Math.max(m, c.order ?? 0), 0);
    const entry = {
      id,
      name: cat.name.trim().toUpperCase(),
      color: cat.color || CATEGORY_COLORS[list.length % CATEGORY_COLORS.length],
      icon: cat.icon || "home",
      showInNav: cat.showInNav !== false,
      builtin: false,
      order: maxOrder + 1,
    };
    this.save([...list, entry]);
    return entry;
  },

  update(id, patch) {
    const list = this.getAll().map(c => c.id === id ? { ...c, ...patch, builtin: c.builtin } : c);
    this.save(list);
    return list.find(c => c.id === id);
  },

  // Usuwanie: blokowane gdy kategoria jest w użyciu
  canDelete(id, apartments) {
    const cat = this.getById(id);
    if (!cat) return { ok: false, reason: "Kategoria nie istnieje" };
    const name = cat.name;
    const inUse = apartments.some(a => a.status === name);
    if (inUse) {
      const count = apartments.filter(a => a.status === name).length;
      return { ok: false, reason: `Kategoria jest używana przez ${count} ${count === 1 ? "pozycję" : "pozycje"}` };
    }
    return { ok: true };
  },

  remove(id, apartments) {
    const check = this.canDelete(id, apartments);
    if (!check.ok) return check;
    const list = this.getAll().filter(c => c.id !== id);
    this.save(list);
    return { ok: true };
  },
};

// ── Loans — pożyczki wyposażenia między apartamentami ────────────────────
// Struktura: { id, fromAptId, toAptId, items[{name,qty}], borrowedAt, returnedAt?, status, notes, createdBy }
const Loans = {
  _key: "loans",  // MUST-4: bez prefiksu

  getAll() { return Storage.get(this._key) || []; },
  save(list) { Storage.set(this._key, list); },

  forApt(aptId) {
    return this.getAll().filter(l => l.fromAptId === aptId || l.toAptId === aptId);
  },

  active() { return this.getAll().filter(l => l.status === "active"); },

  add(loan) {
    const entry = {
      id: `loan_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      fromAptId: Number(loan.fromAptId),
      toAptId:   Number(loan.toAptId),
      items: (loan.items || []).filter(i => i.name && i.name.trim()).map(i => ({
        name: i.name.trim(),
        qty: Math.max(1, Number(i.qty) || 1),
      })),
      notes: (loan.notes || "").trim(),
      borrowedAt: new Date().toISOString(),
      returnedAt: null,
      status: "active",
      createdBy: loan.createdBy || "",
    };
    // PAKIET 8b — pola własne ze schemy formularza (loan)
    if (loan.customFields && typeof loan.customFields === "object") {
      entry.customFields = { ...loan.customFields };
    }
    if (entry.items.length === 0) return null;
    if (entry.fromAptId === entry.toAptId) return null;
    this.save([entry, ...this.getAll()]);
    return entry;
  },

  markReturned(id, opts = {}) {
    // FIX 3.C — opcjonalna data zwrotu + notatka (domyślnie: teraz, bez notatki).
    // Wstecznie kompatybilne: dotychczasowi wołający markReturned(id) działają bez zmian.
    const returnedAt = opts.returnedAt ? new Date(opts.returnedAt).toISOString() : new Date().toISOString();
    this.save(this.getAll().map(l =>
      l.id === id ? { ...l, status: "returned", returnedAt, returnNote: (opts.note || "").trim() } : l
    ));
  },

  remove(id) { this.save(this.getAll().filter(l => l.id !== id)); },
};

// ── Files — linki do dokumentów (szablony umów, instrukcje, inne) ──────────
// Struktura: { id, name, url, category, aptId?, addedBy, addedAt, description }
const FILE_CATEGORIES = [
  { id: "contract",     label: "Szablon umowy" },
  { id: "instruction",  label: "Instrukcja" },
  { id: "invoice",      label: "Faktura" },
  { id: "photo",        label: "Zdjęcia" },
  { id: "other",        label: "Inne" },
];

const FILE_CAT_COLORS = {
  contract:"var(--accent)", instruction:"var(--green)", invoice:"var(--yellow)",
  photo:"#ec4899", other:"var(--text2)",
};
const fileCatLabel = (id) => ((FILE_CATEGORIES.find(c => c.id === id) || {}).label) || "Inne";

// Polska odmiana rzeczownika przez liczbę: one=1, few=2–4, many=5+/0 (z wyjątkiem 12–14 → many)
const plForm = (n, one, few, many) => {
  const mod10 = n % 10, mod100 = n % 100;
  if (n === 1) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

const Files = {
  _key: "files",  // MUST-4: bez prefiksu

  getAll() { return Storage.get(this._key) || []; },
  save(list) { Storage.set(this._key, list); },

  forApt(aptId) { return this.getAll().filter(f => f.aptId === aptId); },
  byCategory(cat) { return this.getAll().filter(f => f.category === cat); },

  add(file) {
    const entry = {
      id: `file_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
      name: (file.name || "").trim(),
      url:  (file.url  || "").trim(),
      category: file.category || "other",
      aptId: file.aptId ? Number(file.aptId) : null,
      description: (file.description || "").trim(),
      addedBy: file.addedBy || "",
      addedAt: new Date().toISOString(),
    };
    if (!entry.name || !entry.url) return null;
    this.save([entry, ...this.getAll()]);
    return entry;
  },

  remove(id) { this.save(this.getAll().filter(f => f.id !== id)); },

  update(id, patch) {
    this.save(this.getAll().map(f => f.id === id ? { ...f, ...patch } : f));
  },
};

// ── EquipmentRooms — kategorie pomieszczeń do wyposażenia ─────────────────
// Globalne (widoczne we wszystkich apt) + per-apt (przypisane do konkretnego apt)
const DEFAULT_ROOMS = ["Przedpokój","Pokój dzienny","Sypialnia","Łazienka","Kuchnia","Taras","Dodatkowe"];

// ── FormSchema — dynamiczny schemat pól formularza pozycji ─────────────────
// Pola z grupami, kolejnością, typami. Konfigurowane w Ustawieniach.
const DEFAULT_FORM_FIELDS = [
  // Grupa: Podstawowe
  { id:"name", label:"Nazwa", group:"Podstawowe", type:"text", required:true, defaultVisible:true, order:1 },
  { id:"onlineName", label:"Nazwa Booking", group:"Podstawowe", type:"text", defaultVisible:true, order:2 },
  { id:"address", label:"Adres", group:"Podstawowe", type:"text", defaultVisible:true, order:3 },
  { id:"floor", label:"Piętro", group:"Podstawowe", type:"text", defaultVisible:true, order:4 },
  { id:"aptNumber", label:"Numer apartamentu", group:"Podstawowe", type:"text", defaultVisible:true, order:5 },
  { id:"capacity", label:"Maks. osób", group:"Podstawowe", type:"number", defaultVisible:true, order:6 },
  { id:"surfaceM2", label:"Powierzchnia m²", group:"Podstawowe", type:"number", defaultVisible:false, order:7 },
  { id:"distanceSea", label:"Odl. od morza (m)", group:"Podstawowe", type:"number", defaultVisible:true, order:8 },
  // Grupa: Doba hotelowa
  { id:"checkinTime", label:"Doba hotelowa od (godzina)", group:"Doba hotelowa", type:"text", defaultVisible:true, order:10 },
  { id:"checkoutTime", label:"Doba hotelowa do (godzina)", group:"Doba hotelowa", type:"text", defaultVisible:true, order:11 },
  // Grupa: Wejście
  { id:"domofon", label:"Domofon / Furtka", group:"Wejście i zabezpieczenia", type:"textarea", defaultVisible:true, order:20 },
  { id:"securityType", label:"Rodzaj zabezpieczenia", group:"Wejście i zabezpieczenia", type:"text", defaultVisible:true, order:21 },
  { id:"safeCode", label:"Kod sejfu / klamki", group:"Wejście i zabezpieczenia", type:"text", defaultVisible:true, order:22 },
  { id:"wifi", label:"WiFi", group:"Wejście i zabezpieczenia", type:"textarea", defaultVisible:true, order:23 },
  { id:"entryInstruction", label:"Instrukcja wejścia", group:"Wejście i zabezpieczenia", type:"textarea", defaultVisible:true, order:24 },
  // Grupa: Parking
  { id:"parking", label:"Rodzaj miejsca parkingowego", group:"Parking", type:"text", defaultVisible:true, order:30 },
  { id:"parkingNumber", label:"Numer miejsca parkingowego", group:"Parking", type:"text", defaultVisible:true, order:31 },
  { id:"garage", label:"Garaż — wymiary wjazdu", group:"Parking", type:"text", defaultVisible:false, order:32 },
  // Grupa: Udogodnienia
  { id:"amenitiesBuilding", label:"Udogodnienia na obiekcie", group:"Udogodnienia", type:"textarea", defaultVisible:false, order:40 },
  { id:"amenitiesApt", label:"Udogodnienia w apartamencie", group:"Udogodnienia", type:"textarea", defaultVisible:false, order:41 },
  { id:"disabledAccess", label:"Udogodnienia dla niepełnosprawnych", group:"Udogodnienia", type:"text", defaultVisible:false, order:42 },
  { id:"bikeRoom", label:"Rowerownia", group:"Udogodnienia", type:"text", defaultVisible:false, order:43 },
  { id:"trashShelter", label:"Wiata śmietnikowa", group:"Udogodnienia", type:"text", defaultVisible:false, order:44 },
  { id:"pool", label:"Basen", group:"Udogodnienia", type:"text", defaultVisible:false, order:45 },
  { id:"poolHoursSeason", label:"Godziny basenu w sezonie", group:"Udogodnienia", type:"text", defaultVisible:false, order:46 },
  { id:"poolHoursOff", label:"Godziny basenu poza sezonem", group:"Udogodnienia", type:"text", defaultVisible:false, order:47 },
  // Grupa: Wyposażenie
  { id:"bedding", label:"Pościel / Łóżka", group:"Wyposażenie i klucze", type:"textarea", defaultVisible:true, order:50 },
  { id:"keys", label:"Klucze w apartamencie", group:"Wyposażenie i klucze", type:"textarea", defaultVisible:true, order:51 },
  { id:"keysSpare", label:"Klucze zapasowe", group:"Wyposażenie i klucze", type:"textarea", defaultVisible:false, order:52 },
  { id:"ownerEquipment", label:"Wyposażenie zapewnione przez właścicieli", group:"Wyposażenie i klucze", type:"textarea", defaultVisible:false, order:53 },
  // Grupa: Rezerwacje i ceny
  { id:"bookingSource", label:"Rezerwacje najczęściej przez", group:"Rezerwacje i ceny", type:"text", defaultVisible:false, order:60 },
  { id:"cleaningSezon", label:"Cena sprzątania netto w sezonie (zł)", group:"Rezerwacje i ceny", type:"number", defaultVisible:true, order:61 },
  { id:"cleaningOffSezon", label:"Cena sprzątania netto poza sezonem (zł)", group:"Rezerwacje i ceny", type:"number", defaultVisible:true, order:62 },
  { id:"kaucja", label:"Kaucja (zł)", group:"Rezerwacje i ceny", type:"number", defaultVisible:false, order:63 },
  { id:"smsSend", label:"Czy wysyłamy kody SMS?", group:"Rezerwacje i ceny", type:"text", defaultVisible:false, order:64 },
  // Grupa: Linki
  { id:"bookingLink", label:"Booking (link)", group:"Linki", type:"url", defaultVisible:true, order:70 },
  { id:"bookingLinkDe", label:"Booking DE (link)", group:"Linki", type:"url", defaultVisible:false, order:71 },
  { id:"bookingCom", label:"Booking.com (link)", group:"Linki", type:"url", defaultVisible:false, order:72 },
  { id:"regulaminLink", label:"Regulamin (link)", group:"Linki", type:"url", defaultVisible:false, order:73 },
  { id:"umowaLink", label:"Umowa (link)", group:"Linki", type:"url", defaultVisible:false, order:74 },
  { id:"photosEquip", label:"Fotki wyposażenia (link)", group:"Linki", type:"url", defaultVisible:false, order:75 },
  { id:"photosApt", label:"Fotki apartamentu (link)", group:"Linki", type:"url", defaultVisible:false, order:76 },
  { id:"photosBuilding", label:"Fotki budynku (link)", group:"Linki", type:"url", defaultVisible:false, order:77 },
  // Grupa: Umowa
  { id:"umowaDate", label:"Umowa podpisana w dniu", group:"Umowa", type:"date", defaultVisible:false, order:80 },
  { id:"umowaPeriod", label:"Umowa na czas", group:"Umowa", type:"text", defaultVisible:false, order:81 },
  // Grupa: KW Hotel
  { id:"kwName", label:"Nazwa w KW Hotel", group:"KW Hotel", type:"text", defaultVisible:true, order:90 },
  // Grupa: Inne
  { id:"unusualSolutions", label:"Nietypowe rozwiązania", group:"Inne", type:"textarea", defaultVisible:false, order:100 },
  { id:"nonStandardPrep", label:"Niestandardowe szykowanie", group:"Inne", type:"textarea", defaultVisible:false, order:101 },
  { id:"notes", label:"Notatki ogólne", group:"Inne", type:"textarea", defaultVisible:true, order:102 },
];

// Wbudowane pola formularza właściciela (PAKIET 5) — id 1:1 z polami obiektu owner
const DEFAULT_OWNER_FIELDS = [
  { id:"firstName",     label:"Imię",               group:"Dane podstawowe",      type:"text",     required:true,  defaultVisible:true, order:1 },
  { id:"lastName",      label:"Nazwisko",           group:"Dane podstawowe",      type:"text",     required:true,  defaultVisible:true, order:2 },
  { id:"phone",         label:"Telefon",            group:"Kontakt",              type:"phone",    defaultVisible:true, order:10 },
  { id:"email",         label:"E-mail",             group:"Kontakt",              type:"email",    defaultVisible:true, order:11 },
  { id:"kwLogin",       label:"Login KW",           group:"KW Hotel",             type:"text",     defaultVisible:true, order:20 },
  { id:"kwPassword",    label:"Hasło KW",           group:"KW Hotel",             type:"text",     defaultVisible:true, order:21 },
  { id:"status",        label:"Typ umowy",          group:"Umowa i rozliczenia",  type:"select",   required:true,  defaultVisible:true, order:30, options:["ZARZĄDZANIE","OBSŁUGA"], defaultValue:"ZARZĄDZANIE" },
  { id:"percent",       label:"Prowizja (%)",       group:"Umowa i rozliczenia",  type:"number",   defaultVisible:true, order:31 },
  { id:"billingMethod", label:"Metoda rozliczenia", group:"Umowa i rozliczenia",  type:"text",     defaultVisible:true, order:32 },
  { id:"invoiceData",   label:"Dane do faktury",    group:"Umowa i rozliczenia",  type:"textarea", defaultVisible:true, order:33 },
];

// PAKIET 8b — pola domyślne dla zadań i pożyczek (overlay strategy: visibility/required + custom only)
const DEFAULT_TASK_FIELDS = [
  { id:"apartmentId", label:"Apartament / Lokalizacja", group:"Podstawowe", type:"select",   required:true,  defaultVisible:true, order:1 },
  { id:"title",       label:"Tytuł zadania",            group:"Podstawowe", type:"text",     required:true,  defaultVisible:true, order:2 },
  { id:"priority",    label:"Priorytet",                group:"Podstawowe", type:"select",   defaultVisible:true, order:3, options:["high","normal","low"] },
  { id:"orderBy",     label:"Osoba zlecająca",          group:"Wykonanie",  type:"text",     defaultVisible:true, order:10 },
  { id:"assignedTo",  label:"Przypisz do",              group:"Wykonanie",  type:"select",   required:true,  defaultVisible:true, order:11 },
  { id:"nextCheckout",label:"Wyjazd gości",             group:"Terminy",    type:"datetime", defaultVisible:true, order:20 },
  { id:"nextCheckin", label:"Przyjazd gości",           group:"Terminy",    type:"datetime", defaultVisible:true, order:21 },
  { id:"notes",       label:"Notatki",                  group:"Dodatkowe",  type:"textarea", defaultVisible:true, order:30 },
];

const DEFAULT_LOAN_FIELDS = [
  { id:"fromAptId", label:"Z apartamentu",  group:"Podstawowe", type:"select",   required:true, defaultVisible:true, order:1 },
  { id:"toAptId",   label:"Do apartamentu", group:"Podstawowe", type:"select",   required:true, defaultVisible:true, order:2 },
  { id:"items",     label:"Pozycje",        group:"Pozycje",    type:"items",    required:true, defaultVisible:true, order:10 },
  { id:"notes",     label:"Notatki",        group:"Dodatkowe",  type:"textarea", defaultVisible:true, order:20 },
];

// Domyślne pola per kategoria + lista kategorii konfigurowalnych formularzy
const FORM_DEFAULTS = {
  apartment: DEFAULT_FORM_FIELDS,
  owner:     DEFAULT_OWNER_FIELDS,
  task:      DEFAULT_TASK_FIELDS,
  loan:      DEFAULT_LOAN_FIELDS,
};
const FORM_CATEGORIES = [
  { key: "apartment", label: "Apartament" },
  { key: "owner",     label: "Właściciel" },
  { key: "task",      label: "Zadanie" },
  { key: "loan",      label: "Pożyczka" },
];

const FormSchema = {
  _key: "form_schema",  // MUST-4: bez prefiksu

  // PAKIET 8b — wyciąga unikalne grupy w kolejności pierwszego wystąpienia po order
  _deriveGroupOrder(fields) {
    const sorted = [...fields].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const seen = new Set();
    const order = [];
    sorted.forEach(f => {
      const g = f.group || "Inne";
      if (!seen.has(g)) { seen.add(g); order.push(g); }
    });
    return order;
  },

  // PAKIET 8b — buduje wpis kategorii { fields, groupOrder } z listy pól
  _upgradeCategory(fields) {
    return { fields, groupOrder: this._deriveGroupOrder(fields) };
  },

  // Cały magazyn { apartment:{fields,groupOrder}, owner:{...}, task:{...}, loan:{...} }
  // Migracja: stary format (płaska tablica = apartament) oraz stary format per-kategoria (lista pól).
  // Dosiewa braki domyślnymi polami danej kategorii.
  _store() {
    const raw = Storage.get(this._key);
    let store = {};
    let changed = false;
    if (Array.isArray(raw)) {
      store.apartment = this._upgradeCategory(raw);
      changed = true;
    } else if (raw && typeof raw === "object") {
      Object.keys(raw).forEach(cat => {
        const val = raw[cat];
        if (Array.isArray(val)) {
          store[cat] = this._upgradeCategory(val);
          changed = true;
        } else if (val && Array.isArray(val.fields)) {
          store[cat] = {
            fields: val.fields,
            groupOrder: Array.isArray(val.groupOrder) && val.groupOrder.length
              ? val.groupOrder
              : this._deriveGroupOrder(val.fields),
          };
          if (!Array.isArray(val.groupOrder) || val.groupOrder.length === 0) changed = true;
        }
      });
    }
    Object.keys(FORM_DEFAULTS).forEach(cat => {
      if (!store[cat] || !Array.isArray(store[cat].fields) || store[cat].fields.length === 0) {
        store[cat] = this._upgradeCategory(FORM_DEFAULTS[cat].map(f => ({ ...f, visible: f.defaultVisible })));
        changed = true;
      }
    });
    if (changed) Storage.set(this._key, store);
    return store;
  },

  getAll(cat = "apartment") {
    const s = this._store()[cat];
    return (s && s.fields) || [];
  },

  getGroupOrder(cat = "apartment") {
    const s = this._store()[cat];
    return (s && s.groupOrder) || [];
  },

  saveCat(cat, fields, groupOrder) {
    const store = this._store();
    const prev = store[cat] || { fields: [], groupOrder: [] };
    store[cat] = {
      fields,
      groupOrder: groupOrder || prev.groupOrder || this._deriveGroupOrder(fields),
    };
    Storage.set(this._key, store);
  },

  setGroupOrder(cat, groupOrder) {
    const store = this._store();
    if (!store[cat]) store[cat] = { fields: [], groupOrder: [] };
    store[cat].groupOrder = groupOrder;
    Storage.set(this._key, store);
  },

  addGroup(cat, groupName) {
    const order = this.getGroupOrder(cat);
    if (order.includes(groupName)) return;
    this.setGroupOrder(cat, [...order, groupName]);
  },

  renameGroup(cat, oldName, newName) {
    if (!newName || oldName === newName) return;
    const order = this.getGroupOrder(cat).map(g => g === oldName ? newName : g);
    const fields = this.getAll(cat).map(f => f.group === oldName ? { ...f, group: newName } : f);
    this.saveCat(cat, fields, order);
  },

  removeGroup(cat, groupName, fallbackGroup = "Inne") {
    const order = this.getGroupOrder(cat).filter(g => g !== groupName);
    const fields = this.getAll(cat).map(f => f.group === groupName ? { ...f, group: fallbackGroup } : f);
    if (!order.includes(fallbackGroup)) order.push(fallbackGroup);
    this.saveCat(cat, fields, order);
  },

  moveGroup(cat, groupName, direction) {
    const order = this.getGroupOrder(cat);
    const idx = order.indexOf(groupName);
    if (idx < 0) return;
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= order.length) return;
    const reordered = [...order];
    [reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]];
    this.setGroupOrder(cat, reordered);
  },

  // Widoczne pola posortowane po order
  visible(cat = "apartment") { return this.getAll(cat).filter(f => f.visible).sort((a, b) => a.order - b.order); },

  // Wszystkie pola posortowane po order
  sorted(cat = "apartment") { return this.getAll(cat).sort((a, b) => a.order - b.order); },

  // Toggle visibility
  setVisible(id, visible, cat = "apartment") {
    this.saveCat(cat, this.getAll(cat).map(f => f.id === id ? { ...f, visible } : f));
  },

  // Add custom field (rozszerzone: required, options, placeholder, defaultValue, własne id)
  addField(field, cat = "apartment") {
    const all = this.getAll(cat);
    const label = (field.label || "").trim();
    if (!label) return null;
    const maxOrder = Math.max(0, ...all.map(f => f.order));
    // id: jawne lub slug z etykiety; zawsze prefiks custom_ żeby nie kolidować z builtin
    let base = String(field.id || "").trim();
    if (!base) {
      base = label.toLowerCase()
        .replace(/[ąàá]/g, "a").replace(/[ćč]/g, "c").replace(/[ęèé]/g, "e")
        .replace(/ł/g, "l").replace(/[ńñ]/g, "n").replace(/[óòö]/g, "o")
        .replace(/[śš]/g, "s").replace(/[żź]/g, "z").replace(/[üú]/g, "u")
        .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    }
    let id = base.startsWith("custom_") ? base : `custom_${base || Date.now()}`;
    let uid = id, n = 2;
    while (all.some(f => f.id === uid)) uid = `${id}_${n++}`;
    const groupName = field.group || "Inne";
    const entry = {
      id: uid,
      label,
      group: groupName,
      type: field.type || "text",
      required: !!field.required,
      defaultVisible: true,
      visible: true,
      order: maxOrder + 1,
      custom: true,
    };
    if (entry.type === "select") entry.options = Array.isArray(field.options) ? field.options.filter(o => String(o).trim()) : [];
    if (field.placeholder) entry.placeholder = field.placeholder;
    if (field.defaultValue !== undefined && field.defaultValue !== "") entry.defaultValue = field.defaultValue;
    // PAKIET 8b — jeśli pole trafia do nowej grupy spoza groupOrder, dopisz ją
    const order = this.getGroupOrder(cat);
    const nextOrder = order.includes(groupName) ? order : [...order, groupName];
    this.saveCat(cat, [...all, entry], nextOrder);
    return entry;
  },

  // Aktualizacja właściwości pola (label, required, visible, group, placeholder, defaultValue, options, order;
  // type/options zmienne tylko dla pól własnych — builtin ma typ związany z obiektem)
  updateField(id, changes, cat = "apartment") {
    const all = this.getAll(cat);
    const updated = all.map(f => {
      if (f.id !== id) return f;
      const next = { ...f, ...changes, id: f.id };
      if (!f.custom) next.type = f.type; // builtin: typ niezmienny
      if (next.type !== "select") delete next.options;
      else if (!Array.isArray(next.options)) next.options = f.options || [];
      return next;
    });
    // PAKIET 8b — jeśli zmieniono grupę na nową, dopisz ją do groupOrder
    let order = this.getGroupOrder(cat);
    if (changes && changes.group && !order.includes(changes.group)) {
      order = [...order, changes.group];
    }
    this.saveCat(cat, updated, order);
  },

  removeField(id, cat = "apartment") {
    this.saveCat(cat, this.getAll(cat).filter(f => f.id !== id || !f.custom));
  },

  // Reset schemy danej kategorii do domyślnej (usuwa pola własne, cofa zmiany)
  resetAll(cat = "apartment") {
    const seed = (FORM_DEFAULTS[cat] || []).map(f => ({ ...f, visible: f.defaultVisible }));
    this.saveCat(cat, seed, this._deriveGroupOrder(seed));
    return seed;
  },
};

const EquipmentRooms = {
  _key: "equip_rooms",  // MUST-4: bez prefiksu

  getAll() {
    const stored = Storage.get(this._key);
    if (stored && Array.isArray(stored) && stored.length > 0) {
      // PAKIET 8a.3 — sortowanie po order (fallback do 999 dla starych rekordów bez pola)
      return [...stored].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    }
    const seed = DEFAULT_ROOMS.map((name, i) => ({
      id: `room_${i}`, name, builtin: true, aptId: null, order: i, // null = globalna
    }));
    this.save(seed);
    return seed;
  },

  save(list) { Storage.set(this._key, list); },

  // Pomieszczenia widoczne dla danego apt: globalne (aptId=null) + przypisane do tego apt
  forApt(aptId) {
    return this.getAll().filter(r => !r.aptId || r.aptId === aptId);
  },

  // Tylko globalne
  global() { return this.getAll().filter(r => !r.aptId); },

  add(room) {
    const list = this.getAll();
    const id = `room_${Date.now()}_${Math.random().toString(36).slice(2,5)}`;
    const maxOrder = list.reduce((m, r) => Math.max(m, r.order ?? 0), 0);
    const entry = {
      id,
      name: (room.name || "").trim(),
      builtin: false,
      aptId: room.aptId || null, // null = globalna, number = per-apt
      order: maxOrder + 1,
    };
    if (!entry.name) return null;
    this.save([...list, entry]);
    return entry;
  },

  update(id, patch) {
    this.save(this.getAll().map(r => r.id === id ? { ...r, ...patch, builtin: r.builtin } : r));
  },

  // PAKIET 8a.3 — reorder po liście id (kolejność na liście = nowy order)
  reorder(orderedIds) {
    const map = Object.fromEntries(orderedIds.map((id, i) => [id, i]));
    const list = this.getAll().map(r => ({ ...r, order: map[r.id] ?? r.order ?? 999 }));
    this.save(list);
    return list;
  },

  remove(id) {
    this.save(this.getAll().filter(r => r.id !== id));
  },

  // Nazwy pokoi (do selectów)
  namesForApt(aptId) {
    return [...new Set(this.forApt(aptId).map(r => r.name))];
  },
};

const Settings = {
  _key: "settings",  // MUST-4: bez prefiksu

  getAll() {
    return Storage.get(this._key) || {
      smsTemplates: { ...DEFAULT_SMS_TEMPLATES },
      smsOverrides: {}, // { [aptId]: "custom template" }
      cleaningLeaders: [], // osoby dowodzące sprzątaniem — uzupełnij w panelu Ustawienia
    };
  },
  save(settings) { Storage.set(this._key, settings); },

  // ── Cleaning leaders ──────────────────────────────────────────────────
  getCleaningLeaders() { return this.getAll().cleaningLeaders || []; },
  setCleaningLeaders(leaders) {
    const s = this.getAll();
    s.cleaningLeaders = leaders;
    this.save(s);
  },

  getTemplateForApt(apt) {
    const s = this.getAll();
    if ((s.smsOverrides || {})[apt.id]) return s.smsOverrides[apt.id];
    return (s.smsTemplates || {})[apt.status] || DEFAULT_SMS_TEMPLATES[apt.status] || DEFAULT_SMS_TEMPLATES["ZARZĄDZANIE"];
  },

  hasOverride(aptId) {
    const s = this.getAll();
    return !!(s.smsOverrides || {})[aptId];
  },

  setGlobalTemplate(type, template) {
    const s = this.getAll();
    s.smsTemplates = { ...s.smsTemplates, [type]: template };
    this.save(s);
  },

  setOverride(aptId, template) {
    const s = this.getAll();
    s.smsOverrides = { ...(s.smsOverrides || {}), [aptId]: template };
    this.save(s);
  },

  removeOverride(aptId) {
    const s = this.getAll();
    if (s.smsOverrides) { delete s.smsOverrides[aptId]; }
    this.save(s);
  },

  // Podstawienie zmiennych
  render(template, apt) {
    return (template || "")
      .replace(/{aptName}/g, apt.name || "")
      .replace(/{code}/g, apt.safeCode || "")
      .replace(/{wifi}/g, (apt.wifi || "").split("\n")[0] || "")
      .replace(/{address}/g, apt.address || "")
      .replace(/{checkinTime}/g, apt.checkinTime || "")
      .replace(/{checkoutTime}/g, apt.checkoutTime || "");
  },
};

// ── Cleaning Sessions — historia sprzątania z timerem ─────────────────────
// Struktura: { id, apartmentId, date, assignedTo, startedAt, finishedAt, durationSec, notes, status }
// status: "planned" | "in_progress" | "done"
const CLEANING_STORAGE_KEY = "cleaning";  // MUST-4: bez prefiksu — Storage._ns dokleja "velarflow:"

const CleaningSessions = {
  getAll() { return Storage.get(CLEANING_STORAGE_KEY) || []; },
  save(sessions) { Storage.set(CLEANING_STORAGE_KEY, sessions); },

  forDate(dateStr) { return this.getAll().filter(s => s.date === dateStr); },
  forApartment(aptId) { return this.getAll().filter(s => s.apartmentId === aptId).sort((a,b) => b.date.localeCompare(a.date)); },

  planForDate(dateStr, apartments) {
    // Plan bazuje na apt.nextCheckout = data wyjazdu
    // Jeśli apt.nextCheckout === dateStr → dodaj sesję
    const existing = this.forDate(dateStr).map(s => s.apartmentId);
    const toAdd = apartments
      .filter(a => !existing.includes(a.id) &&
        (a.nextCheckout && a.nextCheckout.slice(0,10) === dateStr))
      .map(a => ({
        id: `cls_${a.id}_${dateStr}_${Date.now()}`,
        apartmentId: a.id,
        date: dateStr,
        assignedTo: "",
        startedAt: null,
        finishedAt: null,
        durationSec: 0,
        notes: "",
        status: "planned",
        createdAt: new Date().toISOString(),
      }));
    if (toAdd.length > 0) {
      const all = this.getAll();
      this.save([...all, ...toAdd]);
    }
    return this.forDate(dateStr);
  },

  // Zwraca apartamenty które zwalniają się danego dnia (nextCheckout = date)
  apartmentsCheckingOutOn(dateStr, apartments) {
    return apartments.filter(a => a.nextCheckout && a.nextCheckout.slice(0,10) === dateStr);
  },

  addSession(aptId, dateStr, assignedTo = "") {
    const session = {
      id: `cls_${aptId}_${dateStr}_${Date.now()}`,
      apartmentId: aptId,
      date: dateStr,
      assignedTo,
      startedAt: null,
      finishedAt: null,
      durationSec: 0,
      notes: "",
      status: "planned",
      createdAt: new Date().toISOString(),
    };
    this.save([...this.getAll(), session]);
    return session;
  },

  startSession(id) {
    const all = this.getAll().map(s =>
      s.id === id ? { ...s, status: "in_progress", startedAt: new Date().toISOString() } : s
    );
    this.save(all);
  },

  stopSession(id) {
    const all = this.getAll();
    const s = all.find(x => x.id === id);
    if (!s) return;
    const startMs = s.startedAt ? new Date(s.startedAt).getTime() : Date.now();
    const elapsed = Math.floor((Date.now() - startMs) / 1000);
    this.save(all.map(x => x.id === id ? { ...x, status: "planned", startedAt: null, durationSec: (x.durationSec || 0) + elapsed } : x));
  },

  finishSession(id, notes = "") {
    const all = this.getAll();
    const s = all.find(x => x.id === id);
    if (!s) return;
    const startMs = s.startedAt ? new Date(s.startedAt).getTime() : Date.now();
    const elapsed = s.startedAt ? Math.floor((Date.now() - startMs) / 1000) : 0;
    this.save(all.map(x => x.id === id ? {
      ...x, status: "done",
      finishedAt: new Date().toISOString(),
      durationSec: (x.durationSec || 0) + elapsed,
      notes: notes || x.notes,
    } : x));
  },

  updateAssigned(id, assignedTo) {
    this.save(this.getAll().map(s => s.id === id ? { ...s, assignedTo } : s));
  },

  deleteSession(id) { this.save(this.getAll().filter(s => s.id !== id)); },

  formatDuration(sec) {
    if (!sec) return "—";
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  },
};

// ════════════════════════════════════════════════════════════════════════════
// § VALIDATORS (#30–#34)
// ════════════════════════════════════════════════════════════════════════════
const V = {
  required: (v) => (v != null && String(v).trim().length > 0) ? null : "Pole wymagane",
  minLen: (n) => (v) => (!v || v.length >= n) ? null : `Min. ${n} znaki`,
  maxLen: (n) => (v) => (!v || v.length <= n) ? null : `Maks. ${n} znaków`,
  isNumber: (v) => (v === "" || v == null || !isNaN(Number(v))) ? null : "Musi być liczbą", // FIX #33: walidacja typu
  positiveNum: (v) => { if (v === "" || v == null) return null; return (Number(v) >= 0 && !isNaN(Number(v))) ? null : "Musi być ≥ 0"; },
  range: (min, max) => (v) => { if (v === "" || v == null) return null; const n = Number(v); return (!isNaN(n) && n >= min && n <= max) ? null : `Zakres: ${min}–${max}`; },
  // FIX #30: email — praktyczny RFC subset (#30)
  email: (v) => {
    if (!v) return null;
    const t = v.trim();
    if (t.length > 254) return "E-mail zbyt długi (max 254 znaków)";
    if (t.includes("..") || t.startsWith(".") || t.endsWith(".")) return "Nieprawidłowy format";
    if (!t.includes("@")) return "Brak znaku @";
    const [local, domain] = t.split("@");
    if (!local || local.length > 64) return "Nieprawidłowa część lokalna";
    if (!domain || !domain.includes(".")) return "Nieprawidłowa domena";
    return /^[^\s@"(),:;<>[\]\\]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(t) ? null : "Nieprawidłowy format e-mail";
  },
  // FIX #31: phone — bardziej precyzyjny (#31)
  phone: (v) => {
    if (!v) return null;
    const cleaned = v.replace(/[\s\-()]/g, "");
    if (!/^\+?[\d]{6,15}$/.test(cleaned)) return "Nieprawidłowy numer (6–15 cyfr)";
    return null;
  },
  // FIX #7: noScript — rozszerzone wzorce XSS (#7)
  noScript: (v) => {
    if (!v) return null;
    const dangerous = [
      /<script[\s>]/i,
      /javascript\s*:/i,
      /<iframe[\s>]/i,
      /<object[\s>]/i,
      /<embed[\s>]/i,
      /<img[^>]+onerror\s*=/i,           // <img onerror=...>
      /<svg[^>]*on\w+\s*=/i,             // SVG event handlers
      /on(?:load|error|click|mouse\w+|key\w+|focus|blur|submit|change|input|drag\w*|pointer\w*)\s*=/i,
      /vbscript\s*:/i,
      /data\s*:\s*text\/(?:html|javascript)/i,
      /expression\s*\(/i,
      /%3[Cc]script/i,                   // URL-encoded <script
      /&#x?0*3[Cc];?script/i,            // HTML entity <script
      /\u003cscript/i,                   // Unicode \u003c
      /\\u003cscript/i,                  // String-escaped unicode
    ];
    return dangerous.some(p => p.test(v)) ? "Niedozwolona treść (skrypt)" : null;
  },
  safeCode: (v) => (!v || /^[\d#*]{3,12}$/.test(v)) ? null : "Kod: 3–12 cyfr/znaków",
};

const SCHEMAS = {
  apartment: {
    name:        [V.required, V.maxLen(80), V.noScript],
    address:     [V.maxLen(150), V.noScript],
    capacity:    [V.positiveNum, V.range(1, 30)],
    distanceSea: [V.positiveNum, V.range(0, 10000)],
    safeCode:    [V.safeCode],
    wifi:        [V.maxLen(200), V.noScript],
    notes:       [V.maxLen(1000), V.noScript],
  },
  task: {
    title:       [V.required, V.maxLen(200), V.noScript],
    notes:       [V.maxLen(1000), V.noScript],
    assignedTo:  [V.required],
    apartmentId: [V.required],
  },
  owner: {
    firstName:   [V.required, V.maxLen(60), V.noScript],
    lastName:    [V.required, V.maxLen(60), V.noScript],
    email:       [V.email],
    phone:       [V.phone],
    percent:     [V.range(0, 100)],
    invoiceData: [V.maxLen(500), V.noScript],
  },
  login: {
    email:       [V.required, V.email],
    password:    [V.required, V.minLen(6)],
  },
};

const runValidation = (schemaKey, data) => {
  const schema = SCHEMAS[schemaKey] || {};
  const errors = {};
  for (const [field, rules] of Object.entries(schema)) {
    for (const rule of (rules || [])) {
      const err = rule(data[field]);
      if (err) { errors[field] = err; break; }
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
};

// ════════════════════════════════════════════════════════════════════════════
// § DANE — mock/seed data (tylko DEMO i offline fallback)
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// MUST-3: __DEMO_BUILD__ jest build-time literałem.
// W produkcji __DEMO_BUILD__ === false → cały blok znika z bundla po minifikacji.
// CONFIG.isDemo to **runtime** check (URL Supabase), więc go nie używamy tutaj —
// w przeciwnym razie hasła trafiałyby do bundla nawet w produkcji.
const DEMO_USERS = __DEMO_BUILD__ ? [
  { email: "manager@demo.velarflow.app",     password: "Demo#2026!", role: "manager",       name: "Anna Manager" },
  { email: "worker@demo.velarflow.app",      password: "Demo#2026!", role: "worker",        name: "Jan Pracownik" },
  { email: "cleaning@demo.velarflow.app",    password: "Demo#2026!", role: "cleaning_team", name: "Zespół Sprzątający" },
  { email: "maintenance@demo.velarflow.app", password: "Demo#2026!", role: "maintenance",   name: "Tomasz Konserwator" },
] : [];

// ⚠ DANE DEMO (fikcyjne) — minimum przykładowych rekordów do demonstracji UI.
// MUST-3: Również za __DEMO_BUILD__ — w produkcji bundle nie zawiera tych danych.
// Wszystkie nazwy, adresy, dane są wymyślone i nie reprezentują żadnego prawdziwego biznesu.
const MOCK_OWNERS = __DEMO_BUILD__ ? [
  { id:1, firstName:"Jan",  lastName:"Kowalski", phone:"+48 600 100 200", email:"jan.kowalski@example.com",  kwLogin:"", kwPassword:"", percent:25, billingMethod:"Faktura miesięczna",      invoiceData:"Jan Kowalski\nul. Przykładowa 1, 00-001 Warszawa",   status:"ZARZĄDZANIE" },
  { id:2, firstName:"Anna", lastName:"Nowak",    phone:"+48 600 200 300", email:"anna.nowak@example.com",     kwLogin:"", kwPassword:"", percent:30, billingMethod:"Faktura kwartalna",       invoiceData:"Anna Nowak\nul. Testowa 5, 00-002 Warszawa",        status:"ZARZĄDZANIE" },
  { id:3, firstName:"Piotr",lastName:"Wiśniewski",phone:"+48 600 300 400",email:"piotr.wisniewski@example.com",kwLogin:"",kwPassword:"", percent:20, billingMethod:"E-mail z prośbą o fakturę",invoiceData:"Piotr Wiśniewski\nul. Demonstracyjna 12, 00-003 Warszawa", status:"OBSŁUGA" },
] : [];

const MOCK_APARTMENTS = __DEMO_BUILD__ ? [
  {
    id:1, name:"Apartament Demo 01", onlineName:"VIEW & SEA", aptStatus:"Wolny",
    address:"ul. Przykładowa 10, 00-001 Warszawa",
    distanceSea:50, capacity:4, floor:"2", aptNumber:"10",
    ownerId:1, status:"ZARZĄDZANIE",
    domofon:"--- (kod do uzupełnienia)",
    securityType:"SEJFIK", safeCode:"---",
    wifi:"--- (SSID)\nHasło: ---",
    parking:"GARAŻ", parkingNumber:"--",
    checkoutTime:"11:00", checkinTime:"16:00",
    keys:"Klucze do drzwi wejściowych\nKarta wjazdowa\nPilot do garażu",
    garage:"", entryInstruction:"Instrukcja wejścia — uzupełnij w panelu apartamentu",
    bedding:"Łóżko 160x200, Sofa rozkładana 140x190",
    notes:"Demo — przykładowe dane apartamentu. Edytuj w panelu.",
    kwName:"", kaucja:300, cleaningSezon:200, cleaningOffSezon:150,
    bookingLink:"",
  },
  {
    id:2, name:"Apartament Demo 02", onlineName:"COMFORT STUDIO", aptStatus:"Zajęty",
    address:"ul. Testowa 22, 00-002 Warszawa",
    distanceSea:0, capacity:2, floor:"1", aptNumber:"22",
    ownerId:2, status:"ZARZĄDZANIE",
    domofon:"--- (kod do uzupełnienia)",
    securityType:"KLAMKA GENEROWANA", safeCode:"---",
    wifi:"--- (SSID)\nHasło: ---",
    parking:"NAZIEMNE", parkingNumber:"--",
    checkoutTime:"11:00", checkinTime:"16:00",
    keys:"Karta + Pilot",
    garage:"", entryInstruction:"",
    bedding:"Łóżko 140x200",
    notes:"",
    nextCheckout:"2026-05-02",
    kwName:"", kaucja:300, cleaningSezon:180, cleaningOffSezon:150,
    bookingLink:"",
  },
  {
    id:3, name:"Apartament Demo 03", onlineName:"", aptStatus:"Wolny",
    address:"ul. Demonstracyjna 5, 00-003 Warszawa",
    distanceSea:0, capacity:6, floor:"PARTER", aptNumber:"5",
    ownerId:3, status:"OBSŁUGA",
    domofon:"", securityType:"SEJFIK", safeCode:"",
    wifi:"", parking:"", parkingNumber:"",
    checkoutTime:"11:00", checkinTime:"16:00",
    keys:"", garage:"", entryInstruction:"", bedding:"", notes:"",
    kwName:"", kaucja:0, cleaningSezon:0, cleaningOffSezon:0,
    bookingLink:"",
  },
] : [];

const MOCK_TASKS = __DEMO_BUILD__ ? [
  { id:1, apartmentId:1, title:"Przykładowe zadanie — sprawdzenie wyposażenia", assignedTo:"Jan Pracownik", status:"Nie rozpoczęto", createdAt:"2026-04-20", nextCheckout:"", nextCheckin:"", notes:"Edytuj w panelu zadań.", location:"Apartament Demo 01", orderBy:"Anna Manager", photo:null },
  { id:2, apartmentId:2, priority:"high", title:"Sprzątanie po wyjeździe gości", assignedTo:"Zespół Sprzątający", status:"W trakcie", createdAt:"2026-04-22", nextCheckout:"2026-04-22T11:00", nextCheckin:"2026-04-23T16:00", notes:"", location:"Apartament Demo 02", orderBy:"Anna Manager", photo:null },
] : [];

const WORKERS = ["Jan Pracownik","Anna Manager","Tomasz Konserwator","Zespół Sprzątający"];

const STATUS_COLORS = {
  "Wolny": "#22c55e",
  "Zajęty": "#ef4444",
  "Wolny/Dzisiaj przyjazd": "#f59e0b",
  "Zajęty/Jutro się zwolni": "#f59e0b",
  "Dzisiaj wyjazd gości": "#f97316",
};

// APT_TYPE_COLORS — dynamiczny lookup z Categories module
// Obsługuje dostęp przez "ZARZĄDZANIE" → zwraca color z kategorii
// W starym kodzie używane jako APT_TYPE_COLORS["ZARZĄDZANIE"] albo APT_TYPE_COLORS[apt.status]
const APT_TYPE_COLORS = new Proxy({}, {
  get(_, key) {
    if (typeof key !== "string") return undefined;
    const cat = Categories.getByName(key);
    return cat && cat.color || undefined;
  },
});

const TASK_STATUS_COLORS = {
  "Nie rozpoczęto": "#ef4444",
  "W trakcie": "#f59e0b",
  "Zrobione": "#22c55e",
  "Zakończono": "#22c55e",
};

// ─── ICONS ───────────────────────────────────────────────────────────────────
const Icon = ({ name, size = 20, color = "currentColor" }) => {
  const icons = {
    home: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
    tasks: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
    users: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
    back: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>,
    "chevron-left": <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>,
    "chevron-right": <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>,
    plus: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
    minus: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>,
    edit: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
    trash: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>,
    key: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>,
    phone: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.56 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>,
    mail: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
    star: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
    check: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
    x: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
    search: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
    info: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>,
    map: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>,
    calendar: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
    sync: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>,
    building: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="8" y1="6" x2="16" y2="6"/><line x1="8" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="16" y2="14"/><line x1="8" y1="18" x2="16" y2="18"/></svg>,
    lock: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>,
    logout: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
    shield: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
    user: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
    wave: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3-8 6-8 6 8 6 8 3-8 6-8"/><path d="M2 20s3-8 6-8 6 8 6 8 3-8 6-8"/></svg>,
    tent: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 20 L12 4 L21 20 Z"/><path d="M12 4 L12 20"/><path d="M8 20 L12 14 L16 20"/></svg>,
    tree: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 14v7M7 14v7M12 2l5 7h-3l3 5H9l3-5H6z"/></svg>,
    car: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 16H9m10 0h3v-3.15a1 1 0 0 0-.84-.99L16 11l-2.7-3.6a1 1 0 0 0-.8-.4H5.24a2 2 0 0 0-1.8 1.1l-.8 1.63A6 6 0 0 0 2 12.42V16h2"/><circle cx="6.5" cy="16.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/></svg>,
    package: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
    link: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
    file: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>,
    settings: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
    swap: <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>,
  };
  return icons[name] || null;
};

// ─── NUMBER INPUT (FIX 1.3 + 1.4) ─────────────────────────────────────────────
// Trzyma wartość jako STRING (np. "0", "", "40") — konwersja na number dopiero
// przy zapisie po stronie konsumenta. Dzięki temu zaznaczenie "0" i wpisanie "40"
// działa naturalnie. onFocus zaznacza całość. Natywne strzałki są ukryte CSS-em;
// `steppers` (domyślnie true) renderuje nowoczesne przyciski +/- (32×32).
// W ciasnych wierszach (qty obok nazwy) używaj `steppers={false}`.
const NumberInput = ({
  value, onChange, min, max, step = 1,
  placeholder, disabled = false, steppers = true,
  className = "form-input", style = {}, onBlur,
}) => {
  const inpRef = useRef(null);
  const stepStr = String(step);
  const decimals = stepStr.includes(".") ? stepStr.split(".")[1].length : 0;

  const fmt = (n) => {
    if (min != null && n < Number(min)) n = Number(min);
    if (max != null && n > Number(max)) n = Number(max);
    return decimals ? n.toFixed(decimals) : String(n);
  };

  const bump = (dir) => {
    if (disabled) return;
    const parsed = parseFloat(value);
    const cur = isNaN(parsed) ? 0 : parsed;
    onChange(fmt(cur + dir * Number(step)));
    requestAnimationFrame(() => { if (inpRef.current) inpRef.current.focus(); });
  };

  const input = (
    <input
      ref={inpRef}
      className={`${className} num-input`}
      type="number"
      inputMode={decimals ? "decimal" : "numeric"}
      value={value == null ? "" : value}
      min={min} max={max} step={step}
      placeholder={placeholder}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
      onFocus={e => e.target.select()}
      onBlur={onBlur}
      style={steppers ? undefined : style}
    />
  );

  if (!steppers) return input;

  const num = parseFloat(value);
  return (
    <div className="num-input-wrap" style={style}>
      <button type="button" className="num-stepper" tabIndex={-1} aria-label="Zmniejsz"
        disabled={disabled || (min != null && !isNaN(num) && num <= Number(min))}
        onClick={() => bump(-1)}><Icon name="minus" size={16} /></button>
      {input}
      <button type="button" className="num-stepper" tabIndex={-1} aria-label="Zwiększ"
        disabled={disabled || (max != null && !isNaN(num) && num >= Number(max))}
        onClick={() => bump(1)}><Icon name="plus" size={16} /></button>
    </div>
  );
};

// ─── SCROLLABLE TABS (FIX 5.3) ─────────────────────────────────────────────────
// Reużywalny wrapper poziomej listy zakładek: scroll kółkiem myszy → poziomy scroll,
// plus strzałki ‹ › po bokach (pojawiają się tylko gdy jest co przewijać).
// Dzieci (np. lista .tab) trafiają do scrollowanego kontenera; przekaż className="tabs"
// aby zachować istniejący styl listy zakładek.
const ScrollableTabs = ({ children, className = "" }) => {
  const scrollRef = useRef(null);
  const lastActiveKey = useRef("");
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const updateArrows = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 4);
  }, []);

  // Smooth horizontal scroll TYLKO kontenera (NIE window/sticky) — scrollTo zamiast
  // scrollIntoView (scrollIntoView z block:"nearest" przy sticky parencie potrafi
  // scrollować całą stronę). lastActiveKey blokuje powtórne wywołanie, gdy parent
  // re-renderuje a active się nie zmieniło → brak szarpania.
  const centerActive = useCallback(() => {
    const el = scrollRef.current;
    if (!el || el.scrollWidth <= el.clientWidth + 4) return;
    const active = el.querySelector(".tab.active, .active");
    if (!active) {
      lastActiveKey.current = "";
      return;
    }
    const key = active.textContent || "";
    if (key === lastActiveKey.current) return;
    lastActiveKey.current = key;
    // rAF: pozwala React zakończyć reconciliation; smooth scroll nie konkuruje z layoutem.
    requestAnimationFrame(() => {
      const el2 = scrollRef.current;
      if (!el2) return;
      const active2 = el2.querySelector(".tab.active, .active");
      if (!active2) return;
      const elRect = el2.getBoundingClientRect();
      const aRect  = active2.getBoundingClientRect();
      const delta  = (aRect.left + aRect.width / 2) - (elRect.left + elRect.width / 2);
      const max    = el2.scrollWidth - el2.clientWidth;
      el2.scrollTo({ left: Math.max(0, Math.min(max, el2.scrollLeft + delta)), behavior: "smooth" });
    });
  }, []);

  // Mount-only: listenery (NIE re-rejestrujemy ich na każdy render → brak race'ów ze smooth scrollem).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
      updateArrows();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", updateArrows);
    window.addEventListener("resize", updateArrows);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", updateArrows);
      window.removeEventListener("resize", updateArrows);
    };
  }, [updateArrows]);

  // Po każdym renderze sprawdź arrows + (jeśli active się zmieniło) wyśrodkuj.
  useEffect(() => {
    updateArrows();
    centerActive();
  });

  const scrollBy = (dir) => {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: dir * 200, behavior: "smooth" });
  };

  return (
    <div className="scrollable-tabs-wrap">
      {canLeft && (
        <button className="stabs-arrow stabs-arrow-left" onClick={() => scrollBy(-1)} aria-label="Przewiń w lewo">
          <Icon name="chevron-left" size={18} />
        </button>
      )}
      <div ref={scrollRef} className={`scrollable-tabs ${className}`}>
        {children}
      </div>
      {canRight && (
        <button className="stabs-arrow stabs-arrow-right" onClick={() => scrollBy(1)} aria-label="Przewiń w prawo">
          <Icon name="chevron-right" size={18} />
        </button>
      )}
    </div>
  );
};

// ─── useMediaQuery (FIX: master-detail) ────────────────────────────────────────
// Śledzi czy media query pasuje (np. szeroki ekran) — do decyzji split vs pełny ekran.
const useMediaQuery = (q) => {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(q).matches);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(q);
    const handler = (e) => setMatches(e.matches);
    mq.addEventListener("change", handler);
    setMatches(mq.matches);
    return () => mq.removeEventListener("change", handler);
  }, [q]);
  return matches;
};

// ─── BRAND LOGO ──────────────────────────────────────────────────────────────
// VelarFlow — monogram VF (rekonstrukcja z brand assets, do podmiany na oryginalny SVG od projektanta)
// Użycie:
//   <VelarLogo size={32} />               — sam monogram
//   <VelarLogo size={32} withWordmark />   — monogram + napis "VelarFlow"
const VelarLogo = ({ size = 32, withWordmark = false, taglineText = null }) => {
  const monogram = (
    <svg width={size} height={size} viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
      <defs>
        <linearGradient id="vfGradF" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#60A5FA" />
          <stop offset="100%" stopColor="#3B82F6" />
        </linearGradient>
      </defs>
      {/* Litera V — biała */}
      <path d="M 8 12 L 18 12 L 26 42 L 28 42 L 28 50 L 22 50 Z" fill="#FFFFFF" />
      <path d="M 28 42 L 36 12 L 46 12 L 32 50 L 28 50 Z" fill="#FFFFFF" />
      {/* Litera F — niebieska, stylizowane "paski" sugerujące flow */}
      <path d="M 36 14 L 56 14 L 56 22 L 44 22 L 44 26 L 52 26 L 52 32 L 44 32 L 44 50 L 36 50 Z" fill="url(#vfGradF)" />
      {/* Akcent — kropka/półkole sugerujące "flow" */}
      <circle cx="55" cy="29" r="3" fill="#60A5FA" opacity="0.9" />
    </svg>
  );

  if (!withWordmark) return monogram;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      {monogram}
      <div>
        <div style={{
          fontFamily: "var(--font-display)",
          fontSize: size * 0.85,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          lineHeight: 1,
          color: "var(--text)",
        }}>
          Velar<span style={{ color: "var(--accent)" }}>Flow</span>
        </div>
        {taglineText && (
          <div style={{
            fontSize: Math.max(9, size * 0.28),
            color: "var(--text2)",
            fontWeight: 500,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            marginTop: 4,
          }}>{taglineText}</div>
        )}
      </div>
    </div>
  );
};

// ─── STYLES ──────────────────────────────────────────────────────────────────
// MUST-5 / FIX #7: Content-Security-Policy
// ────────────────────────────────────────────────────────────────────────────
// Meta CSP **nie działa** wstrzykiwane przez React po hydrate (przeglądarka
// ignoruje meta CSP dodane do DOM-u po początkowym parsowaniu HTML).
// Aby CSP zadziałał, MUSI być w jednym z:
//   1) HTTP header `Content-Security-Policy` z serwera/CDN (preferowane)
//   2) <meta http-equiv="..."> w SUROWYM index.html PRZED <script src="bundle.js">
//
// W vite/CRA: dodaj poniższy meta-tag do public/index.html (przed <script>).
// W nginx/Cloudflare: dodaj header w konfiguracji serwera.
//
// Snippet poniżej jest TYLKO referencyjny (eksportowany na potrzeby testów /
// generatorów index.html); nie próbuje renderować się w runtime.
// eslint-disable-next-line no-unused-vars
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' https://*.supabase.co;">`;

const styles = `
  @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap');

  * { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #00040F;
    --surface: #0B1220;
    --surface2: #161D2A;
    --border: #1E2D47;
    --accent: #3B82F6;
    --accent2: #60A5FA;
    --accent-glow: rgba(59,130,246,0.4);
    --text: #FFFFFF;
    --text2: #94A3B8;
    --text3: #64748B;
    --green: #10B981;
    --red: #EF4444;
    --yellow: #F59E0B;
    --radius: 16px;
    --font-display: 'Outfit', sans-serif;
    --font-body: 'Plus Jakarta Sans', sans-serif;
  }

  [data-theme="light"] {
    --bg: #F8FAFC;
    --surface: #FFFFFF;
    --surface2: #F1F5F9;
    --border: #E2E8F0;
    --accent: #2563EB;
    --accent2: #3B82F6;
    --accent-glow: rgba(37,99,235,0.25);
    --text: #0F172A;
    --text2: #475569;
    --text3: #94A3B8;
    --green: #059669;
    --red: #DC2626;
    --yellow: #D97706;
  }
  [data-theme="light"] .sidebar { background: #fff; }
  [data-theme="light"] .login-screen { background: var(--bg); }
  [data-theme="light"] .avatar { border: 1px solid var(--border); }
  [data-theme="light"] .header { background: #fff; border-bottom-color: #ddd; }
  [data-theme="light"] .detail-hero { background: #f8f8fc; }
  [data-theme="light"] .sidebar-logo-text { color: var(--accent); }
  [data-theme="light"] .login-title { color: var(--text); }
  [data-theme="light"] .login-logo-text { color: var(--text); }
  [data-theme="light"] .form-input, [data-theme="light"] .form-textarea, [data-theme="light"] .form-select {
    background: #f5f5f8; border-color: #d8d8e0; color: #1a1a2e;
  }
  [data-theme="light"] .search-bar { background: #f0f0f4; }
  [data-theme="light"] .search-bar input { color: #1a1a2e; }
  [data-theme="light"] .sms-template-box { background: #f5f5f8; border-color: #d8d8e0; color: #1a1a2e; }
  [data-theme="light"] .bottom-nav { background: #fff; border-top-color: #ddd; }
  [data-theme="light"] .cleaning-card { background: #fff; }
  [data-theme="light"] .tabs { background: var(--bg); }
  [data-theme="light"] input[type="date"] { color-scheme: light; }

  body { background: var(--bg); color: var(--text); font-family: var(--font-body); font-size: 15px; line-height: 1.5; -webkit-font-smoothing: antialiased; }

  /* ─── DESKTOP LAYOUT ─── */
  .app-root { display: flex; min-height: 100vh; background: var(--bg); }

  /* Mobile: stack vertically, sidebar hidden */
  .sidebar { display: none; }
  .app { max-width: 430px; margin: 0 auto; min-height: 100vh; background: var(--bg); position: relative; overflow: hidden; width: 100%; }

  /* Desktop ≥768px: sidebar + main */
  @media (min-width: 768px) {
    .app-root { flex-direction: row; }
    .sidebar {
      display: flex;
      flex-direction: column;
      width: 220px;
      min-height: 100vh;
      background: var(--surface);
      border-right: 1px solid var(--border);
      position: fixed;
      left: 0; top: 0; bottom: 0;
      z-index: 50;
      padding: 0;
    }
    .sidebar-logo {
      padding: 24px 20px 20px;
      border-bottom: 1px solid var(--border);
    }
    .sidebar-logo-text { font-family: var(--font-display); font-size: 22px; letter-spacing: 0.1em; color: var(--accent); }
    .sidebar-logo-sub { font-size: 10px; color: var(--text2); font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 2px; }
    .sidebar-nav { flex: 1; padding: 12px 0; }
    .sidebar-item {
      display: flex; align-items: center; gap: 12px;
      padding: 12px 20px;
      font-size: 13px; font-weight: 600; color: var(--text2);
      cursor: pointer; transition: all 0.15s;
      border-left: 3px solid transparent;
      letter-spacing: 0.04em;
    }
    .sidebar-item:hover { color: var(--text); background: rgba(255,255,255,0.04); }
    .sidebar-item.active { color: var(--accent); border-left-color: var(--accent); background: rgba(59,130,246,0.06); }
    .sidebar-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .nav-badge {
      margin-left: auto;
      background: rgba(192,132,252,0.18);
      color: var(--accent);
      font-size: 11px; font-weight: 700;
      padding: 2px 8px; border-radius: 10px;
      min-width: 22px; text-align: center;
      flex-shrink: 0;
    }
    .sidebar-item.active .nav-badge { background: rgba(255,255,255,0.18); color: inherit; }
    .sidebar-section-toggle {
      display: flex; align-items: center; gap: 6px;
      width: 100%; background: none; border: 0; cursor: pointer;
      font-family: inherit; text-align: left;
      font-size: 9px; font-weight: 700; letter-spacing: 0.12em;
      color: var(--text2); opacity: 0.7;
      padding: 12px 20px 4px; text-transform: uppercase;
    }
    .sidebar-section-toggle:hover { opacity: 1; color: var(--text); }
    .sidebar-section-toggle .nav-arrow { font-size: 10px; opacity: 0.8; }
    .sidebar-expand-btn { background: transparent; border: 0; color: inherit; cursor: pointer; padding: 2px 6px; font-size: 12px; flex-shrink: 0; }
    .sidebar-expand-btn:hover { color: var(--accent); }
    .sidebar-subitem { padding-left: 44px !important; font-size: 12px; }
    .app-root.nav-top .sidebar-subitem,
    .app-root.nav-top .sidebar-expand-btn { display: none; }
    .sidebar-footer { padding: 16px 20px; border-top: 1px solid var(--border); }
    .sidebar-user { font-size: 12px; color: var(--text2); font-weight: 600; margin-bottom: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .app {
      flex: 1;
      min-width: 0;
      max-width: none;
      margin: 0 0 0 220px;
      min-height: 100vh;
      overflow: hidden;
    }
    .bottom-nav { display: none !important; }
    .content { padding-bottom: 24px !important; max-width: none; width: 100%; padding-left: 40px !important; padding-right: 40px !important; }
    /* Desktop: kompaktowy nagłówek — bez 56px górnego paddingu z mobile (status bar) */
    .header { padding: 14px 40px 12px !important; min-height: 0 !important; }
    .header h1 { font-size: 20px !important; }
    .header .icon-btn { width: 32px !important; height: 32px !important; }
    .header-back { padding: 2px !important; }

    /* ─── PASEK MENU U GÓRY (opcja w Ustawieniach → Ogólne) ─── */
    .app-root.nav-top { flex-direction: column; }
    .app-root.nav-top .sidebar {
      flex-direction: row; align-items: center;
      width: 100%; height: 56px; min-height: 56px;
      top: 0; left: 0; right: 0; bottom: auto;
      border-right: none; border-bottom: 1px solid var(--border);
      padding: 0 12px;
    }
    .app-root.nav-top .sidebar-logo {
      padding: 0 14px 0 4px; margin-right: 6px;
      border-bottom: none; border-right: 1px solid var(--border);
      align-self: stretch; display: flex; align-items: center; flex-shrink: 0;
    }
    .app-root.nav-top .sidebar-nav { flex: 1; min-width: 0; display: flex; align-items: center; padding: 0; }
    .app-root.nav-top .sidebar-nav .scrollable-tabs-wrap { flex: 1; min-width: 0; }
    .app-root.nav-top .sidebar-nav .scrollable-tabs { align-items: center; gap: 2px; }
    .app-root.nav-top .sidebar-section { display: none; }
    .app-root.nav-top .sidebar-item {
      border-left: none; border-bottom: 2px solid transparent;
      padding: 8px 12px; white-space: nowrap; flex-shrink: 0;
    }
    .app-root.nav-top .sidebar-item.active { border-bottom-color: var(--accent); background: transparent; }
    .app-root.nav-top .sidebar-footer {
      border-top: none; border-left: 1px solid var(--border);
      padding: 0 4px 0 12px; margin-left: auto;
      display: flex; align-items: center; gap: 8px; flex-shrink: 0; align-self: stretch;
    }
    .app-root.nav-top .sidebar-user { margin-bottom: 0; max-width: 150px; }
    .app-root.nav-top .sidebar-footer button { width: auto !important; margin-bottom: 0 !important; white-space: nowrap; }
    .app-root.nav-top .app { flex: 0 0 auto; margin: 56px 0 0 0; min-height: calc(100vh - 56px); }
    /* FIX: top=0, bo .app ma overflow:hidden → jest scroll-context dla sticky,
       a .app startuje już na viewport y=56 (margin-top:56). Wartość 56px daje
       podwójne przesunięcie: header wisi o 56px niżej i zostawia tabs nagie nad nim. */
    .app-root.nav-top .header { top: 0; padding: 10px 40px !important; min-height: 0 !important; }
    .app-root.nav-top .header h1 { font-size: 18px !important; }
    .app-root.nav-top .header .icon-btn { width: 30px !important; height: 30px !important; }
  }

  /* ─── MASTER-DETAIL SPLIT (≥1280px): lista lewo / detal prawo ─── */
  @media (min-width: 1280px) {
    .md-split { display: flex; align-items: stretch; }
    .md-master {
      width: 400px; flex-shrink: 0;
      border-right: 1px solid var(--border);
      height: 100vh; overflow-y: auto;
    }
    .md-detail { flex: 1; min-width: 0; height: 100vh; overflow-y: auto; }
    /* Wąski lewy panel: zawsze jedna kolumna + mniejszy padding (niezależnie od ustawienia aptColumns) */
    .md-master .apt-list-grid { grid-template-columns: 1fr !important; }
    .md-master .content,
    .md-master .header { padding-left: 20px !important; padding-right: 20px !important; }
    /* przy pasku u góry panele zaczynają się pod nim → odejmij jego wysokość */
    .app-root.nav-top .md-master,
    .app-root.nav-top .md-detail { height: calc(100vh - 56px); }
    /* w panelach split sticky nagłówki przyklejają się do góry panelu (panel już jest pod paskiem) */
    .app-root.nav-top .md-split .header { top: 0; }
  }
  /* Podświetlenie aktywnej (otwartej w prawym panelu) pozycji listy */
  .apt-row.active, .task-card.active, .owner-card.active { border-color: var(--accent); background: var(--surface2); }

  /* ─── LOGIN SCREEN ─── */
  .login-screen {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 32px 24px 48px;
    background: var(--bg);
    position: relative;
    overflow: hidden;
  }
  .login-screen::before {
    content: '';
    position: absolute;
    top: -100px;
    left: -100px;
    width: 400px;
    height: 400px;
    background: radial-gradient(circle, rgba(59,130,246,0.08) 0%, transparent 70%);
    pointer-events: none;
  }
  .login-screen::after {
    content: '';
    position: absolute;
    bottom: -80px;
    right: -80px;
    width: 300px;
    height: 300px;
    background: radial-gradient(circle, rgba(255,107,53,0.06) 0%, transparent 70%);
    pointer-events: none;
  }
  .login-logo {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 48px;
  }
  .login-logo-icon {
    width: 48px;
    height: 48px;
    background: var(--accent);
    border-radius: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .login-logo-text { font-family: var(--font-display); font-size: 28px; font-weight: 400; letter-spacing: 0.1em; line-height: 1; }
  .login-logo-sub { font-size: 11px; color: var(--text2); font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 2px; }
  .login-title { font-family: var(--font-display); font-size: 42px; font-weight: 400; letter-spacing: 0.08em; line-height: 1; margin-bottom: 8px; }
  .login-sub { font-size: 14px; color: var(--text2); margin-bottom: 36px; font-weight: 500; }
  .login-error {
    background: rgba(239,68,68,0.12);
    border: 1px solid rgba(239,68,68,0.3);
    border-radius: 10px;
    padding: 12px 14px;
    font-size: 13px;
    color: var(--red);
    margin-bottom: 16px;
    font-weight: 600;
  }
  .login-demo-hint {
    background: rgba(59,130,246,0.06);
    border: 1px solid rgba(59,130,246,0.15);
    border-radius: 12px;
    padding: 14px;
    margin-bottom: 24px;
  }
  .login-demo-title { font-size: 10px; color: var(--accent); font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 10px; }
  .login-demo-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 0;
    border-bottom: 1px solid rgba(255,255,255,0.04);
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .login-demo-row:last-child { border-bottom: none; }
  .login-demo-row:hover { opacity: 0.7; }
  .login-demo-badge {
    padding: 2px 8px;
    border-radius: 6px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .login-footer { font-size: 11px; color: var(--text2); text-align: center; margin-top: 24px; font-weight: 500; }

  /* ─── ROLE BADGE in header ─── */
  .role-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 20px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .role-badge.manager { background: rgba(59,130,246,0.12); color: var(--accent); }
  .role-badge.worker { background: rgba(167,139,250,0.12); color: #a78bfa; }

  /* ─── WORKER VIEW ─── */
  .worker-header {
    background: var(--surface);
    padding: 56px 20px 24px;
    border-bottom: 1px solid var(--border);
  }
  .worker-greeting { font-size: 13px; color: var(--text2); font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 4px; }
  .worker-name { font-family: var(--font-display); font-size: 36px; font-weight: 400; letter-spacing: 0.06em; line-height: 1; }
  .worker-task-count {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 12px;
    padding: 6px 14px;
    background: rgba(239,68,68,0.12);
    border: 1px solid rgba(239,68,68,0.2);
    border-radius: 20px;
    font-size: 12px;
    color: var(--red);
    font-weight: 700;
  }
  .worker-task-count.ok { background: rgba(34,197,94,0.1); border-color: rgba(34,197,94,0.2); color: var(--green); }

  /* ─── STATUS UPDATE PILL ─── */
  .status-update-row { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }
  .status-pill {
    flex: 1; padding: 8px 4px; border-radius: 10px; font-size: 10px; font-weight: 700;
    letter-spacing: 0.06em; text-transform: uppercase; cursor: pointer; border: 1px solid var(--border);
    background: var(--surface2); color: var(--text2); text-align: center; transition: all 0.2s;
  }
  .status-pill.active-nie { background: rgba(239,68,68,0.15); border-color: var(--red); color: var(--red); }
  .status-pill.active-trakcie { background: rgba(245,158,11,0.15); border-color: var(--yellow); color: var(--yellow); }
  .status-pill.active-done { background: rgba(34,197,94,0.15); border-color: var(--green); color: var(--green); }

  /* ─── NAV ─── */
  .bottom-nav {
    position: fixed; bottom: 0; left: 50%; transform: translateX(-50%);
    width: 100%; max-width: 430px;
    background: var(--surface);
    border-top: 1px solid var(--border);
    display: flex; padding: 8px 0 20px;
    z-index: 100;
  }
  .nav-item {
    flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px;
    padding: 8px 4px; cursor: pointer; transition: all 0.2s;
    background: none; border: none; color: var(--text2);
  }
  .nav-item.active { color: var(--accent); }
  .nav-item span { font-size: 9px; font-family: var(--font-display); font-weight: 400; letter-spacing: 0.12em; text-transform: uppercase; }

  /* ─── HEADER ─── */
  /* Domyślnie kompaktowy nagłówek (był 56px górnego paddingu pod mobile status-bar — usunięte). */
  .header {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px;
    background: var(--bg);
    position: sticky; top: 0; z-index: 50;
    border-bottom: 1px solid var(--border);
  }
  /* FIX: margin: 0 — globalny h1 { margin: 32px 0 } z index.css powiększał pasek o 64px. */
  .header h1 { font-family: var(--font-display); font-size: 18px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; flex: 1; line-height: 1; color: var(--text); margin: 0; }
  .header h2, .detail-hero h1, .detail-hero h2 { margin: 0; }
  .header-back { background: none; border: none; color: var(--text); cursor: pointer; padding: 2px; display: flex; align-items: center; }
  .header-actions { display: flex; gap: 6px; align-items: center; }
  .header .icon-btn { width: 30px; height: 30px; }
  .icon-btn { background: var(--surface2); border: 1px solid var(--border); color: var(--text); width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; cursor: pointer; }

  .content { padding: 16px 16px 100px; }

  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 12px; overflow: hidden; transition: all 0.2s; cursor: pointer; }
  .card:hover { border-color: var(--accent); transform: translateY(-1px); }
  .card-body { padding: 14px 16px; }
  .card-title { font-family: var(--font-display); font-size: 18px; font-weight: 400; letter-spacing: 0.06em; }
  .card-sub { font-size: 12px; color: var(--text2); margin-top: 4px; }

  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 20px; font-size: 10px; font-weight: 700; font-family: var(--font-body); text-transform: uppercase; letter-spacing: 0.08em; }
  .badge-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

  .apt-row { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; cursor: pointer; transition: all 0.15s; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 8px; }
  /* FIX 5.2b: lista apartamentów wypełnia szerokość ekranu (kolumny zamiast pustej przestrzeni) */
  .apt-list-grid { display: grid; grid-template-columns: 1fr; gap: 8px; }
  .apt-list-grid .apt-row { margin-bottom: 0; }
  @media (min-width: 768px) {
    .apt-list-grid { grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); }
  }
  .apt-row:hover { border-color: var(--accent); background: var(--surface2); }
  .apt-row-left { display: flex; align-items: center; gap: 10px; }
  .apt-row-name { font-family: var(--font-display); font-size: 18px; font-weight: 400; letter-spacing: 0.06em; }
  .apt-row-note { font-size: 11px; color: var(--accent2); margin-top: 2px; font-weight: 600; }
  /* Kafelki statusu/zadań/pożyczek w wierszu listy (styl iOS — kwadrat z zaokrąglonymi rogami) */
  .apt-ind {
    width: 30px; height: 30px; border-radius: 9px; flex-shrink: 0; padding: 0;
    border: 1px solid var(--border); background: var(--surface2);
    display: inline-flex; align-items: center; justify-content: center;
  }
  button.apt-ind { cursor: pointer; transition: all 0.15s; }
  button.apt-ind:hover { border-color: var(--accent); background: rgba(59,130,246,0.14); }
  button.apt-ind:active { transform: scale(0.92); }

  .detail-hero { background: var(--surface); padding: 24px 20px; border-bottom: 1px solid var(--border); }
  .detail-hero h2 { font-family: var(--font-display); font-size: 36px; font-weight: 600; letter-spacing: 0.04em; line-height: 1.05; color: var(--text); }
  .detail-section { padding: 20px; border-bottom: 1px solid var(--border); }
  .detail-section-title { font-family: var(--font-body); font-size: 10px; font-weight: 700; color: var(--accent); letter-spacing: 0.14em; text-transform: uppercase; margin-bottom: 16px; display: flex; align-items: center; gap: 6px; }
  .detail-row { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
  .detail-label { font-size: 10px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700; flex-shrink: 0; margin-right: 12px; font-family: var(--font-body); }
  .detail-value { font-size: 14px; font-weight: 500; text-align: right; font-family: var(--font-body); }

  .action-row { display: flex; gap: 10px; padding: 16px; border-bottom: 1px solid var(--border); }
  .action-btn { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; background: var(--surface2); border: 1px solid var(--border); border-radius: 12px; padding: 12px 8px; cursor: pointer; transition: all 0.2s; color: var(--text); font-size: 9px; font-family: var(--font-body); font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; }
  .action-btn:hover { border-color: var(--accent); color: var(--accent); }
  .action-btn.primary { background: var(--accent); border-color: var(--accent); color: #000; }

  .task-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 12px; overflow: hidden; cursor: pointer; transition: all 0.2s; }
  .task-card:hover { border-color: var(--accent); }
  .task-card-header { padding: 14px 16px; display: flex; justify-content: space-between; align-items: flex-start; }
  .task-apt { font-size: 10px; color: var(--accent); font-weight: 700; font-family: var(--font-body); letter-spacing: 0.1em; text-transform: uppercase; }
  .task-title { font-family: var(--font-display); font-size: 20px; font-weight: 400; margin-top: 4px; letter-spacing: 0.04em; line-height: 1.15; }
  .task-meta { padding: 0 16px 14px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .task-assignee { font-size: 12px; color: var(--text2); display: flex; align-items: center; gap: 4px; }
  .avatar { width: 22px; height: 22px; border-radius: 50%; background: var(--accent); color: #000; font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center; }

  /* ─── FLOATING MODAL (FIX 2.A) — pływające na środku ekranu z backdropem ─── */
  .fm-backdrop {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.6);
    backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
    z-index: 1000; padding: 24px;
    animation: fm-fade-in 0.15s ease-out;
  }
  .fm-content {
    background: var(--surface);
    border-radius: 16px;
    border: 1px solid var(--border);
    box-shadow: 0 24px 48px rgba(0,0,0,0.4);
    max-height: 90vh; overflow-y: auto;
    width: 100%; max-width: var(--fm-max-width, 600px);
    animation: fm-scale-in 0.2s ease-out;
  }
  .fm-header { position: sticky; top: 0; z-index: 2; background: var(--surface); padding: 20px 24px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .fm-title { font-family: var(--font-display); font-size: 22px; font-weight: 400; letter-spacing: 0.06em; color: var(--text); line-height: 1.1; }
  .fm-close { background: transparent; border: 0; color: var(--text2); cursor: pointer; padding: 4px; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all 0.15s; }
  .fm-close:hover { background: var(--surface2); color: var(--text); }
  .fm-body { padding: 24px; }

  @keyframes fm-fade-in { from { opacity: 0 } to { opacity: 1 } }
  @keyframes fm-scale-in { from { opacity: 0; transform: scale(0.95) translateY(8px) } to { opacity: 1; transform: scale(1) translateY(0) } }

  @media (max-width: 640px) {
    .fm-backdrop { padding: 0; backdrop-filter: none; }
    .fm-content { max-height: 100vh; height: 100vh; border-radius: 0; max-width: 100% !important; border: 0; }
    .fm-body { padding: 16px; }
    .fm-header { padding: 16px; }
  }
  .form-group { margin-bottom: 16px; }
  .form-label { font-size: 10px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700; margin-bottom: 6px; display: block; font-family: var(--font-body); }
  .form-input, .form-select, .form-textarea { width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; color: var(--text); font-size: 14px; font-family: var(--font-body); outline: none; transition: border 0.2s; font-weight: 500; }
  .form-input:focus, .form-select:focus, .form-textarea:focus { border-color: var(--accent); }
  .form-textarea { min-height: 80px; resize: vertical; }
  .form-select option { background: var(--surface2); }

  .btn { padding: 14px 20px; border-radius: 12px; font-family: var(--font-display); font-size: 17px; font-weight: 400; letter-spacing: 0.12em; text-transform: uppercase; cursor: pointer; border: none; transition: all 0.2s; width: 100%; }
  .btn-primary { background: var(--accent); color: #000; }
  .btn-primary:hover { background: #00b8d9; }
  .btn-danger { background: var(--red); color: #fff; }
  .btn-ghost { background: var(--surface2); color: var(--text); border: 1px solid var(--border); }
  .btn-row { display: flex; gap: 10px; margin-top: 20px; }
  .btn-row .btn { flex: 1; }

  .search-bar { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 10px 14px; display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
  .search-bar input { background: none; border: none; color: var(--text); font-size: 14px; flex: 1; outline: none; font-family: var(--font-body); font-weight: 500; }

  .owner-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 12px; cursor: pointer; transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s; overflow: hidden; }
  .owner-card:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.18); }
  .owner-header { padding: 16px; display: flex; align-items: flex-start; gap: 14px; }
  .owner-avatar { width: 46px; height: 46px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; font-family: var(--font-display); font-size: 18px; font-weight: 400; color: #000; flex-shrink: 0; letter-spacing: 0.05em; }
  .owner-name { font-family: var(--font-display); font-size: 19px; font-weight: 600; letter-spacing: 0.03em; color: var(--text); line-height: 1.2; }
  .owner-sub { font-size: 13px; color: var(--text2); margin-top: 3px; font-weight: 500; }

  /* Kafelek z liczbą pozycji właściciela (klikalny → rozwija listę) */
  .owner-count-tile { width: 52px; height: 52px; border-radius: 12px; flex-shrink: 0; padding: 0; border: 1px solid var(--border); background: var(--surface2); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; cursor: pointer; transition: all 0.15s; }
  .owner-count-tile:hover { border-color: var(--accent); background: rgba(59,130,246,0.14); }
  .owner-count-tile:active { transform: scale(0.95); }
  .owner-count-num { font-family: var(--font-display); font-size: 22px; font-weight: 600; color: var(--accent); line-height: 1; }
  .owner-count-label { font-size: 8px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text2); }
  /* Rozwinięta lista pozycji właściciela */
  .owner-apts-list { padding: 10px 16px 14px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; }
  .owner-apts-head { font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text2); margin-bottom: 2px; }
  .owner-apt-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border-radius: 8px; background: var(--surface2); cursor: pointer; transition: background 0.15s; }
  .owner-apt-item:hover { background: rgba(59,130,246,0.12); }
  .owner-apt-name { font-size: 13px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .kw-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 12px; }
  .kw-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .kw-logo { width: 32px; height: 32px; background: var(--accent); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-family: var(--font-display); font-size: 13px; font-weight: 400; color: #000; letter-spacing: 0.05em; }
  .kw-title { font-family: var(--font-display); font-size: 18px; font-weight: 400; letter-spacing: 0.08em; }
  .kw-sub { font-size: 11px; color: var(--text2); font-weight: 500; }

  .filter-row { display: flex; gap: 8px; margin-bottom: 16px; overflow-x: auto; padding-bottom: 4px; }
  .filter-chip { padding: 6px 14px; border-radius: 20px; font-size: 10px; font-family: var(--font-body); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; cursor: pointer; border: 1px solid var(--border); background: var(--surface); color: var(--text2); white-space: nowrap; transition: all 0.2s; }
  .filter-chip.active { background: var(--accent); border-color: var(--accent); color: #000; }

  .empty { text-align: center; padding: 40px 20px; color: var(--text2); }
  .empty-icon { margin-bottom: 12px; opacity: 0.3; }
  .empty h3 { font-family: var(--font-display); font-size: 22px; font-weight: 400; letter-spacing: 0.08em; margin-bottom: 6px; color: var(--text); }

  .fab { position: fixed; bottom: 90px; right: 20px; width: 52px; height: 52px; border-radius: 50%; background: var(--accent); border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 20px rgba(59,130,246,0.4); z-index: 99; transition: all 0.2s; }
  .fab:hover { transform: scale(1.1); box-shadow: 0 6px 28px rgba(59,130,246,0.6); }

  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
  .fade-in { animation: fadeIn 0.3s ease; }
  .slide-up { animation: slideUp 0.3s ease; }

  .tabs { display: flex; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
  .tab { flex: 1; padding: 12px; text-align: center; font-family: var(--font-display); font-size: 16px; font-weight: 400; letter-spacing: 0.1em; text-transform: uppercase; cursor: pointer; color: var(--text2); border-bottom: 2px solid transparent; transition: all 0.15s ease; }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--accent); border-bottom: 2px solid var(--accent); font-weight: 600; background: rgba(59,130,246,0.1); }

  /* ─── SCROLLABLE TABS (FIX 5.3) ─── */
  .scrollable-tabs-wrap { position: relative; display: flex; align-items: center; }
  .scrollable-tabs {
    display: flex; flex-wrap: nowrap; overflow-x: auto; scroll-behavior: smooth;
    scrollbar-width: none; /* Firefox */ width: 100%;
  }
  .scrollable-tabs::-webkit-scrollbar { display: none; } /* Chrome/Safari */
  .stabs-arrow {
    position: absolute; z-index: 5; top: 50%; transform: translateY(-50%);
    width: 32px; height: 32px; border-radius: 50%;
    background: var(--surface2); border: 1px solid var(--border);
    color: var(--text); cursor: pointer; display: flex; align-items: center; justify-content: center;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  }
  .stabs-arrow:hover { background: var(--accent); }
  .stabs-arrow-left { left: 0; }
  .stabs-arrow-right { right: 0; }

  .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .section-title { font-family: var(--font-body); font-size: 10px; font-weight: 700; color: var(--text2); letter-spacing: 0.12em; text-transform: uppercase; }

  .sync-banner { background: var(--surface2); border: 1px solid var(--border); border-radius: 12px; padding: 12px 16px; display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .sync-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); flex-shrink: 0; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

  .spinner { width: 20px; height: 20px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ─── FORM VALIDATION ─── */
  .field-error {
    font-size: 11px;
    color: var(--red);
    font-weight: 600;
    margin-top: 4px;
    display: flex;
    align-items: center;
    gap: 4px;
    animation: fadeIn 0.15s ease;
  }
  .field-error::before { content: "⚠ "; font-size: 10px; }
  .input-error {
    border-color: var(--red) !important;
    background: rgba(239,68,68,0.06) !important;
  }
  .input-error:focus { border-color: var(--red) !important; box-shadow: 0 0 0 3px rgba(239,68,68,0.12); }

  /* Loading screen */
  .loading-screen { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; }
  .loading-screen .spinner { width: 40px; height: 40px; }

  /* ─── CLEANING VIEW ─── */
  .cleaning-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 10px;
    overflow: hidden;
    transition: border-color 0.2s;
  }
  .cleaning-card.status-in_progress { border-color: var(--accent); }
  .cleaning-card.status-done { border-color: var(--green); opacity: 0.75; }
  .cleaning-card-header {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 16px;
    cursor: pointer;
  }
  .cleaning-status-dot {
    width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
  }
  .cleaning-card-body { padding: 0 16px 14px; border-top: 1px solid var(--border); }
  .cleaning-timer {
    font-family: var(--font-display); font-size: 42px;
    letter-spacing: 0.08em; color: var(--accent);
    text-align: center; padding: 12px 0 4px;
  }
  .cleaning-actions { display: flex; gap: 8px; margin-top: 10px; }
  .cleaning-btn {
    flex: 1; padding: 12px; border-radius: 10px; border: none;
    font-size: 12px; font-weight: 700; letter-spacing: 0.08em;
    text-transform: uppercase; cursor: pointer; transition: all 0.2s;
  }
  .cleaning-btn.start { background: var(--accent); color: #000; }
  .cleaning-btn.stop  { background: var(--yellow); color: #000; }
  .cleaning-btn.done  { background: var(--green);  color: #000; }
  .cleaning-btn.del   { background: rgba(239,68,68,0.15); color: var(--red); flex: 0 0 auto; padding: 12px 14px; }

  /* ─── APT DETAIL NEW TABS ─── */
  .inventory-row {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 0; border-bottom: 1px solid var(--border);
  }
  .inventory-qty {
    display: flex; align-items: center; gap: 8px;
    margin-left: auto; flex-shrink: 0;
  }
  .qty-btn {
    width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--border);
    background: var(--surface2); color: var(--text); font-size: 18px; font-weight: 700;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: all 0.15s; padding: 0; line-height: 1;
  }
  .qty-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: rgba(59,130,246,0.12); }
  .qty-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .qty-val { min-width: 28px; text-align: center; font-weight: 700; font-size: 15px; }

  .sms-template-box {
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: 12px; padding: 14px; font-size: 13px;
    line-height: 1.7; white-space: pre-wrap; color: var(--text);
    font-family: var(--font-body);
  }
  .sms-var { color: var(--accent); font-weight: 700; }

  /* FIX 1.1 — nagłówek sekcji ustawień (tytuł + przycisk, responsywny) */
  .settings-cat-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
  @media (max-width: 640px) {
    .settings-cat-head { flex-direction: column; align-items: flex-start; gap: 12px; }
  }

  /* FIX 1.3/1.4 — NumberInput: ukryte natywne strzałki + nowoczesne steppery +/- */
  .num-input::-webkit-outer-spin-button,
  .num-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .num-input { -moz-appearance: textfield; appearance: textfield; }
  .num-input-wrap { display: flex; align-items: center; gap: 8px; }
  .num-input-wrap .num-input { flex: 1; min-width: 0; width: auto; text-align: center; }
  .num-stepper {
    width: 32px; height: 32px; flex-shrink: 0; padding: 0;
    border-radius: 8px; border: 1px solid var(--border);
    background: var(--surface2); color: var(--text);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; transition: all 0.15s;
  }
  .num-stepper:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: rgba(59,130,246,0.12); }
  .num-stepper:disabled { opacity: 0.4; cursor: not-allowed; }

  /* FIX 1.6 — ściąga zmiennych w edytorze SMS */
  .sms-vars-panel { margin: 10px 0; border: 1px solid var(--border); border-radius: 10px; background: var(--surface2); overflow: hidden; }
  .sms-vars-panel > summary { cursor: pointer; padding: 10px 12px; font-size: 12px; font-weight: 700; color: var(--accent); letter-spacing: 0.04em; list-style: none; user-select: none; }
  .sms-vars-panel > summary::-webkit-details-marker { display: none; }
  .sms-vars-panel > summary::before { content: "▸ "; }
  .sms-vars-panel[open] > summary::before { content: "▾ "; }
  .sms-vars-list { padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 6px; max-height: 240px; overflow-y: auto; }
  .sms-var-chip { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; cursor: pointer; transition: all 0.15s; text-align: left; }
  .sms-var-chip:hover { border-color: var(--accent); background: rgba(59,130,246,0.10); }
  .sms-var-chip code { font-family: monospace; font-size: 12px; font-weight: 700; color: var(--accent); }
  .sms-var-chip .sms-var-desc { font-size: 11px; color: var(--text); }
  .sms-var-chip .sms-var-ex { font-size: 11px; color: var(--text2); }

  .history-row {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 0; border-bottom: 1px solid var(--border);
  }
  .history-date { font-weight: 700; font-size: 13px; min-width: 90px; }
  .history-person { font-size: 12px; color: var(--text2); }
  .history-duration { margin-left: auto; font-family: var(--font-display); font-size: 18px; color: var(--accent); letter-spacing: 0.06em; flex-shrink: 0; }
  .history-status-badge { padding: 2px 8px; border-radius: 6px; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; }
`;

// ─── COMPONENTS ──────────────────────────────────────────────────────────────

const StatusBadge = ({ status }) => {
  const color = STATUS_COLORS[status] || "#888";
  return (
    <span className="badge" style={{ color, background: color + "18" }}>
      <span className="badge-dot" />
      {status}
    </span>
  );
};

const TaskStatusBadge = ({ status }) => {
  const color = TASK_STATUS_COLORS[status] || "#888";
  return (
    <span className="badge" style={{ color, background: color + "18" }}>
      {status}
    </span>
  );
};

// FIX 9.3 — kafelek priorytetu (zastępuje brzydką kropkę/emoji w kartach zadań)
const PRIORITY_CONFIG = {
  high:   { label: "Wysoki",   color: "var(--red)",    bg: "rgba(239,68,68,0.12)", glyph: "!" },
  normal: { label: "Normalny", color: "var(--yellow)", bg: "rgba(245,158,11,0.12)", glyph: "–" },
  low:    { label: "Niski",    color: "var(--green)",  bg: "rgba(16,185,129,0.12)", glyph: "↓" },
};
const PriorityTile = ({ priority = "normal" }) => {
  const c = PRIORITY_CONFIG[priority] || PRIORITY_CONFIG.normal;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "3px 9px", borderRadius: 8,
      background: c.bg, color: c.color,
      fontSize: 11, fontWeight: 700, letterSpacing: "0.04em",
      borderLeft: `3px solid ${c.color}`, lineHeight: 1.2,
    }}>
      <span style={{ fontSize: 12, fontWeight: 800, lineHeight: 1 }}>{c.glyph}</span>
      {c.label}
    </span>
  );
};

// ─── LOGIN SCREEN ─────────────────────────────────────────────────────────────

const LoginScreen = ({ onLogin }) => {
  const { form, set, touch, submit, hasError } = useValidatedForm(
    { email: "", password: "" }, "login"
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPass, setShowPass] = useState(false);
  const emailRef = useRef(null);

  useEffect(() => { emailRef.current && emailRef.current.focus(); }, []);

  const handleLogin = async () => {
    setError("");
    submit(async (clean) => {
      setLoading(true);
      try {
        let user;
        if (CONFIG.isDemo) {
          await new Promise(r => setTimeout(r, 500)); // symulacja latency
          user = AuthManager.signInDemo(clean.email, form.password);
        } else {
          user = await AuthManager.signIn(clean.email, form.password);
        }
        onLogin(user);
      } catch (err) {
        setError(err instanceof AppError ? err.message : "Błąd logowania");
      } finally {
        setLoading(false);
      }
    });
  };

  const quickLogin = (u) => { set("email", u.email); set("password", u.password); };

  return (
    <div className="login-screen fade-in">
      <div className="login-logo">
        <VelarLogo size={48} withWordmark taglineText="Property Management Suite" />
      </div>

      <div className="login-title">ZALOGUJ SIĘ</div>
      <div className="login-sub">Zarządzanie apartamentami</div>

      {error && (
        <div className="login-error" role="alert">
          <Icon name="shield" size={14} /> {error}
        </div>
      )}

      {CONFIG.isDemo && (
        <div className="login-demo-hint">
          <div className="login-demo-title">Tryb demo — kliknij aby zalogować</div>
          {(() => {
            // Pokazuj: wszystkich managerów, zespół sprzątający, konserwatora, 2 workerów
            const managers    = DEMO_USERS.filter(u => u.role === "manager");
            const cleaning    = DEMO_USERS.filter(u => u.role === "cleaning_team");
            const maintenance = DEMO_USERS.filter(u => u.role === "maintenance");
            const workers     = DEMO_USERS.filter(u => u.role === "worker").slice(0, 2);
            const list = [...managers, ...cleaning, ...maintenance, ...workers];
            const roleColor = { manager: "var(--accent)", cleaning_team: "var(--green)", maintenance: "#f59e0b", worker: "#a78bfa" };
            const roleLabel = { manager: "manager", cleaning_team: "sprzątanie", maintenance: "konserwator", worker: "worker" };
            return list.map(u => (
              <div key={u.email} className="login-demo-row" onClick={() => quickLogin(u)}>
                <div className="avatar" style={{ background: roleColor[u.role], color: "#000" }}>{u.name[0]}</div>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{u.name}</span>
                <span className="login-demo-badge" style={{ background: `${roleColor[u.role]}26`, color: roleColor[u.role] }}>{roleLabel[u.role]}</span>
              </div>
            ));
          })()}
        </div>
      )}

      <div className="form-group">
        <label className="form-label">E-mail</label>
        <input
          ref={emailRef}
          className={`form-input ${hasError("email") ? "input-error" : ""}`}
          type="email"
          value={form.email}
          onChange={e => set("email", e.target.value)}
          onBlur={() => touch("email")}
          placeholder="twoj@email.pl"
          autoComplete="email"
          onKeyDown={e => e.key === "Enter" && handleLogin()}
        />
        {hasError("email") && <div className="field-error">{hasError("email")}</div>}
      </div>

      <div className="form-group">
        <label className="form-label">Hasło</label>
        <div style={{ position: "relative" }}>
          <input
            className={`form-input ${hasError("password") ? "input-error" : ""}`}
            type={showPass ? "text" : "password"}
            value={form.password}
            onChange={e => set("password", e.target.value)}
            onBlur={() => touch("password")}
            placeholder="••••••••"
            autoComplete="current-password"
            style={{ paddingRight: 44 }}
            onKeyDown={e => e.key === "Enter" && handleLogin()}
          />
          <button
            onClick={() => setShowPass(p => !p)}
            style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--text2)", cursor: "pointer", fontSize: 12, fontWeight: 700 }}
          >{showPass ? "UKRYJ" : "POKAŻ"}</button>
        </div>
        {hasError("password") && <div className="field-error">{hasError("password")}</div>}
      </div>

      <button
        className="btn btn-primary"
        onClick={handleLogin}
        disabled={loading}
        style={{ marginTop: 8, opacity: loading ? 0.7 : 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
      >
        {loading ? <><div className="spinner" style={{ width: 16, height: 16 }} /> Logowanie...</> : <><Icon name="lock" size={16} color="#000" />ZALOGUJ SIĘ</>}
      </button>

      <div className="login-footer">
        {CONFIG.isDemo
          ? "Tryb DEMO · Dane przykładowe · Skonfiguruj Supabase do produkcji"
          : "VelarFlow · Połączenie szyfrowane"}
      </div>
    </div>
  );
};


// ─── WORKER VIEW ─────────────────────────────────────────────────────────────
// Uproszczony widok dla pracowników — tylko ich zadania, możliwość zmiany statusu

const WorkerView = ({ currentUser, tasks, apartments, onUpdateTask, onLogout }) => {
  const myTasks = tasks.filter(t =>
    t.assignedTo === currentUser.name && t.status !== "Zrobione" && t.status !== "Zakończono"
  );
  const doneTasks = tasks.filter(t =>
    t.assignedTo === currentUser.name && (t.status === "Zrobione" || t.status === "Zakończono")
  );
  const [selectedTask, setSelectedTask] = useState(null);
  const [showDone, setShowDone] = useState(false);

  if (selectedTask) {
    const apt = apartments.find(a => a.id === selectedTask.apartmentId);
    return (
      <div className="app">
        <style>{styles}</style>
        <div className="header">
          <button className="header-back" onClick={() => setSelectedTask(null)}><Icon name="back" /></button>
          <h1>Szczegóły</h1>
        </div>
        <div className="detail-hero">
          {apt && <div style={{ fontSize: 11, color: "var(--accent)", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 8 }}>{apt.name}</div>}
          <div style={{ marginBottom: 8 }}><TaskStatusBadge status={selectedTask.status} /></div>
          <h2>{selectedTask.title}</h2>
        </div>
        <div className="detail-section">
          {apt && (
            <>
              {apt.wifi && <div className="detail-row"><span className="detail-label">WiFi</span><span className="detail-value" style={{ whiteSpace: "pre-line" }}>{apt.wifi}</span></div>}
              {apt.domofon && <div className="detail-row"><span className="detail-label">Wejście</span><span className="detail-value" style={{ whiteSpace: "pre-line" }}>{apt.domofon}</span></div>}
              {apt.safeCode && <div className="detail-row"><span className="detail-label">Sejf/Klucz</span><span className="detail-value" style={{ color: "var(--accent)", fontWeight: 700 }}>{apt.safeCode}</span></div>}
              {apt.parking && <div className="detail-row"><span className="detail-label">Parking</span><span className="detail-value">{apt.parking} nr {apt.parkingNumber}</span></div>}
            </>
          )}
          {selectedTask.notes && <div className="detail-row"><span className="detail-label">Notatki</span><span className="detail-value">{selectedTask.notes}</span></div>}
          {selectedTask.nextCheckout && <div className="detail-row"><span className="detail-label">Wyjazd gości</span><span className="detail-value" style={{ color: "var(--green)" }}>➜ {selectedTask.nextCheckout.slice(0, 16).replace("T", " ")}</span></div>}
          {selectedTask.nextCheckin && <div className="detail-row"><span className="detail-label">Przyjazd gości</span><span className="detail-value" style={{ color: "var(--accent2)" }}>➜ {selectedTask.nextCheckin.slice(0, 16).replace("T", " ")}</span></div>}
        </div>
        <div className="status-update-row">
          {["Nie rozpoczęto", "W trakcie", "Zrobione"].map(s => {
            const cls = s === "Nie rozpoczęto" ? "active-nie" : s === "W trakcie" ? "active-trakcie" : "active-done";
            return (
              <div
                key={s}
                className={`status-pill ${selectedTask.status === s ? cls : ""}`}
                onClick={() => { onUpdateTask(selectedTask.id, s); setSelectedTask(t => ({ ...t, status: s })); }}
              >{s}</div>
            );
          })}
        </div>
        {selectedTask.status === "Zrobione" && (
          <div style={{ padding: 16 }}>
            <button className="btn btn-ghost" onClick={() => setSelectedTask(null)}>← Wróć do listy</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <style>{styles}</style>
      <div className="worker-header">
        <div className="worker-greeting">Dzień dobry,</div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div className="worker-name">{currentUser.name.toUpperCase()}</div>
          <button className="icon-btn" onClick={onLogout} title="Wyloguj"><Icon name="logout" size={16} /></button>
        </div>
        <div style={{ marginTop: 12 }}>
          {myTasks.length === 0
            ? <span className="worker-task-count ok"><Icon name="check" size={12} color="var(--green)" />Brak aktywnych zadań</span>
            : <span className="worker-task-count"><Icon name="tasks" size={12} />{myTasks.length} {myTasks.length === 1 ? "zadanie" : myTasks.length < 5 ? "zadania" : "zadań"} do wykonania</span>
          }
        </div>
      </div>

      <div className="content">
        {myTasks.length === 0 ? (
          <div className="empty">
            <div className="empty-icon"><Icon name="check" size={40} color="var(--green)" /></div>
            <h3>Wszystko gotowe!</h3>
            <p style={{ fontSize: 13 }}>Nie masz żadnych przypisanych zadań</p>
          </div>
        ) : myTasks.map(task => {
          const apt = apartments.find(a => a.id === task.apartmentId);
          return (
            <div key={task.id} className="task-card" onClick={() => setSelectedTask(task)}>
              <div className="task-card-header">
                <div style={{ flex: 1 }}>
                  {apt && <div className="task-apt">{apt.name}</div>}
                  <div className="task-title">{task.priority==="high" && <span style={{color:"var(--red)",marginRight:6}}>🔴</span>}{task.priority==="low" && <span style={{color:"var(--green)",marginRight:6}}>🟢</span>}{task.title}</div>
                </div>
                <TaskStatusBadge status={task.status} />
              </div>
              <div className="task-meta">
                <span style={{ fontSize: 11, color: "var(--text2)" }}>{task.createdAt}</span>
                {task.nextCheckout && (
                  <span style={{ fontSize: 11, color: "var(--green)", display: "flex", alignItems: "center", gap: 4 }}>
                    <Icon name="calendar" size={11} color="var(--green)" />
                    {task.nextCheckout.slice(0, 10)}
                  </span>
                )}
              </div>
              <div className="status-update-row" onClick={e => e.stopPropagation()}>
                {["Nie rozpoczęto", "W trakcie", "Zrobione"].map(s => {
                  const cls = s === "Nie rozpoczęto" ? "active-nie" : s === "W trakcie" ? "active-trakcie" : "active-done";
                  return (
                    <div key={s} className={`status-pill ${task.status === s ? cls : ""}`}
                      onClick={() => onUpdateTask(task.id, s)}>{s}</div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {doneTasks.length > 0 && (
          <div>
            <div className="section-header" style={{ marginTop: 8 }}>
              <span className="section-title">Ukończone ({doneTasks.length})</span>
              <button style={{ background: "none", border: "none", color: "var(--text2)", fontSize: 12, cursor: "pointer" }}
                onClick={() => setShowDone(!showDone)}>{showDone ? "Ukryj" : "Pokaż"}</button>
            </div>
            {showDone && doneTasks.map(task => {
              const apt = apartments.find(a => a.id === task.apartmentId);
              return (
                <div key={task.id} className="task-card" style={{ opacity: 0.5 }}>
                  <div className="task-card-header">
                    <div style={{ flex: 1 }}>
                      {apt && <div className="task-apt">{apt.name}</div>}
                      <div className="task-title" style={{ textDecoration: "line-through" }}>{task.title}</div>
                    </div>
                    <TaskStatusBadge status={task.status} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

// ─── MODALS ───────────────────────────────────────────────────────────────────

const FieldError = ({ msg }) => msg ? (
  <div className="field-error" role="alert">{msg}</div>
) : null;

// ─── FLOATING MODAL (FIX 2.A) ──────────────────────────────────────────────────
// Uniwersalny modal pływający na środku ekranu. Esc + klik w backdrop zamykają,
// focus trafia na pierwsze pole. Na mobile (< 640px) renderuje się full-screen.
const FM_SIZES = { sm: 400, md: 600, lg: 800, xl: 1000 };

const FloatingModal = ({ open, onClose, title, children, size = "md" }) => {
  const contentRef = useRef(null);

  // Esc zamyka modal
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose && onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Focus na pierwsze pole formularza — tylko przy otwarciu (bez kradzieży focusu przy re-renderze)
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const el = contentRef.current;
      if (!el) return;
      const first = el.querySelector("input, select, textarea");
      if (first) first.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  if (!open) return null;
  return (
    <div className="fm-backdrop" onClick={onClose}>
      <div className="fm-content" ref={contentRef} onClick={e => e.stopPropagation()}
        style={{ "--fm-max-width": `${FM_SIZES[size] || FM_SIZES.md}px` }}>
        <div className="fm-header">
          <div className="fm-title">{title}</div>
          <button className="fm-close" onClick={onClose} aria-label="Zamknij"><Icon name="x" size={18} /></button>
        </div>
        <div className="fm-body">{children}</div>
      </div>
    </div>
  );
};

// Dialog potwierdzenia zbudowany na FloatingModal. variant "danger" = czerwony przycisk.
const ConfirmModal = ({ open, onClose, onConfirm, title, message, variant = "default", confirmLabel = "Potwierdź", cancelLabel = "Anuluj" }) => (
  <FloatingModal open={open} onClose={onClose} title={title} size="sm">
    <p style={{ fontSize:14, color:"var(--text2)", lineHeight:1.6, marginBottom:20 }}>{message}</p>
    <div className="btn-row" style={{ marginTop:0 }}>
      <button className="btn btn-ghost" onClick={onClose}>{cancelLabel}</button>
      <button className={`btn ${variant === "danger" ? "btn-danger" : "btn-primary"}`} onClick={onConfirm}>{confirmLabel}</button>
    </div>
  </FloatingModal>
);

// Typy pól dostępne w konfiguratorze formularza
const FIELD_TYPE_OPTIONS = [
  { value: "text",     label: "Tekst" },
  { value: "number",   label: "Liczba" },
  { value: "textarea", label: "Długi tekst" },
  { value: "select",   label: "Lista wyboru" },
  { value: "checkbox", label: "Pole tak/nie" },
  { value: "date",     label: "Data" },
  { value: "datetime", label: "Data i godzina" },
  { value: "url",      label: "Link URL" },
  { value: "email",    label: "E-mail" },
  { value: "phone",    label: "Telefon" },
];

// Podgląd formularza — render pól ze schemy w trybie tylko-do-odczytu (zgrupowane)
const FormPreview = ({ fields }) => {
  if (!fields.length) return <div style={{ fontSize:13, color:"var(--text2)", padding:12 }}>Brak widocznych pól — wszystko ukryte.</div>;
  const groups = {};
  fields.forEach(f => { if (!groups[f.group]) groups[f.group] = []; groups[f.group].push(f); });
  const lbl = (f) => <label className="form-label">{f.label}{f.required && <span style={{color:"var(--red)",marginLeft:3}}>*</span>}</label>;
  const renderOne = (f) => {
    if (f.type === "textarea")
      return <div className="form-group" key={f.id}>{lbl(f)}<textarea className="form-textarea" disabled placeholder={f.placeholder||""} defaultValue={f.defaultValue||""} style={{minHeight:50}} /></div>;
    if (f.type === "checkbox")
      return <div className="form-group" key={f.id}><label style={{display:"flex",alignItems:"center",gap:10}}><input type="checkbox" disabled defaultChecked={!!f.defaultValue} style={{width:18,height:18}} /><span style={{fontSize:13,fontWeight:600}}>{f.label}{f.required && <span style={{color:"var(--red)",marginLeft:3}}>*</span>}</span></label></div>;
    if (f.type === "select")
      return <div className="form-group" key={f.id}>{lbl(f)}<select className="form-select" disabled><option>{(f.options && f.options[0]) || "— wybierz —"}</option></select></div>;
    const htmlType = f.type === "datetime" ? "datetime-local" : f.type === "phone" ? "tel" : ["number","date","email","url"].includes(f.type) ? f.type : "text";
    return <div className="form-group" key={f.id}>{lbl(f)}<input className="form-input" disabled type={htmlType} placeholder={f.placeholder||(f.type==="url"?"https://...":"")} defaultValue={f.defaultValue||""} /></div>;
  };
  return (
    <div>
      {Object.entries(groups).map(([g, fs]) => (
        <div key={g} style={{ marginBottom:8 }}>
          <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:6, marginTop:8 }}>{g}</div>
          {fs.map(renderOne)}
        </div>
      ))}
    </div>
  );
};

// Modal edycji / tworzenia pojedynczego pola formularza
const FieldDetailModal = ({ field, groupNames, onSave, onClose }) => {
  const isCreate = !field;
  const isBuiltin = !!field && !field.custom;
  const [label, setLabel] = useState(field ? field.label : "");
  const [type, setType] = useState(field ? field.type : "text");
  const [group, setGroup] = useState(field ? field.group : (groupNames[0] || "Inne"));
  const [required, setRequired] = useState(field ? !!field.required : false);
  const [hidden, setHidden] = useState(field ? !field.visible : false);
  const [placeholder, setPlaceholder] = useState(field ? (field.placeholder || "") : "");
  const [defaultValue, setDefaultValue] = useState(field ? (field.defaultValue ?? "") : "");
  const [options, setOptions] = useState(field && Array.isArray(field.options) ? [...field.options] : []);
  const [newOption, setNewOption] = useState("");
  // PAKIET 8b — opcja inline „Nowa grupa…"
  const [newGroupInline, setNewGroupInline] = useState("");
  const [showNewGroupInput, setShowNewGroupInput] = useState(false);

  const title = isCreate ? "Nowe pole" : `Edytuj pole: ${field.label}${isBuiltin ? " (wbudowane)" : " (własne)"}`;
  const canSave = !!label.trim() && (type !== "select" || options.length > 0);
  const showValueFields = type !== "checkbox" && type !== "select";

  const addOption = () => { const v = newOption.trim(); if (v && !options.includes(v)) { setOptions([...options, v]); setNewOption(""); } };

  const handleSave = () => {
    if (!canSave) return;
    if (isCreate) {
      onSave({ mode:"create", payload:{ label, type, group, required, placeholder, defaultValue, options: type === "select" ? options : undefined } });
    } else {
      const changes = { label: label.trim(), group, required, visible: !hidden, placeholder, defaultValue };
      if (!isBuiltin) { changes.type = type; if (type === "select") changes.options = options; }
      onSave({ mode:"update", id: field.id, changes });
    }
  };

  return (
    <FloatingModal open onClose={onClose} title={title} size="sm">
      <div className="form-group">
        <label className="form-label">Etykieta <span style={{color:"var(--red)"}}>*</span></label>
        <input className="form-input" value={label} onChange={e => setLabel(e.target.value)} placeholder="np. Tytuł apartamentu" />
      </div>

      <div className="form-group">
        <label className="form-label">Typ pola{isBuiltin && <span style={{fontSize:11,color:"var(--text2)",marginLeft:6,fontWeight:400}}>(wbudowane — typ niezmienny)</span>}</label>
        <select className="form-select" value={type} onChange={e => setType(e.target.value)} disabled={isBuiltin}>
          {FIELD_TYPE_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      </div>

      <div className="form-group">
        <label className="form-label">Grupa</label>
        <select className="form-select" value={showNewGroupInput ? "__new__" : group} onChange={e => {
          if (e.target.value === "__new__") { setShowNewGroupInput(true); }
          else { setShowNewGroupInput(false); setGroup(e.target.value); }
        }}>
          {[...new Set([...groupNames, group, "Inne"])].filter(Boolean).map(g => <option key={g} value={g}>{g}</option>)}
          <option value="__new__">+ Nowa grupa…</option>
        </select>
        {showNewGroupInput && (
          <input
            className="form-input"
            style={{ marginTop:6 }}
            autoFocus
            placeholder="Nazwa nowej grupy"
            value={newGroupInline}
            onChange={e => { setNewGroupInline(e.target.value); setGroup(e.target.value.trim() || group); }}
          />
        )}
      </div>

      {type === "select" && (
        <div className="form-group">
          <label className="form-label">Opcje listy {options.length === 0 && <span style={{color:"var(--red)",marginLeft:4,fontSize:11,fontWeight:400}}>dodaj min. 1</span>}</label>
          <div style={{ display:"flex", gap:6, marginBottom:8 }}>
            <input className="form-input" value={newOption} onChange={e => setNewOption(e.target.value)} placeholder="Nowa opcja"
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addOption(); } }} />
            <button className="btn btn-primary" style={{ padding:"0 14px" }} onClick={addOption} disabled={!newOption.trim()}>+</button>
          </div>
          <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
            {options.map(o => (
              <span key={o} style={{ display:"inline-flex", alignItems:"center", gap:6, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"4px 8px", fontSize:12 }}>
                {o}
                <button onClick={() => setOptions(options.filter(x => x !== o))} style={{ background:"none", border:"none", cursor:"pointer", color:"var(--red)", fontWeight:700, fontSize:14, padding:0, lineHeight:1 }}>×</button>
              </span>
            ))}
          </div>
        </div>
      )}

      {showValueFields && (
        <>
          <div className="form-group">
            <label className="form-label">Placeholder</label>
            <input className="form-input" value={placeholder} onChange={e => setPlaceholder(e.target.value)} placeholder="Tekst podpowiedzi w pustym polu" />
          </div>
          <div className="form-group">
            <label className="form-label">Wartość domyślna</label>
            <input className="form-input" value={defaultValue} onChange={e => setDefaultValue(e.target.value)} />
          </div>
        </>
      )}

      <div style={{ display:"flex", gap:18, marginTop:4, marginBottom:12, flexWrap:"wrap" }}>
        <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer" }}>
          <input type="checkbox" checked={required} onChange={e => setRequired(e.target.checked)} style={{ width:16, height:16 }} />
          <span style={{ fontSize:13, fontWeight:600 }}>Wymagane</span>
        </label>
        {!isCreate && (
          <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer" }}>
            <input type="checkbox" checked={hidden} onChange={e => setHidden(e.target.checked)} style={{ width:16, height:16 }} />
            <span style={{ fontSize:13, fontWeight:600 }}>Ukryte w formularzu</span>
          </label>
        )}
      </div>

      <div className="btn-row">
        <button className="btn btn-ghost" onClick={onClose}>Anuluj</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={!canSave}>{isCreate ? "Dodaj pole" : "Zapisz"}</button>
      </div>
    </FloatingModal>
  );
};

// Wspólny renderer pojedynczego pola ze schemy (apartament i właściciel). Klucz nadaje rodzic.
const SchemaField = ({ field, form, set, touch, hasError }) => {
  const labelEl = <label className="form-label">{field.label}{field.required && <span style={{color:"var(--red)",marginLeft:3}}>*</span>}</label>;
  if (field.type === "textarea") {
    return (
      <div className="form-group">
        {labelEl}
        <textarea className="form-textarea" value={form[field.id] || ""} onChange={e => set(field.id, e.target.value)}
          placeholder={field.placeholder || ""} style={{ minHeight:60 }} />
      </div>
    );
  }
  if (field.type === "checkbox") {
    return (
      <div className="form-group">
        <label style={{ display:"flex", alignItems:"center", gap:10, cursor:"pointer" }}>
          <input type="checkbox" checked={!!form[field.id]} onChange={e => set(field.id, e.target.checked)} style={{ width:18, height:18 }} />
          <span style={{ fontSize:13, fontWeight:600 }}>{field.label}{field.required && <span style={{color:"var(--red)",marginLeft:3}}>*</span>}</span>
        </label>
      </div>
    );
  }
  if (field.type === "select") {
    return (
      <div className="form-group">
        {labelEl}
        <select className="form-select" value={form[field.id] || ""} onChange={e => set(field.id, e.target.value)}>
          <option value="">— wybierz —</option>
          {(field.options || []).map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    );
  }
  if (field.type === "url") {
    return (
      <div className="form-group">
        {labelEl}
        <input className="form-input" type="url" value={form[field.id] || ""} onChange={e => set(field.id, e.target.value)} placeholder={field.placeholder || "https://..."} />
      </div>
    );
  }
  if (field.type === "date" || field.type === "datetime") {
    return (
      <div className="form-group">
        {labelEl}
        <input className="form-input" type={field.type === "datetime" ? "datetime-local" : "date"} value={form[field.id] || ""} onChange={e => set(field.id, e.target.value)} />
      </div>
    );
  }
  if (field.type === "number") {
    return (
      <div className="form-group">
        {labelEl}
        <NumberInput className={`form-input ${hasError(field.id) ? "input-error" : ""}`}
          value={form[field.id] || ""} onChange={v => set(field.id, v)} onBlur={() => touch(field.id)} min={0} />
        <FieldError msg={hasError(field.id)} />
      </div>
    );
  }
  // text, email, phone (tel) i fallback
  const htmlType = field.type === "phone" ? "tel" : field.type === "email" ? "email" : "text";
  return (
    <div className="form-group">
      {labelEl}
      <input className={`form-input ${hasError(field.id) ? "input-error" : ""}`}
        type={htmlType} value={form[field.id] || ""} onChange={e => set(field.id, e.target.value)} onBlur={() => touch(field.id)}
        placeholder={field.placeholder || ""} />
      <FieldError msg={hasError(field.id)} />
    </div>
  );
};

const ApartmentForm = ({ apt, owners, onSave, onClose, onGoToSettings, defaultCategory }) => {
  const categoriesRef = useRef(Categories.getAll());
  const schemaFields = useRef(FormSchema.visible());
  const groupOrderRef = useRef(FormSchema.getGroupOrder("apartment"));

  // Build initial form values from schema (wszystkie pola, z wartościami domyślnymi)
  const initValues = {};
  FormSchema.sorted().forEach(f => {
    initValues[f.id] = f.defaultValue !== undefined ? f.defaultValue : (f.type === "checkbox" ? false : "");
  });
  initValues.aptStatus = "Wolny";
  initValues.status = defaultCategory || (categoriesRef.current[0] || {}).name || "";
  initValues.ownerId = (owners[0] || {}).id || 1;

  const { form, set, touch, submit, hasError } = useValidatedForm(apt || initValues, "apartment");
  const categories = categoriesRef.current;
  const currentCatExists = !form.status || categories.some(c => c.name === form.status);
  const [showOptional, setShowOptional] = useState(false);
  const allFields = useRef(FormSchema.sorted());
  const hiddenFields = allFields.current.filter(f => !f.visible);

  const renderSchemaField = (field) => <SchemaField key={field.id} field={field} form={form} set={set} touch={touch} hasError={hasError} />;

  // PAKIET 8b — grupowanie po user-defined groupOrder; pola bez grupy lub w nieznanej grupie → orphan-fallback
  const fieldsByGroup = {};
  schemaFields.current.forEach(f => {
    const g = f.group || "Inne";
    if (!fieldsByGroup[g]) fieldsByGroup[g] = [];
    fieldsByGroup[g].push(f);
  });
  const orderedGroups = groupOrderRef.current;
  const knownGroups = new Set(orderedGroups);
  const orphans = schemaFields.current.filter(f => !knownGroups.has(f.group || "Inne"));

  return (
    <FloatingModal open onClose={onClose} title={apt ? "Edytuj pozycję" : "Nowa pozycja"}>

        {/* Kategoria — zawsze na górze */}
        <div className="form-group">
          <label className="form-label">Kategoria <span style={{ color:"var(--red)", marginLeft:3 }}>*</span></label>
          {categories.length === 0 ? (
            <div style={{ padding:12, background:"rgba(245,158,11,0.12)", border:"1px solid var(--yellow)", borderRadius:10, fontSize:13, color:"var(--yellow)" }}>
              ⚠ Brak kategorii. <button onClick={onGoToSettings} style={{ background:"var(--accent)", color:"#000", border:"none", borderRadius:8, padding:"6px 12px", fontSize:11, fontWeight:700, cursor:"pointer", marginTop:8, display:"block" }}>→ Ustawienia</button>
            </div>
          ) : (
            <select className="form-select" value={form.status || ""} onChange={e => set("status", e.target.value)}>
              <option value="">— wybierz —</option>
              {categories.map(c => <option key={c.id} value={c.name}>{c.name}{c.builtin ? "" : " (własna)"}</option>)}
            </select>
          )}
          {!currentCatExists && form.status && <div style={{ marginTop:6, fontSize:12, color:"var(--yellow)" }}>⚠ Kategoria „{form.status}" nie istnieje.</div>}
        </div>

        {/* Właściciel */}
        <div className="form-group">
          <label className="form-label">Właściciel</label>
          <select className="form-select" value={form.ownerId} onChange={e => set("ownerId", parseInt(e.target.value))}>
            {owners.map(o => <option key={o.id} value={o.id}>{o.lastName} {o.firstName}</option>)}
          </select>
        </div>

        {/* PAKIET 8b — dynamiczne pola pogrupowane w kolejności groupOrder */}
        {orderedGroups.map(groupName => {
          const fields = fieldsByGroup[groupName];
          if (!fields || fields.length === 0) return null;
          return (
            <div key={groupName} style={{ marginBottom:8 }}>
              <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:6, marginTop:8 }}>{groupName}</div>
              {fields.map(f => renderSchemaField(f))}
            </div>
          );
        })}
        {orphans.length > 0 && (
          <div style={{ marginBottom:8 }}>
            <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:6, marginTop:8 }}>Inne</div>
            {orphans.map(f => renderSchemaField(f))}
          </div>
        )}

        {/* Opcjonalne pola (ukryte) */}
        {hiddenFields.length > 0 && (
          <div style={{ marginTop:8 }}>
            <button onClick={() => setShowOptional(o => !o)}
              style={{ background:"none", border:"1px dashed var(--border)", borderRadius:8, padding:"8px 12px", color:"var(--text2)", fontSize:11, fontWeight:600, cursor:"pointer", width:"100%", marginBottom:8 }}>
              {showOptional ? "▲ Ukryj dodatkowe pola" : `▼ Pokaż dodatkowe pola (${hiddenFields.length})`}
            </button>
            {showOptional && (
              <div style={{ padding:12, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10 }}>
                {hiddenFields.map(f => renderSchemaField(f))}
              </div>
            )}
          </div>
        )}

        <div className="btn-row" style={{ marginTop:12 }}>
          <button className="btn btn-ghost" onClick={onClose}>Anuluj</button>
          <button className="btn btn-primary" disabled={categories.length === 0 || !form.status} onClick={() => submit(onSave)}>Zapisz</button>
        </div>
    </FloatingModal>
  );
};

const TaskForm = ({ task, apartments, onSave, onClose, onToast }) => {
  // FIX 9.1 — zawsze startuj z kompletu defaultów; task (pełny lub prefill {apartmentId})
  // tylko nadpisuje brakujące pola. Wcześniej task={apartmentId:X} powodowało, że
  // assignedTo było undefined → V.required fail bez widocznego błędu.
  const noWorkers = !WORKERS || WORKERS.length === 0;
  // PAKIET 8b — overlay: FormSchema steruje widocznością builtin oraz pozwala dodać pola własne
  const taskSchema = useRef(FormSchema.sorted("task"));
  const taskVisMap = useRef(Object.fromEntries(taskSchema.current.map(f => [f.id, f.visible])));
  const taskCustomFields = useRef(taskSchema.current.filter(f => f.custom && f.visible));
  const isVis = (id) => taskVisMap.current[id] !== false;

  const customInit = {};
  taskCustomFields.current.forEach(f => {
    customInit[f.id] = f.defaultValue !== undefined ? f.defaultValue : (f.type === "checkbox" ? false : "");
  });

  const defaults = {
    apartmentId: (apartments[0] || {}).id || 1,
    title: "",
    assignedTo: WORKERS[0] || "",
    status: "Nie rozpoczęto",
    priority: "normal",
    notes: "", nextCheckout: "", nextCheckin: "", orderBy: "", location: "",
    ...customInit,
  };
  const initial = { ...defaults, ...(task || {}) };
  const { form, set, touch, submit, hasError } = useValidatedForm(initial, "task");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (saving) return;
    if (noWorkers) {
      onToast && onToast("⚠️ Brak zdefiniowanych pracowników — dodaj pracownika w ustawieniach", "warn");
      return;
    }
    setSaving(true);
    const ok = submit(onSave);
    if (!ok) {
      onToast && onToast("⚠️ Uzupełnij wymagane pola", "warn");
      setSaving(false);
    }
    // przy ok: parent zamyka modal (unmount) → setSaving(false) nie potrzebne
  };

  return (
    <FloatingModal open onClose={onClose} title={task && task.id ? "Edytuj zadanie" : "Nowe zadanie"}>
        <div className="form-group">
          <label className="form-label">Apartament / Lokalizacja <span style={{color:"var(--red)"}}>*</span></label>
          <select className={`form-select ${hasError("apartmentId") ? "input-error" : ""}`}
            value={form.apartmentId} onChange={e => set("apartmentId", parseInt(e.target.value))}>
            {apartments.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <FieldError msg={hasError("apartmentId")} />
        </div>
        <div className="form-group">
          <label className="form-label">Tytuł zadania <span style={{color:"var(--red)"}}>*</span></label>
          <input className={`form-input ${hasError("title") ? "input-error" : ""}`}
            value={form.title} onChange={e => set("title", e.target.value)} onBlur={() => touch("title")}
            placeholder="Co należy zrobić?" />
          <FieldError msg={hasError("title")} />
        </div>
        {(isVis("priority") || isVis("orderBy")) && (
          <div style={{ display: "grid", gridTemplateColumns: isVis("priority") && isVis("orderBy") ? "1fr 1fr" : "1fr", gap: 12 }}>
            {isVis("priority") && (
              <div className="form-group">
                <label className="form-label">Priorytet</label>
                <select className="form-select" value={form.priority || "normal"} onChange={e => set("priority", e.target.value)}>
                  <option value="high">🔴 Wysoki</option>
                  <option value="normal">🟡 Normalny</option>
                  <option value="low">🟢 Niski</option>
                </select>
              </div>
            )}
            {isVis("orderBy") && (
              <div className="form-group">
                <label className="form-label">Osoba zlecająca</label>
                <input className="form-input" value={form.orderBy || ""} onChange={e => set("orderBy", e.target.value)} placeholder="Kto zleca?" />
              </div>
            )}
          </div>
        )}
        <div className="form-group">
          <label className="form-label">Przypisz do <span style={{color:"var(--red)"}}>*</span></label>
          <select className={`form-select ${hasError("assignedTo") ? "input-error" : ""}`}
            value={form.assignedTo} onChange={e => set("assignedTo", e.target.value)}>
            {noWorkers
              ? <option value="">— brak pracowników —</option>
              : WORKERS.map(w => <option key={w}>{w}</option>)}
          </select>
          <FieldError msg={hasError("assignedTo") || (noWorkers ? "Brak zdefiniowanych pracowników — dodaj w ustawieniach" : null)} />
        </div>
        {/* FIX 9.5 — Status edytowalny tylko przy edycji istniejącego zadania */}
        {task && task.id && (
          <div className="form-group">
            <label className="form-label">Status</label>
            <select className="form-select" value={form.status} onChange={e => set("status", e.target.value)}>
              {Object.keys(TASK_STATUS_COLORS).map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
        )}
        {(isVis("nextCheckout") || isVis("nextCheckin")) && (
          <div style={{ display: "grid", gridTemplateColumns: isVis("nextCheckout") && isVis("nextCheckin") ? "1fr 1fr" : "1fr", gap: 12 }}>
            {isVis("nextCheckout") && (
              <div className="form-group"><label className="form-label">Wyjazd gości</label>
                <input className="form-input" type="datetime-local" value={form.nextCheckout} onChange={e => set("nextCheckout", e.target.value)} /></div>
            )}
            {isVis("nextCheckin") && (
              <div className="form-group"><label className="form-label">Przyjazd gości</label>
                <input className="form-input" type="datetime-local" value={form.nextCheckin} onChange={e => set("nextCheckin", e.target.value)} /></div>
            )}
          </div>
        )}
        {isVis("notes") && (
          <div className="form-group">
            <label className="form-label">Notatki</label>
            <textarea className={`form-textarea ${hasError("notes") ? "input-error" : ""}`}
              value={form.notes} onChange={e => set("notes", e.target.value)} onBlur={() => touch("notes")} />
            <FieldError msg={hasError("notes")} />
          </div>
        )}
        {/* PAKIET 8b — pola własne dodane w Ustawienia → Formularz → Zadanie */}
        {taskCustomFields.current.map(f => (
          <SchemaField key={f.id} field={f} form={form} set={set} touch={touch} hasError={hasError} />
        ))}
        <div className="btn-row">
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Anuluj</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || noWorkers}>
            {saving ? "Zapisywanie..." : "Zapisz"}
          </button>
        </div>
    </FloatingModal>
  );
};

const OwnerForm = ({ owner, onSave, onClose }) => {
  const schemaFields = useRef(FormSchema.visible("owner"));
  const allFields = useRef(FormSchema.sorted("owner"));
  const groupOrderRef = useRef(FormSchema.getGroupOrder("owner"));

  // Wartości początkowe ze schemy (wszystkie pola, z domyślnymi)
  const initValues = {};
  allFields.current.forEach(f => {
    initValues[f.id] = f.defaultValue !== undefined ? f.defaultValue : (f.type === "checkbox" ? false : "");
  });

  const { form, set, touch, submit, hasError } = useValidatedForm(owner || initValues, "owner");
  const [showOptional, setShowOptional] = useState(false);
  const hiddenFields = allFields.current.filter(f => !f.visible);

  // PAKIET 8b — grupowanie po user-defined groupOrder z fallbackiem orphan
  const fieldsByGroup = {};
  schemaFields.current.forEach(f => {
    const g = f.group || "Inne";
    if (!fieldsByGroup[g]) fieldsByGroup[g] = [];
    fieldsByGroup[g].push(f);
  });
  const orderedGroups = groupOrderRef.current;
  const knownGroups = new Set(orderedGroups);
  const orphans = schemaFields.current.filter(f => !knownGroups.has(f.group || "Inne"));

  return (
    <FloatingModal open onClose={onClose} title={owner ? "Edytuj właściciela" : "Nowy właściciel"}>
        {orderedGroups.map(groupName => {
          const fields = fieldsByGroup[groupName];
          if (!fields || fields.length === 0) return null;
          return (
            <div key={groupName} style={{ marginBottom:8 }}>
              <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:6, marginTop:8 }}>{groupName}</div>
              {fields.map(f => <SchemaField key={f.id} field={f} form={form} set={set} touch={touch} hasError={hasError} />)}
            </div>
          );
        })}
        {orphans.length > 0 && (
          <div style={{ marginBottom:8 }}>
            <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:6, marginTop:8 }}>Inne</div>
            {orphans.map(f => <SchemaField key={f.id} field={f} form={form} set={set} touch={touch} hasError={hasError} />)}
          </div>
        )}

        {hiddenFields.length > 0 && (
          <div style={{ marginTop:8 }}>
            <button onClick={() => setShowOptional(o => !o)}
              style={{ background:"none", border:"1px dashed var(--border)", borderRadius:8, padding:"8px 12px", color:"var(--text2)", fontSize:11, fontWeight:600, cursor:"pointer", width:"100%", marginBottom:8 }}>
              {showOptional ? "▲ Ukryj dodatkowe pola" : `▼ Pokaż dodatkowe pola (${hiddenFields.length})`}
            </button>
            {showOptional && (
              <div style={{ padding:12, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10 }}>
                {hiddenFields.map(f => <SchemaField key={f.id} field={f} form={form} set={set} touch={touch} hasError={hasError} />)}
              </div>
            )}
          </div>
        )}

        <div className="btn-row">
          <button className="btn btn-ghost" onClick={onClose}>Anuluj</button>
          <button className="btn btn-primary" onClick={() => submit(onSave)}>Zapisz</button>
        </div>
    </FloatingModal>
  );
};

// ─── APARTMENT DETAIL ─────────────────────────────────────────────────────────

// ─── CLEANING TEAM VIEW — widok dla roli cleaning_team ────────────────────────
const CleaningTeamView = ({ currentUser, apartments, cleaningSessions, onUpdateSession, onLogout }) => {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [timers, setTimers] = useState({}); // sessionId → running elapsed secs
  const [expandedId, setExpandedId] = useState(null);
  const [noteInputs, setNoteInputs] = useState({});
  const [leaderInputs, setLeaderInputs] = useState({}); // sessionId → leader name
  const cleaningLeaders = Settings.getCleaningLeaders();
  const tickRef = useRef(null);

  const sessions = cleaningSessions.filter(s => s.date === date)
    .sort((a, b) => {
      const order = { in_progress: 0, planned: 1, done: 2 };
      return (order[a.status] ?? 3) - (order[b.status] ?? 3);
    });

  // Tick timer every second for in_progress sessions
  useEffect(() => {
    tickRef.current = setInterval(() => {
      setTimers(prev => {
        const next = { ...prev };
        cleaningSessions.forEach(s => {
          if (s.status === "in_progress" && s.startedAt) {
            const elapsed = Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 1000);
            next[s.id] = (s.durationSec || 0) + elapsed;
          }
        });
        return next;
      });
    }, 1000);
    return () => clearInterval(tickRef.current);
  }, [cleaningSessions]);

  const formatTimer = (sec) => {
    if (!sec && sec !== 0) return "00:00:00";
    const h = String(Math.floor(sec / 3600)).padStart(2, "0");
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
    const s = String(sec % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  };

  const statusColor = { planned: "var(--text2)", in_progress: "var(--accent)", done: "var(--green)" };
  const statusLabel = { planned: "Zaplanowane", in_progress: "W trakcie", done: "Ukończone" };

  const todaySessions = cleaningSessions.filter(s => s.date === today);
  const doneToday = todaySessions.filter(s => s.status === "done").length;
  const inProgToday = todaySessions.filter(s => s.status === "in_progress").length;

  return (
    <div className="app-root">
      <style>{styles}</style>
      <div className="app">
        {/* Header */}
        <div className="header">
          <h1>Sprzątanie</h1>
          <div className="header-actions">
            <button className="icon-btn" onClick={onLogout} title="Wyloguj">
              <Icon name="logout" size={16} />
            </button>
          </div>
        </div>

        <div className="content" style={{ paddingTop: 0 }}>
          {/* Info o użytkowniku + stats */}
          <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:"var(--radius)", padding:16, marginBottom:16 }}>
            <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:4 }}>
              Zespół sprzątający
            </div>
            <div style={{ fontFamily:"var(--font-display)", fontSize:24, letterSpacing:"0.06em", marginBottom:12 }}>
              {currentUser.name}
            </div>
            <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
              <div style={{
                display:"flex", alignItems:"center", gap:6,
                padding:"6px 12px", borderRadius:20,
                background: inProgToday > 0 ? "rgba(59,130,246,0.12)" : "var(--surface2)",
                color: inProgToday > 0 ? "var(--accent)" : "var(--text2)",
                fontSize:11, fontWeight:700, letterSpacing:"0.06em",
              }}>
                <Icon name="sync" size={12} color={inProgToday > 0 ? "var(--accent)" : "var(--text2)"} />
                {inProgToday} w trakcie
              </div>
              <div style={{
                display:"flex", alignItems:"center", gap:6,
                padding:"6px 12px", borderRadius:20,
                background: doneToday > 0 ? "rgba(34,197,94,0.12)" : "var(--surface2)",
                color: doneToday > 0 ? "var(--green)" : "var(--text2)",
                fontSize:11, fontWeight:700, letterSpacing:"0.06em",
              }}>
                <Icon name="check" size={12} color={doneToday > 0 ? "var(--green)" : "var(--text2)"} />
                {doneToday}/{todaySessions.length} ukończone dziś
              </div>
            </div>
          </div>

          {/* Date picker */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <button onClick={() => { const d = new Date(date); d.setDate(d.getDate()-1); setDate(d.toISOString().slice(0,10)); }}
              style={{ background:"var(--surface)",border:"1px solid var(--border)",borderRadius:8,padding:"8px 12px",color:"var(--text)",cursor:"pointer",fontSize:16,fontWeight:700 }}>‹</button>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              style={{ flex:1, background:"var(--surface)",border:"1px solid var(--border)",borderRadius:10,padding:"10px 14px",color:"var(--text)",fontSize:14,fontWeight:600,fontFamily:"var(--font-body)" }} />
            <button onClick={() => { const d = new Date(date); d.setDate(d.getDate()+1); setDate(d.toISOString().slice(0,10)); }}
              style={{ background:"var(--surface)",border:"1px solid var(--border)",borderRadius:8,padding:"8px 12px",color:"var(--text)",cursor:"pointer",fontSize:16,fontWeight:700 }}>›</button>
            {date !== today && <button onClick={() => setDate(today)}
              style={{ background:"var(--accent)",border:"none",borderRadius:8,padding:"8px 14px",color:"#000",cursor:"pointer",fontSize:11,fontWeight:700,letterSpacing:"0.08em" }}>DZIŚ</button>}
          </div>

          {sessions.length === 0 ? (
            <div className="empty">
              <div className="empty-icon"><Icon name="check" size={40} /></div>
              <h3>Brak zaplanowanych sprzątań</h3>
              <p style={{ fontSize:13, color:"var(--text2)", marginTop:6 }}>
                Na {date === today ? "dzisiaj" : date} nie ma zaplanowanych sprzątań
              </p>
            </div>
          ) : sessions.map(session => {
            const apt = apartments.find(a => a.id === session.apartmentId);
            const isExpanded = expandedId === session.id;
            const currentSecs = timers[session.id] ?? session.durationSec ?? 0;

            return (
              <div key={session.id} className={`cleaning-card status-${session.status}`}>
                <div className="cleaning-card-header" onClick={() => setExpandedId(isExpanded ? null : session.id)}>
                  <div className="cleaning-status-dot" style={{ background: statusColor[session.status] }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily:"var(--font-display)", fontSize:18, letterSpacing:"0.06em" }}>{apt && apt.name || "—"}</div>
                    <div style={{ fontSize:11, color:"var(--text2)", marginTop:2, display:"flex", gap:8, flexWrap:"wrap" }}>
                      <span style={{ color: statusColor[session.status], fontWeight:700 }}>{statusLabel[session.status]}</span>
                      {session.assignedTo && <span>· {session.assignedTo}</span>}
                      {apt && apt.floor && <span>· {apt.floor === "PARTER" ? "Parter" : `Piętro ${apt.floor}`}</span>}
                      {apt && apt.aptNumber && <span>· nr {apt.aptNumber}</span>}
                    </div>
                    {/* Doba hotelowa + zabezpieczenie */}
                    <div style={{ fontSize:10, color:"var(--text2)", marginTop:4, display:"flex", gap:10, flexWrap:"wrap" }}>
                      {apt && apt.checkoutTime && (
                        <span style={{ color:"var(--yellow)", fontWeight:700 }}>
                          🕐 Doba do {apt.checkoutTime}
                        </span>
                      )}
                      {apt && apt.securityType && (
                        <span>
                          🔒 {apt.securityType}{apt.safeCode ? ` · kod: ${apt.safeCode}` : ""}
                        </span>
                      )}
                    </div>
                  </div>
                  {session.status === "in_progress" && (
                    <div style={{ fontFamily:"var(--font-display)", fontSize:20, color:"var(--accent)", letterSpacing:"0.06em", flexShrink:0 }}>
                      {formatTimer(currentSecs)}
                    </div>
                  )}
                  {session.status === "done" && (
                    <div style={{ fontSize:12, color:"var(--green)", fontWeight:700, flexShrink:0 }}>
                      {CleaningSessions.formatDuration(session.durationSec)}
                    </div>
                  )}
                </div>

                {isExpanded && (
                  <div className="cleaning-card-body">
                    {session.status === "in_progress" && (
                      <div className="cleaning-timer">{formatTimer(currentSecs)}</div>
                    )}

                    {apt && apt.entryInstruction && (
                      <div style={{ fontSize:12, color:"var(--text2)", background:"rgba(59,130,246,0.06)", borderRadius:8, padding:"8px 10px", marginBottom:10, lineHeight:1.6, whiteSpace:"pre-line" }}>
                        📋 {apt.entryInstruction}
                      </div>
                    )}
                    {apt && apt.wifi && (
                      <div style={{ fontSize:12, color:"var(--text2)", background:"rgba(59,130,246,0.04)", borderRadius:8, padding:"8px 10px", marginBottom:10 }}>
                        📶 {apt.wifi}
                      </div>
                    )}

                    {/* Dowodzący sprzątaniem */}
                    <div style={{ marginBottom:10 }}>
                      <div style={{ fontSize:10, color:"var(--text2)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:4 }}>Dowodzący sprzątaniem</div>
                      <select
                        style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 10px", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)" }}
                        value={leaderInputs[session.id] ?? session.assignedTo ?? ""}
                        onChange={e => {
                          setLeaderInputs(l => ({ ...l, [session.id]: e.target.value }));
                          CleaningSessions.updateAssigned(session.id, e.target.value);
                        }}
                      >
                        <option value="">— nie przypisano —</option>
                        {cleaningLeaders.map(l => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </div>

                    <textarea
                      placeholder="Notatka ze sprzątania..."
                      value={noteInputs[session.id] ?? session.notes ?? ""}
                      onChange={e => setNoteInputs(n => ({ ...n, [session.id]: e.target.value }))}
                      style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 10px", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", resize:"none", minHeight:60, marginBottom:10, boxSizing:"border-box" }}
                    />

                    <div className="cleaning-actions">
                      {session.status === "planned" && (
                        <button className="cleaning-btn start" onClick={() => onUpdateSession("start", session.id)}>
                          ▶ Rozpocznij
                        </button>
                      )}
                      {session.status === "in_progress" && (
                        <>
                          <button className="cleaning-btn stop" onClick={() => onUpdateSession("stop", session.id)}>
                            ⏸ Pauza
                          </button>
                          <button className="cleaning-btn done" onClick={() => onUpdateSession("finish", session.id, noteInputs[session.id] || "")}>
                            ✓ Zakończ
                          </button>
                        </>
                      )}
                      {session.status === "done" && (
                        <div style={{ flex:1, fontSize:13, color:"var(--green)", fontWeight:600, display:"flex", alignItems:"center", gap:6 }}>
                          <Icon name="check" size={16} color="var(--green)" /> Ukończono — {CleaningSessions.formatDuration(session.durationSec)}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ─── CLEANING TAB — widok w głównej nav (dla managera) ────────────────────────
// ─── SETTINGS VIEW — globalne szablony SMS + override per apt ────────────────
// ═══════════════════════════════════════════════════════════════════════════
// LOANS VIEW — pożyczki między apartamentami
// ═══════════════════════════════════════════════════════════════════════════
const LoansView = ({ apartments, loans, onUpdate, currentUser }) => {
  const [showForm, setShowForm] = useState(false);
  const [showReturned, setShowReturned] = useState(false);
  // PAKIET 8b — overlay: FormSchema steruje widocznością builtin oraz pozwala dodać pola własne
  const loanSchema = useRef(FormSchema.sorted("loan"));
  const loanVisMap = useRef(Object.fromEntries(loanSchema.current.map(f => [f.id, f.visible])));
  const loanCustomFields = useRef(loanSchema.current.filter(f => f.custom && f.visible));
  const isLoanVis = (id) => loanVisMap.current[id] !== false;
  const customInit = {};
  loanCustomFields.current.forEach(f => {
    customInit[f.id] = f.defaultValue !== undefined ? f.defaultValue : (f.type === "checkbox" ? false : "");
  });
  const [form, setForm] = useState({
    fromAptId: "", toAptId: "", notes: "",
    items: [{ name:"", qty:1 }],
    ...customInit,
  });
  const [error, setError] = useState("");

  const canManage = currentUser && currentUser.role === ROLES.MANAGER || currentUser && currentUser.role === ROLES.WORKER;

  const active   = loans.filter(l => l.status === "active");
  const returned = loans.filter(l => l.status === "returned");
  const visible  = showReturned ? returned : active;

  const resetForm = () => {
    setForm({ fromAptId:"", toAptId:"", notes:"", items:[{ name:"", qty:1 }], ...customInit });
    setError("");
  };

  const addItemLine = () => setForm(f => ({ ...f, items: [...f.items, { name:"", qty:1 }] }));
  const removeItemLine = (idx) => setForm(f => ({
    ...f,
    items: f.items.length > 1 ? f.items.filter((_, i) => i !== idx) : f.items,
  }));
  const updateItemLine = (idx, patch) => setForm(f => ({
    ...f,
    items: f.items.map((it, i) => i === idx ? { ...it, ...patch } : it),
  }));

  // ── Dynamiczne, dwukierunkowe filtrowanie pozycji ↔ apartamentu źródłowego ──
  // Wyposażenie apartamentu = zapis z localStorage (apt_equip_<id>) lub seed STANDARD_EQUIPMENT
  // (mirror logiki z ApartmentDetail). Dzięki temu nie da się wypożyczyć pozycji,
  // której apartament źródłowy nie ma na wyposażeniu.
  const equipNamesFor = (aptId) => {
    const stored = Storage.get(`apt_equip_${aptId}`);
    const list = Array.isArray(stored) ? stored : STANDARD_EQUIPMENT;
    return list.map(e => e.name);
  };
  // FIX 9.1b — ilości w apartamencie per nazwa (z fallbackiem qty=1 dla seed listy)
  const equipQtyMapFor = (aptId) => {
    const stored = Storage.get(`apt_equip_${aptId}`);
    const list = Array.isArray(stored) ? stored : STANDARD_EQUIPMENT;
    const m = new Map();
    list.forEach(e => m.set(e.name, (m.get(e.name) || 0) + Number(e.qty != null ? e.qty : 1)));
    return m;
  };
  // FIX 9.1b — sumaryczna ilość aktywnie wypożyczona z danego apartamentu per nazwa
  const borrowedQtyMapFor = (aptId) => {
    const m = new Map();
    loans.filter(l => l.status === "active" && l.fromAptId === Number(aptId))
      .flatMap(l => (l.items || []))
      .forEach(it => m.set(it.name, (m.get(it.name) || 0) + Number(it.qty || 0)));
    return m;
  };
  const availableQtyFor = (aptId, name) => {
    if (!aptId || !name) return 0;
    const have = equipQtyMapFor(Number(aptId)).get(name) || 0;
    const taken = borrowedQtyMapFor(Number(aptId)).get(name) || 0;
    return Math.max(0, have - taken);
  };
  // Pozycje do wyboru: jeśli wybrano „skąd" → tylko z tego apartamentu i tylko z dostępną ilością > 0;
  // jeśli nie → pełna lista (suma wyposażenia wszystkich apartamentów).
  const itemOptions = (() => {
    if (form.fromAptId) {
      return equipNamesFor(Number(form.fromAptId))
        .filter(n => availableQtyFor(form.fromAptId, n) > 0);
    }
    const set = new Set();
    apartments.forEach(a => equipNamesFor(a.id).forEach(n => set.add(n)));
    return [...set].sort((a, b) => a.localeCompare(b, "pl"));
  })();
  // Apartamenty „skąd": jeśli wybrano pozycje → tylko te, które mają WSZYSTKIE wybrane pozycje.
  const namedItems = form.items.map(i => (i.name || "").trim()).filter(Boolean);
  const sourceApts = namedItems.length === 0
    ? apartments
    : apartments.filter(a => { const names = equipNamesFor(a.id); return namedItems.every(it => names.includes(it)); });
  const sourceFiltered = namedItems.length > 0 && sourceApts.length < apartments.length;

  // Zmiana apartamentu źródłowego — wyczyść pozycje, których nowy apartament nie ma.
  const setFromApt = (id) => setForm(f => {
    if (!id) return { ...f, fromAptId: "" };
    const names = equipNamesFor(Number(id));
    return { ...f, fromAptId: id, items: f.items.map(it => names.includes(it.name) ? it : { ...it, name: "" }) };
  });

  const submit = () => {
    if (!form.fromAptId) { setError("Wybierz apartament, z którego pożyczasz"); return; }
    if (!form.toAptId)   { setError("Wybierz apartament, do którego pożyczasz"); return; }
    if (Number(form.fromAptId) === Number(form.toAptId)) { setError("Apartamenty muszą być różne"); return; }
    const items = form.items.filter(i => i.name.trim());
    if (items.length === 0) { setError("Dodaj przynajmniej jedną pozycję"); return; }
    // Twardy blok: apartament źródłowy musi mieć każdą pozycję na wyposażeniu
    const haveNames = equipNamesFor(Number(form.fromAptId));
    const missing = items.filter(i => !haveNames.includes(i.name.trim()));
    if (missing.length) { setError(`Apartament źródłowy nie ma na wyposażeniu: ${missing.map(m => m.name).join(", ")}`); return; }
    // FIX 9.1b — walidacja: ilość ≤ dostępne (uwzględnia już wypożyczone sztuki)
    for (const it of items) {
      const name = it.name.trim();
      const avail = availableQtyFor(form.fromAptId, name);
      const q = Number(it.qty || 0);
      if (q < 1) { setError(`Ilość '${name}' musi być ≥ 1`); return; }
      if (q > avail) { setError(`Nie można pożyczyć ${q} szt. '${name}' — dostępne tylko ${avail} szt. w apartamencie`); return; }
    }

    // PAKIET 8b — wyciągnij pola własne ze schemy
    const customFields = {};
    loanCustomFields.current.forEach(f => {
      if (form[f.id] !== undefined && form[f.id] !== "") customFields[f.id] = form[f.id];
    });
    const entry = Loans.add({
      fromAptId: form.fromAptId,
      toAptId: form.toAptId,
      items,
      notes: form.notes,
      createdBy: currentUser && currentUser.name || "",
      customFields,
    });
    if (!entry) { setError("Nie udało się utworzyć pożyczki"); return; }
    onUpdate && onUpdate();
    setShowForm(false);
    resetForm();
  };

  const handleReturn = (id) => {
    Loans.markReturned(id);
    onUpdate && onUpdate();
  };

  const handleDelete = (id) => {
    if (currentUser && currentUser.role !== ROLES.MANAGER) return;
    Loans.remove(id);
    onUpdate && onUpdate();
  };

  const aptName = (id) => ((apartments.find(a => a.id === id) || {}).name) || "—";

  return (
    <div>
      <div className="header">
        <h1>Pożyczki</h1>
        <div className="header-actions">
          {canManage && (
            <button className="icon-btn" onClick={() => setShowForm(true)} title="Nowa pożyczka">
              <Icon name="plus" size={16} color="var(--accent)" />
            </button>
          )}
        </div>
      </div>

      <div className="content">
        <p style={{ fontSize:13, color:"var(--text2)", marginBottom:16, lineHeight:1.6 }}>
          Pożyczki wyposażenia między apartamentami. Aktywne pożyczki są widoczne również w zakładce „Pożyczki" w widoku każdego apartamentu.
        </p>

        {/* Toggle aktywne/zwrócone */}
        <div className="filter-row" style={{ marginBottom:16 }}>
          <div className={`filter-chip ${!showReturned ? "active" : ""}`} onClick={() => setShowReturned(false)}>
            Aktywne ({active.length})
          </div>
          <div className={`filter-chip ${showReturned ? "active" : ""}`} onClick={() => setShowReturned(true)}>
            Zwrócone ({returned.length})
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="empty">
            <div className="empty-icon"><Icon name="swap" size={40} /></div>
            <h3>{showReturned ? "Brak zwróconych pożyczek" : "Brak aktywnych pożyczek"}</h3>
            {!showReturned && canManage && (
              <button className="btn btn-primary" style={{ marginTop:16 }} onClick={() => setShowForm(true)}>
                + Nowa pożyczka
              </button>
            )}
          </div>
        ) : visible.map(loan => (
          <div key={loan.id} style={{
            background:"var(--surface)",
            border:"1px solid var(--border)",
            borderLeft:`3px solid ${loan.status === "active" ? "var(--yellow)" : "var(--green)"}`,
            borderRadius:"var(--radius)",
            padding:14,
            marginBottom:10,
          }}>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10, flexWrap:"wrap" }}>
              <div style={{ fontFamily:"var(--font-display)", fontSize:16, letterSpacing:"0.06em" }}>
                {aptName(loan.fromAptId)}
              </div>
              <Icon name="swap" size={14} color="var(--text2)" />
              <div style={{ fontFamily:"var(--font-display)", fontSize:16, letterSpacing:"0.06em" }}>
                {aptName(loan.toAptId)}
              </div>
              <span style={{
                marginLeft:"auto",
                fontSize:10, fontWeight:700, letterSpacing:"0.08em", padding:"2px 8px", borderRadius:4,
                background: loan.status === "active" ? "rgba(245,158,11,0.15)" : "rgba(34,197,94,0.15)",
                color:      loan.status === "active" ? "var(--yellow)"        : "var(--green)",
              }}>
                {loan.status === "active" ? "AKTYWNA" : "ZWRÓCONA"}
              </span>
            </div>

            <div style={{ marginBottom:8 }}>
              {loan.items.map((it, i) => (
                <div key={i} style={{ fontSize:13, padding:"3px 0" }}>
                  • {it.name} <span style={{ color:"var(--text2)" }}>× {it.qty}</span>
                </div>
              ))}
            </div>

            {loan.notes && (
              <div style={{ fontSize:12, color:"var(--text2)", fontStyle:"italic", paddingLeft:10, borderLeft:"2px solid var(--border)", marginBottom:8 }}>
                "{loan.notes}"
              </div>
            )}

            <div style={{ fontSize:11, color:"var(--text2)", marginBottom:loan.status === "active" ? 10 : 0 }}>
              Pożyczono: {loan.borrowedAt && loan.borrowedAt.slice(0,10)}
              {loan.createdBy && ` · przez ${loan.createdBy}`}
              {loan.returnedAt && ` · zwrócono: ${loan.returnedAt.slice(0,10)}`}
            </div>

            {loan.status === "active" && canManage && (
              <div style={{ display:"flex", gap:8 }}>
                <button
                  onClick={() => handleReturn(loan.id)}
                  style={{ flex:1, background:"rgba(34,197,94,0.15)", color:"var(--green)", border:"1px solid rgba(34,197,94,0.3)", borderRadius:8, padding:"8px 12px", fontSize:11, fontWeight:700, letterSpacing:"0.08em", cursor:"pointer" }}
                >✓ Oznacz jako zwrócone</button>
                {currentUser && currentUser.role === ROLES.MANAGER && (
                  <button
                    onClick={() => handleDelete(loan.id)}
                    title="Usuń pożyczkę"
                    style={{ background:"rgba(239,68,68,0.1)", border:"1px solid rgba(239,68,68,0.3)", borderRadius:8, padding:"6px 10px", cursor:"pointer", color:"var(--red)" }}
                  ><Icon name="trash" size={12} /></button>
                )}
              </div>
            )}
            {loan.status === "returned" && currentUser && currentUser.role === ROLES.MANAGER && (
              <button
                onClick={() => handleDelete(loan.id)}
                style={{ background:"rgba(239,68,68,0.1)", border:"1px solid rgba(239,68,68,0.3)", borderRadius:8, padding:"6px 10px", cursor:"pointer", color:"var(--red)", fontSize:11, fontWeight:700 }}
              >🗑 Usuń z historii</button>
            )}
          </div>
        ))}
      </div>

      {/* Formularz pożyczki */}
      {showForm && (
        <FloatingModal open onClose={() => { setShowForm(false); resetForm(); }} title="Nowa pożyczka">

            <div className="form-group">
              <label className="form-label">Z apartamentu (wypożyczamy z) *</label>
              <select
                className="form-select"
                value={form.fromAptId}
                onChange={e => setFromApt(e.target.value)}
              >
                <option value="">— wybierz —</option>
                {sourceApts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              {sourceFiltered && (
                <div style={{ fontSize:11, color:"var(--text2)", marginTop:4 }}>
                  Pokazano tylko apartamenty mające wybrane pozycje na wyposażeniu.
                </div>
              )}
            </div>

            <div className="form-group">
              <label className="form-label">Do apartamentu (wypożyczamy do) *</label>
              <select
                className="form-select"
                value={form.toAptId}
                onChange={e => setForm(f => ({ ...f, toAptId: e.target.value }))}
              >
                <option value="">— wybierz —</option>
                {apartments.filter(a => String(a.id) !== String(form.fromAptId)).map(a =>
                  <option key={a.id} value={a.id}>{a.name}</option>
                )}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Pozycje do pożyczenia</label>
              {!form.fromAptId && (
                <div style={{ fontSize:11, color:"var(--text2)", marginBottom:6 }}>
                  Lista wszystkich pozycji ze wszystkich apartamentów — po wyborze pozycji lista „skąd" zawęzi się do apartamentów, które ją mają.
                </div>
              )}
              {form.fromAptId && itemOptions.length === 0 && (
                <div style={{ fontSize:11, color:"var(--text2)", marginBottom:6 }}>
                  Brak wolnego wyposażenia do pożyczenia z tego apartamentu (wszystko jest już wypożyczone).
                </div>
              )}
              {form.items.map((item, idx) => {
                const opts = item.name && !itemOptions.includes(item.name) ? [item.name, ...itemOptions] : itemOptions;
                // FIX 9.1b — max = dostępne sztuki w apartamencie źródłowym
                const avail = form.fromAptId && item.name ? availableQtyFor(form.fromAptId, item.name) : null;
                return (
                <div key={idx} style={{ display:"flex", gap:6, marginBottom:6 }}>
                  <select
                    className="form-select"
                    style={{ flex:1 }}
                    value={item.name}
                    onChange={e => updateItemLine(idx, { name: e.target.value })}
                  >
                    <option value="">{form.fromAptId ? "— wybierz pozycję —" : "— wybierz pozycję (dowolny apartament) —"}</option>
                    {opts.map(n => {
                      const lbl = form.fromAptId ? `${n} (dostępne: ${availableQtyFor(form.fromAptId, n)})` : n;
                      return <option key={n} value={n}>{lbl}</option>;
                    })}
                  </select>
                  <NumberInput
                    className="form-input"
                    style={{ width:80 }}
                    steppers={false}
                    min={1}
                    max={avail || undefined}
                    value={item.qty}
                    onChange={v => updateItemLine(idx, { qty: v })}
                  />
                  {form.items.length > 1 && (
                    <button
                      onClick={() => removeItemLine(idx)}
                      style={{ background:"rgba(239,68,68,0.1)", border:"none", borderRadius:8, padding:"0 12px", color:"var(--red)", cursor:"pointer" }}
                    >−</button>
                  )}
                </div>
                );
              })}
              <button
                onClick={addItemLine}
                style={{ background:"none", border:"1px dashed var(--border)", borderRadius:8, padding:"8px 12px", color:"var(--text2)", fontSize:12, fontWeight:600, cursor:"pointer", width:"100%", marginTop:4 }}
              >+ Dodaj kolejną pozycję</button>
            </div>

            {isLoanVis("notes") && (
              <div className="form-group">
                <label className="form-label">Notatki</label>
                <textarea
                  className="form-textarea"
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="opcjonalnie..."
                />
              </div>
            )}

            {/* PAKIET 8b — pola własne dodane w Ustawienia → Formularz → Pożyczka */}
            {loanCustomFields.current.map(f => (
              <SchemaField key={f.id} field={f}
                form={form}
                set={(k, v) => setForm(prev => ({ ...prev, [k]: v }))}
                touch={() => {}}
                hasError={() => null}
              />
            ))}

            {error && (
              <div style={{ padding:"8px 10px", background:"rgba(239,68,68,0.12)", border:"1px solid rgba(239,68,68,0.3)", borderRadius:8, fontSize:12, color:"var(--red)", marginBottom:10, fontWeight:600 }}>
                {error}
              </div>
            )}

            <div className="btn-row">
              <button className="btn btn-ghost" onClick={() => { setShowForm(false); resetForm(); }}>Anuluj</button>
              <button className="btn btn-primary" onClick={submit}>Zapisz pożyczkę</button>
            </div>
        </FloatingModal>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// FILE FORM — współdzielony modal dodawania pliku (FIX 2.A + 2.C)
// Używany w głównej zakładce Pliki oraz w detalu apartamentu. Gdy lockedAptId
// jest ustawione, plik jest na sztywno powiązany z tym apartamentem (pole ukryte).
// ═══════════════════════════════════════════════════════════════════════════
const FileForm = ({ apartments, currentUser, onClose, onSaved, lockedAptId = null, lockedAptName = "", defaultCategory = "other" }) => {
  const [form, setForm] = useState({
    name:"", url:"", category: defaultCategory || "other",
    aptId: lockedAptId != null ? String(lockedAptId) : "",
    description:"",
  });
  const [error, setError] = useState("");

  const submit = () => {
    if (!form.name.trim()) { setError("Nazwa jest wymagana"); return; }
    if (!form.url.trim())  { setError("URL jest wymagany"); return; }
    try {
      new URL(form.url);
    } catch {
      setError("Nieprawidłowy URL (dodaj https://...)");
      return;
    }
    const entry = Files.add({
      name: form.name,
      url: form.url,
      category: form.category,
      aptId: lockedAptId != null ? lockedAptId : (form.aptId || null),
      description: form.description,
      addedBy: currentUser && currentUser.name || "",
    });
    if (!entry) { setError("Nie udało się zapisać"); return; }
    onSaved && onSaved();
  };

  return (
    <FloatingModal open onClose={onClose} title="Dodaj plik">
      {lockedAptName && (
        <div style={{ padding:"10px 12px", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, fontSize:12, color:"var(--text2)", marginBottom:16 }}>
          Plik będzie powiązany z: <strong style={{ color:"var(--text)" }}>{lockedAptName}</strong>
        </div>
      )}

      <div className="form-group">
        <label className="form-label">Nazwa pliku *</label>
        <input className="form-input" value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          placeholder="np. Umowa najmu — szablon 2026" />
      </div>

      <div className="form-group">
        <label className="form-label">URL (Google Drive, Dropbox, inne) *</label>
        <input className="form-input" value={form.url}
          onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
          placeholder="https://drive.google.com/..." />
      </div>

      <div className="form-group">
        <label className="form-label">Kategoria</label>
        <select className="form-select" value={form.category}
          onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
          {FILE_CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </div>

      {lockedAptId == null && (
        <div className="form-group">
          <label className="form-label">Powiąż z apartamentem (opcjonalnie)</label>
          <select className="form-select" value={form.aptId}
            onChange={e => setForm(f => ({ ...f, aptId: e.target.value }))}>
            <option value="">— bez powiązania (plik ogólny) —</option>
            {apartments.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      )}

      <div className="form-group">
        <label className="form-label">Opis</label>
        <textarea className="form-textarea" value={form.description}
          onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
          placeholder="opcjonalnie..." />
      </div>

      {error && (
        <div style={{ padding:"8px 10px", background:"rgba(239,68,68,0.12)", border:"1px solid rgba(239,68,68,0.3)", borderRadius:8, fontSize:12, color:"var(--red)", marginBottom:10, fontWeight:600 }}>
          {error}
        </div>
      )}

      <div className="btn-row">
        <button className="btn btn-ghost" onClick={onClose}>Anuluj</button>
        <button className="btn btn-primary" onClick={submit}>Zapisz</button>
      </div>
    </FloatingModal>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// FILES VIEW — pliki i linki (szablony, instrukcje)
// ═══════════════════════════════════════════════════════════════════════════
const FilesView = ({ apartments, files, onUpdate, currentUser }) => {
  const [showForm, setShowForm] = useState(false);
  const [filterCat, setFilterCat] = useState("all");
  const [filterApt, setFilterApt] = useState("all");

  const canManage = currentUser && currentUser.role === ROLES.MANAGER || currentUser && currentUser.role === ROLES.WORKER;

  const visible = files.filter(f => {
    if (filterCat !== "all" && f.category !== filterCat) return false;
    if (filterApt === "none" && f.aptId) return false;
    if (filterApt !== "all" && filterApt !== "none" && String(f.aptId) !== String(filterApt)) return false;
    return true;
  });

  const handleDelete = (id) => {
    if (currentUser && currentUser.role !== ROLES.MANAGER) return;
    Files.remove(id);
    onUpdate && onUpdate();
  };

  const openAddForm = () => setShowForm(true);

  const aptName = (id) => ((apartments.find(a => a.id === id) || {}).name) || "—";
  const catLabel = fileCatLabel;
  const catColor = FILE_CAT_COLORS;

  return (
    <div>
      <div className="header">
        <h1>Pliki</h1>
        <div className="header-actions">
          {canManage && (
            <button className="icon-btn" onClick={openAddForm} title="Dodaj plik">
              <Icon name="plus" size={16} color="var(--accent)" />
            </button>
          )}
        </div>
      </div>

      <div className="content">
        <p style={{ fontSize:13, color:"var(--text2)", marginBottom:16, lineHeight:1.6 }}>
          Linki do dokumentów zewnętrznych (Google Drive, Dropbox, inne). Przechowywane są tylko adresy URL, nie same pliki.
        </p>

        {/* Filtry */}
        <div className="filter-row" style={{ marginBottom:10 }}>
          <div className={`filter-chip ${filterCat === "all" ? "active" : ""}`} onClick={() => setFilterCat("all")}>
            Wszystkie
          </div>
          {FILE_CATEGORIES.map(c => (
            <div key={c.id} className={`filter-chip ${filterCat === c.id ? "active" : ""}`} onClick={() => setFilterCat(c.id)}>
              {c.label}
            </div>
          ))}
        </div>

        <div style={{ marginBottom:16 }}>
          <select
            className="form-select"
            value={filterApt}
            onChange={e => setFilterApt(e.target.value)}
            style={{ fontSize:12 }}
          >
            <option value="all">Wszystkie apartamenty</option>
            <option value="none">Bez apartamentu (ogólne)</option>
            {apartments.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>

        {visible.length === 0 ? (
          <div className="empty">
            <div className="empty-icon"><Icon name="file" size={40} /></div>
            <h3>Brak plików</h3>
            {canManage && (
              <button className="btn btn-primary" style={{ marginTop:16 }} onClick={openAddForm}>
                + Dodaj pierwszy plik
              </button>
            )}
          </div>
        ) : visible.map(f => (
          <div key={f.id} style={{
            background:"var(--surface)",
            border:"1px solid var(--border)",
            borderLeft:`3px solid ${catColor[f.category] || "var(--text2)"}`,
            borderRadius:"var(--radius)",
            padding:14, marginBottom:10,
          }}>
            <div style={{ display:"flex", alignItems:"flex-start", gap:10, marginBottom:8 }}>
              <Icon name="file" size={18} color={catColor[f.category] || "var(--text2)"} />
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:14, fontWeight:700 }}>{f.name}</div>
                <div style={{ display:"flex", gap:8, marginTop:4, flexWrap:"wrap" }}>
                  <span style={{ fontSize:10, fontWeight:700, letterSpacing:"0.06em", padding:"2px 6px", borderRadius:4, background:`${catColor[f.category] || "#888"}22`, color: catColor[f.category] || "var(--text2)" }}>
                    {catLabel(f.category).toUpperCase()}
                  </span>
                  {f.aptId && (
                    <span style={{ fontSize:10, fontWeight:600, color:"var(--text2)" }}>
                      {aptName(f.aptId)}
                    </span>
                  )}
                </div>
              </div>
              {currentUser && currentUser.role === ROLES.MANAGER && (
                <button
                  onClick={() => handleDelete(f.id)}
                  style={{ background:"rgba(239,68,68,0.1)", border:"none", borderRadius:8, padding:"6px 8px", cursor:"pointer", color:"var(--red)" }}
                ><Icon name="trash" size={12} /></button>
              )}
            </div>

            {f.description && (
              <div style={{ fontSize:12, color:"var(--text2)", marginBottom:8, paddingLeft:10, borderLeft:"2px solid var(--border)" }}>
                {f.description}
              </div>
            )}

            <div style={{ fontSize:10, color:"var(--text2)", marginBottom:10 }}>
              Dodano: {f.addedAt && f.addedAt.slice(0,10)}{f.addedBy && ` · ${f.addedBy}`}
            </div>

            <a
              href={f.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 12px", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, color:"var(--accent)", fontSize:12, fontWeight:700, letterSpacing:"0.06em", textDecoration:"none", textTransform:"uppercase" }}
            >
              <Icon name="link" size={14} color="var(--accent)" />
              Otwórz w nowej karcie
            </a>
          </div>
        ))}
      </div>

      {/* Formularz dodawania pliku */}
      {showForm && (
        <FileForm
          apartments={apartments}
          currentUser={currentUser}
          defaultCategory={filterCat !== "all" ? filterCat : "other"}
          onClose={() => setShowForm(false)}
          onSaved={() => { onUpdate && onUpdate(); setShowForm(false); }}
        />
      )}
    </div>
  );
};

// FIX 6.4 — reużywalny panel zmiennych SMS (ustawienia + ApartmentDetail).
// Wcześniej w detalu apartamentu była tylko statyczna linijka "Zmienne: ..." bez
// klikania ani opisów. Teraz oba miejsca renderują ten sam rozwijany panel.
const SmsVariablesPanel = ({ onInsert }) => (
  <details className="sms-vars-panel" open>
    <summary>Dostępne zmienne — kliknij, aby wstawić</summary>
    <div className="sms-vars-list">
      {SMS_VARIABLES.map(v => (
        <button type="button" key={v.name} className="sms-var-chip" onClick={() => onInsert(v.name)}>
          <code>{v.name}</code>
          <span className="sms-var-desc">{v.description}</span>
          <span className="sms-var-ex">np. {v.example}</span>
        </button>
      ))}
    </div>
  </details>
);

// FIX 1.6 — wyniesione z SettingsView. Wcześniej zdefiniowane WEWNĄTRZ SettingsView,
// przez co przy każdym setDraft (każdy znak) komponent był tworzony na nowo i textarea
// traciła focus (ESLint: react-hooks/static-components). Top-level = stabilny typ.
// Dodaje też panel "Dostępne zmienne" z wstawianiem tokenu w miejscu kursora.
const TemplateCard = ({ type, color, isEditing, template, isDefault, isManager, draft, setDraft, saved, onStartEdit, onSave, onReset, onCancel }) => {
  const taRef = useRef(null);

  const insertVar = (token) => {
    const ta = taRef.current;
    const cur = draft || "";
    if (!ta) { setDraft(cur + token); return; }
    const start = ta.selectionStart, end = ta.selectionEnd;
    setDraft(cur.slice(0, start) + token + cur.slice(end));
    // textarea może się przemontować po setDraft — przywróć focus i kursor po tokenie
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (el) { const pos = start + token.length; el.focus(); el.setSelectionRange(pos, pos); }
    });
  };

  return (
    <div style={{ background:"var(--surface)", border:`1px solid ${color}33`, borderLeft:`3px solid ${color}`, borderRadius:"var(--radius)", padding:16, marginBottom:16 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10, flexWrap:"wrap", gap:8 }}>
        <div style={{ fontFamily:"var(--font-display)", fontSize:20, letterSpacing:"0.08em", color }}>{type}</div>
        {!isDefault && (
          <span style={{ fontSize:9, fontWeight:700, letterSpacing:"0.08em", padding:"2px 8px", borderRadius:6, background:"rgba(245,158,11,0.15)", color:"var(--yellow)" }}>
            ZMODYFIKOWANY
          </span>
        )}
      </div>

      {!isEditing ? (
        <>
          <div className="sms-template-box" style={{ marginBottom:10 }}>{template}</div>
          {isManager && (
            <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
              <button className="btn btn-primary" style={{ flex:1, minWidth:100 }} onClick={onStartEdit}>✏ Edytuj</button>
              {!isDefault && (
                <button className="btn" style={{ flex:1, minWidth:100 }} onClick={onReset}>↺ Reset do domyślnego</button>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <SmsVariablesPanel onInsert={insertVar} />
          <textarea
            ref={taRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"12px", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", lineHeight:1.7, resize:"vertical", minHeight:200, boxSizing:"border-box" }}
          />
          <div style={{ display:"flex", gap:8, marginTop:10 }}>
            <button className="btn btn-primary" style={{ flex:1 }} onClick={onSave}>
              {saved ? "✓ Zapisano!" : "✓ Zapisz"}
            </button>
            <button className="btn" style={{ flex:1 }} onClick={onCancel}>Anuluj</button>
          </div>
        </>
      )}
    </div>
  );
};

const SettingsView = ({ apartments, currentUser, onCategoriesChange, theme, onToggleTheme, aptColumns, onSetAptColumns, navPos, onSetNavPos, initialTab, initialTabBump, onOpenKw }) => {
  const isManager = currentUser && currentUser.role === ROLES.MANAGER;
  const [settingsTab, setSettingsTab] = useState(initialTab || "general"); // general | categories | equipment | sms
  // PAKIET 7.5 — deep-link z submenu nawigacji. initialTabBump rośnie przy każdym kliknięciu submenu,
  // więc nawet ten sam initialTab przeładuje zakładkę (klik "Ogólne" → "Kategorie" → "Ogólne" działa).
  // Wzorzec "set state during render po zmianie propsa" — patrz react.dev/reference/react/useState#storing-information-from-previous-renders.
  const [appliedBump, setAppliedBump] = useState(initialTabBump);
  if (initialTabBump !== appliedBump) {
    setAppliedBump(initialTabBump);
    if (initialTab) setSettingsTab(initialTab);
  }
  const [settings, setSettings] = useState(() => Settings.getAll());
  const [editingType, setEditingType] = useState(null);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);

  // ── Kategorie pomieszczeń wyposażenia ──────────────────────────────────
  const [eqRooms, setEqRooms] = useState(() => EquipmentRooms.getAll());
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomAptId, setNewRoomAptId] = useState(""); // "" = global
  const refreshRooms = () => setEqRooms(EquipmentRooms.getAll());
  // FIX 3.A — usuwanie wbudowanych kategorii pomieszczeń (podwójne potwierdzenie)
  const [roomDeleteStep1, setRoomDeleteStep1] = useState(null); // room — pierwsze ostrzeżenie
  const [roomDeleteStep2, setRoomDeleteStep2] = useState(null); // room — przepisanie nazwy
  const [roomDeleteText,  setRoomDeleteText]  = useState("");
  // PAKIET 8a.3 — edycja nazwy pomieszczenia
  const [editingRoom, setEditingRoom] = useState(null); // { id, name, ... } | null

  // PAKIET 8a.1 — Tekstylia (globalna lista edytowalna)
  const [textiles, setTextiles] = useState(() => TextilesService.getAll());
  const refreshTextiles = () => setTextiles(TextilesService.getAll());
  const [editingTextile, setEditingTextile] = useState(null); // { create:true } | item | null
  const [textileDeleteStep1, setTextileDeleteStep1] = useState(null);
  const [textileDeleteStep2, setTextileDeleteStep2] = useState(null);
  const [textileDeleteText, setTextileDeleteText] = useState("");

  // ── Zespół — osoby dowodzące sprzątaniem ──────────────────────────────
  const [leaders, setLeaders] = useState(() => Settings.getCleaningLeaders());
  const [newLeader, setNewLeader] = useState("");

  // ── Form Builder state ──────────────────────────────────────────────────
  const [formCat, setFormCat] = useState("apartment"); // konfigurowana kategoria formularza
  const [schemaFields, setSchemaFields] = useState(() => FormSchema.sorted("apartment"));
  const [groupOrder, setGroupOrder] = useState(() => FormSchema.getGroupOrder("apartment"));
  const [fieldModal, setFieldModal] = useState(null); // { field } edycja | { create:true } | null
  const [showSchemaReset, setShowSchemaReset] = useState(false);
  const [deleteFieldId, setDeleteFieldId] = useState(null); // potwierdzenie usunięcia pola własnego
  // PAKIET 8b — zarządzanie grupami
  const [newGroupModal, setNewGroupModal] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [editGroupModal, setEditGroupModal] = useState(null); // { oldName, newName }
  const [deleteGroupConfirm, setDeleteGroupConfirm] = useState(null); // groupName
  const refreshSchema = (cat = formCat) => {
    setSchemaFields(FormSchema.sorted(cat));
    setGroupOrder(FormSchema.getGroupOrder(cat));
  };
  const changeFormCat = (cat) => {
    setFormCat(cat);
    setSchemaFields(FormSchema.sorted(cat));
    setGroupOrder(FormSchema.getGroupOrder(cat));
  };

  const toggleFieldVisibility = (id) => {
    const f = schemaFields.find(x => x.id === id);
    if (!f || !isManager) return;
    FormSchema.setVisible(id, !f.visible, formCat);
    refreshSchema();
  };
  const toggleFieldRequired = (id) => {
    const f = schemaFields.find(x => x.id === id);
    if (!f || !isManager) return;
    FormSchema.updateField(id, { required: !f.required }, formCat);
    refreshSchema();
  };
  // Reorder w obrębie grupy — zamienia wartości order z sąsiadem w tej samej grupie
  const moveFieldInGroup = (groupFields, idx, dir) => {
    if (!isManager) return;
    const swap = dir === "up" ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= groupFields.length) return;
    const a = groupFields[idx], b = groupFields[swap];
    const orderA = a.order, orderB = b.order;
    FormSchema.updateField(a.id, { order: orderB }, formCat);
    FormSchema.updateField(b.id, { order: orderA }, formCat);
    refreshSchema();
  };
  const saveFieldModal = (res) => {
    if (!isManager) return;
    if (res.mode === "create") FormSchema.addField(res.payload, formCat);
    else FormSchema.updateField(res.id, res.changes, formCat);
    refreshSchema();
    setFieldModal(null);
  };
  const removeCustomField = (id) => {
    if (!isManager) return;
    FormSchema.removeField(id, formCat);
    refreshSchema();
  };
  const resetSchema = () => {
    if (!isManager) return;
    FormSchema.resetAll(formCat);
    refreshSchema();
    setShowSchemaReset(false);
  };
  // PAKIET 8b — handlery zarządzania grupami
  const moveGroupUp = (name) => {
    if (!isManager) return;
    FormSchema.moveGroup(formCat, name, -1);
    refreshSchema();
  };
  const moveGroupDown = (name) => {
    if (!isManager) return;
    FormSchema.moveGroup(formCat, name, 1);
    refreshSchema();
  };
  const handleAddGroup = () => {
    if (!isManager) return;
    const name = newGroupName.trim();
    if (!name) return;
    FormSchema.addGroup(formCat, name);
    refreshSchema();
    setNewGroupName("");
    setNewGroupModal(false);
  };
  const handleRenameGroup = () => {
    if (!isManager || !editGroupModal) return;
    const next = (editGroupModal.newName || "").trim();
    if (!next || next === editGroupModal.oldName) { setEditGroupModal(null); return; }
    FormSchema.renameGroup(formCat, editGroupModal.oldName, next);
    refreshSchema();
    setEditGroupModal(null);
  };
  const handleDeleteGroup = () => {
    if (!isManager || !deleteGroupConfirm) return;
    FormSchema.removeGroup(formCat, deleteGroupConfirm);
    refreshSchema();
    setDeleteGroupConfirm(null);
  };
  const addLeader = () => {
    if (!isManager || !newLeader.trim()) return;
    const updated = [...leaders, newLeader.trim()];
    Settings.setCleaningLeaders(updated);
    setLeaders(updated);
    setNewLeader("");
  };
  const removeLeader = (idx) => {
    if (!isManager) return;
    const updated = leaders.filter((_, i) => i !== idx);
    Settings.setCleaningLeaders(updated);
    setLeaders(updated);
  };

  const addRoom = () => {
    if (!isManager || !newRoomName.trim()) return;
    EquipmentRooms.add({ name: newRoomName.trim(), aptId: newRoomAptId ? Number(newRoomAptId) : null });
    refreshRooms();
    setNewRoomName("");
    setNewRoomAptId("");
  };

  const deleteRoom = (id) => {
    if (!isManager) return;
    EquipmentRooms.remove(id);
    refreshRooms();
  };

  // PAKIET 8a.3 — reorder globalnych pomieszczeń strzałkami ▲▼
  const moveRoom = (id, dir) => {
    if (!isManager) return;
    const list = eqRooms.filter(r => !r.aptId);
    const idx = list.findIndex(r => r.id === id);
    if (idx < 0) return;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= list.length) return;
    const reordered = [...list];
    [reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]];
    EquipmentRooms.reorder(reordered.map(r => r.id));
    refreshRooms();
  };

  const saveRoomEdit = () => {
    if (!isManager || !editingRoom) return;
    const name = (editingRoom.name || "").trim();
    if (!name) return;
    EquipmentRooms.update(editingRoom.id, { name });
    refreshRooms();
    setEditingRoom(null);
  };

  // PAKIET 8a.1 — Helpery dla TEKSTYLIA
  const moveTextile = (id, dir) => {
    if (!isManager) return;
    const idx = textiles.findIndex(t => t.id === id);
    if (idx < 0) return;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= textiles.length) return;
    const reordered = [...textiles];
    [reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]];
    TextilesService.reorder(reordered.map(t => t.id));
    refreshTextiles();
  };

  const saveTextileEdit = () => {
    if (!isManager || !editingTextile) return;
    const name = (editingTextile.name || "").trim();
    const size = (editingTextile.size || "").trim();
    if (!name) return;
    if (editingTextile.create) {
      TextilesService.add({ name, size });
    } else {
      TextilesService.update(editingTextile.id, { name, size });
    }
    refreshTextiles();
    setEditingTextile(null);
  };

  const handleDeleteTextile = (t) => {
    if (!isManager) return;
    if (t.builtin) {
      setTextileDeleteText("");
      setTextileDeleteStep1(t);
    } else {
      setTextileDeleteStep1(t); // też confirm, ale z jednym krokiem (rozróżniamy w renderze)
    }
  };

  const confirmDeleteTextile = (t) => {
    if (!isManager || !t) return;
    TextilesService.remove(t.id);
    refreshTextiles();
    setTextileDeleteStep1(null);
    setTextileDeleteStep2(null);
    setTextileDeleteText("");
  };

  // FIX 3.A — kasuje wbudowaną kategorię i przenosi pozycje wyposażenia z tą kategorią
  // do „Niestandardowe" we wszystkich apartamentach. Pożyczki trzymają nazwy pozycji
  // (nie kategorii), więc pozostają nietknięte.
  const deleteBuiltinRoom = (room) => {
    if (!isManager || !room) return;
    EquipmentRooms.remove(room.id);
    let movedItems = 0, touchedApts = 0;
    (apartments || []).forEach(a => {
      const eq = Storage.get(`apt_equip_${a.id}`);
      if (!Array.isArray(eq)) return;
      let changed = false;
      const next = eq.map(it => {
        if (it.cat === room.name) { changed = true; movedItems++; return { ...it, cat: "Niestandardowe" }; }
        return it;
      });
      if (changed) { Storage.set(`apt_equip_${a.id}`, next); touchedApts++; }
    });
    Audit.log("EQUIPMENT_DELETE_BUILTIN", currentUser, { item: room.name, movedItems, apartments: touchedApts });
    refreshRooms();
    setRoomDeleteStep1(null);
    setRoomDeleteStep2(null);
    setRoomDeleteText("");
  };

  // ── Kategorie pozycji ─────────────────────────────────────────────────────
  const [categories, setCategories] = useState(() => Categories.getAll());
  const [catForm, setCatForm] = useState({
    id: null, name: "", color: CATEGORY_COLORS[0], icon: "home", showInNav: true,
  });
  const [showCatForm, setShowCatForm] = useState(false);
  const [catError, setCatError] = useState("");

  const refreshCategories = () => {
    const list = Categories.getAll();
    setCategories(list);
    onCategoriesChange && onCategoriesChange(list);
  };

  const openAddCategory = () => {
    setCatForm({
      id: null, name: "",
      color: CATEGORY_COLORS[categories.length % CATEGORY_COLORS.length],
      icon: "home", showInNav: true,
    });
    setCatError("");
    setShowCatForm(true);
  };

  const openEditCategory = (cat) => {
    setCatForm({ ...cat });
    setCatError("");
    setShowCatForm(true);
  };

  const saveCategory = () => {
    if (!isManager) return;
    const name = (catForm.name || "").trim();
    if (!name) { setCatError("Nazwa jest wymagana"); return; }
    // Unikalność nazw (case-insensitive)
    const upper = name.toUpperCase();
    const clash = categories.find(c => c.name.toUpperCase() === upper && c.id !== catForm.id);
    if (clash) { setCatError("Kategoria o tej nazwie już istnieje"); return; }

    if (catForm.id) {
      Categories.update(catForm.id, {
        name: upper, color: catForm.color, icon: catForm.icon, showInNav: catForm.showInNav,
      });
    } else {
      Categories.add({
        name: upper, color: catForm.color, icon: catForm.icon, showInNav: catForm.showInNav,
      });
    }
    refreshCategories();
    setShowCatForm(false);
  };

  const deleteCategory = (cat) => {
    if (!isManager) return;
    const result = Categories.remove(cat.id, apartments);
    if (!result.ok) {
      setCatError(result.reason);
      setTimeout(() => setCatError(""), 3500);
      return;
    }
    refreshCategories();
  };

  // PAKIET 8a.4 — reorder kategorii widocznych w nawigacji
  const moveCategory = (id, dir) => {
    if (!isManager) return;
    const visible = categories.filter(c => c.showInNav);
    const idx = visible.findIndex(c => c.id === id);
    if (idx < 0) return;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= visible.length) return;
    const reorderedVisible = [...visible];
    [reorderedVisible[idx], reorderedVisible[newIdx]] = [reorderedVisible[newIdx], reorderedVisible[idx]];
    const nonVisible = categories.filter(c => !c.showInNav);
    const reordered = [
      ...reorderedVisible.map((c, i) => ({ ...c, order: i })),
      ...nonVisible.map((c, i) => ({ ...c, order: reorderedVisible.length + i })),
    ];
    Categories.save(reordered);
    refreshCategories();
  };

  const refresh = () => setSettings(Settings.getAll());

  const startEdit = (type) => {
    setEditingType(type);
    setDraft((settings.smsTemplates || {})[type] || DEFAULT_SMS_TEMPLATES[type] || "");
    setSaved(false);
  };

  const saveEdit = () => {
    if (!isManager) return;
    Settings.setGlobalTemplate(editingType, draft);
    refresh();
    setSaved(true);
    setTimeout(() => { setEditingType(null); setSaved(false); }, 800);
  };

  const resetToDefault = (type) => {
    if (!isManager) return;
    Settings.setGlobalTemplate(type, DEFAULT_SMS_TEMPLATES[type]);
    refresh();
    if (editingType === type) setDraft(DEFAULT_SMS_TEMPLATES[type]);
  };

  const clearOverride = (aptId) => {
    if (!isManager) return;
    Settings.removeOverride(aptId);
    refresh();
  };

  // Apartamenty z override
  const aptsWithOverride = apartments.filter(a => (settings.smsOverrides || {})[a.id]);

  return (
    <div>
      <div className="header">
        <h1>Ustawienia</h1>
      </div>

      {/* Zakładki ustawień */}
      <ScrollableTabs className="tabs">
        {[
          { id:"general",    label:"OGÓLNE" },
          { id:"mainview",   label:"WIDOK GŁÓWNY" },
          { id:"categories", label:`KATEGORIE (${categories.length})` },
          { id:"equipment",  label:"WYPOSAŻENIE" },
          { id:"textiles",   label:"TEKSTYLIA" },
          { id:"team",       label:"ZESPÓŁ" },
          { id:"formbuilder",label:"FORMULARZ" },
          { id:"sms",        label:"SZABLONY SMS" },
          { id:"api",        label:"API" },
        ].map(t => (
          <div key={t.id} className={`tab ${settingsTab === t.id ? "active" : ""}`}
            onClick={() => setSettingsTab(t.id)} style={{ whiteSpace:"nowrap", flexShrink:0 }}>
            {t.label}
          </div>
        ))}
      </ScrollableTabs>

      <div className="content">

        {/* ═══ OGÓLNE ═══ */}
        {settingsTab === "general" && (
          <div>
            <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:12 }}>
              Motyw aplikacji
            </div>
            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:"var(--radius)", padding:16, marginBottom:24 }}>
              <div style={{ display:"flex", alignItems:"center", gap:14 }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:600, marginBottom:4 }}>Tryb {theme === "dark" ? "ciemny" : "jasny"}</div>
                  <div style={{ fontSize:12, color:"var(--text2)" }}>
                    {theme === "dark"
                      ? "Ciemny motyw — mniej obciąża oczy wieczorem."
                      : "Jasny motyw — lepiej widoczny w słonecznym świetle."}
                  </div>
                </div>
                <button
                  onClick={onToggleTheme}
                  style={{
                    width:56, height:30, borderRadius:15,
                    background: theme === "dark" ? "var(--accent)" : "var(--border)",
                    border:"none", cursor:"pointer", position:"relative",
                    transition:"background 0.2s",
                  }}
                >
                  <div style={{
                    width:24, height:24, borderRadius:12,
                    background:"#fff", position:"absolute", top:3,
                    left: theme === "dark" ? 29 : 3,
                    transition:"left 0.2s",
                    boxShadow:"0 1px 3px rgba(0,0,0,0.3)",
                  }} />
                </button>
              </div>
            </div>

            <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:12 }}>
              Lista apartamentów
            </div>
            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:"var(--radius)", padding:16, marginBottom:24 }}>
              <div style={{ display:"flex", alignItems:"center", gap:14 }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:600, marginBottom:4 }}>Układ listy</div>
                  <div style={{ fontSize:12, color:"var(--text2)" }}>
                    {aptColumns === "single"
                      ? "Jedna kolumna — apartamenty jeden pod drugim."
                      : "Wiele kolumn — wypełnia szerokość ekranu (im wyższa rozdzielczość, tym więcej kolumn)."}
                  </div>
                </div>
                <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                  {[{ id:"multi", label:"Wiele" }, { id:"single", label:"Jedna" }].map(opt => (
                    <button key={opt.id}
                      onClick={() => onSetAptColumns(opt.id)}
                      style={{
                        padding:"8px 14px", borderRadius:10, fontSize:12, fontWeight:700, cursor:"pointer",
                        border:"1px solid var(--border)", transition:"all 0.15s",
                        background: aptColumns === opt.id ? "var(--accent)" : "var(--surface2)",
                        color: aptColumns === opt.id ? "#000" : "var(--text2)",
                      }}>
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:12 }}>
              Pozycja menu
            </div>
            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:"var(--radius)", padding:16, marginBottom:24 }}>
              <div style={{ display:"flex", alignItems:"center", gap:14 }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:600, marginBottom:4 }}>Menu na desktopie</div>
                  <div style={{ fontSize:12, color:"var(--text2)" }}>
                    {navPos === "top"
                      ? "Poziomy pasek u góry ekranu."
                      : "Panel boczny po lewej stronie."}
                    {" "}Na wąskim ekranie menu zawsze jest na dole.
                  </div>
                </div>
                <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                  {[{ id:"left", label:"Po lewej" }, { id:"top", label:"U góry" }].map(opt => (
                    <button key={opt.id}
                      onClick={() => onSetNavPos(opt.id)}
                      style={{
                        padding:"8px 14px", borderRadius:10, fontSize:12, fontWeight:700, cursor:"pointer",
                        border:"1px solid var(--border)", transition:"all 0.15s",
                        background: navPos === opt.id ? "var(--accent)" : "var(--surface2)",
                        color: navPos === opt.id ? "#000" : "var(--text2)",
                      }}>
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:12 }}>
              Informacje o aplikacji
            </div>
            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:"var(--radius)", padding:16 }}>
              <div style={{ marginBottom:8 }}>
                <VelarLogo size={28} withWordmark />
              </div>
              <div style={{ fontSize:12, color:"var(--text2)", lineHeight:1.6, marginTop:8 }}>
                Property Management Suite<br />
                velarflow.app
              </div>
              <div style={{ fontSize:11, color:"var(--text2)", marginTop:12, paddingTop:12, borderTop:"1px solid var(--border)" }}>
                Wersja aplikacji: 1.0 · React PWA
              </div>
            </div>

            {!isManager && (
              <div style={{ marginTop:16, padding:12, background:"rgba(245,158,11,0.08)", border:"1px solid rgba(245,158,11,0.25)", borderRadius:10, fontSize:12, color:"var(--yellow)" }}>
                🔒 Tylko manager może modyfikować ustawienia. Podgląd tylko do odczytu.
              </div>
            )}
          </div>
        )}

        {/* ═══ KATEGORIE POZYCJI ═══ */}
        {settingsTab === "categories" && (
          <div>
            <div className="settings-cat-head">
              <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase" }}>
                Kategorie pozycji ({categories.length})
              </div>
              {isManager && (
                <button className="btn btn-primary" style={{ padding:"6px 12px", fontSize:11 }} onClick={openAddCategory}>
                  + Dodaj kategorię
                </button>
              )}
            </div>
            <p style={{ fontSize:13, color:"var(--text2)", marginBottom:16, lineHeight:1.6 }}>
              Kategorie definiują rodzaje pozycji. Kategorie z opcją „Widoczne w nawigacji" pojawią się jako zakładki w menu.
            </p>

            {catError && (
              <div style={{ padding:"10px 12px", background:"rgba(239,68,68,0.12)", border:"1px solid rgba(239,68,68,0.3)", borderRadius:10, fontSize:13, color:"var(--red)", marginBottom:12, fontWeight:600 }}>
                {catError}
              </div>
            )}

            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:"var(--radius)", overflow:"hidden" }}>
              {categories.map(cat => {
                const usage = apartments.filter(a => a.status === cat.name).length;
                return (
                  <div key={cat.id} style={{ padding:"14px 16px", borderBottom:"1px solid var(--border)", display:"flex", alignItems:"center", gap:12 }}>
                    <div style={{ width:36, height:36, borderRadius:10, background:`${cat.color}22`, border:`1px solid ${cat.color}66`, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                      <Icon name={cat.icon || "home"} size={18} color={cat.color} />
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                        <span style={{ fontFamily:"var(--font-display)", fontSize:16, letterSpacing:"0.06em", color:cat.color }}>{cat.name}</span>
                        {cat.builtin && <span style={{ fontSize:9, fontWeight:700, letterSpacing:"0.08em", padding:"2px 6px", borderRadius:4, background:"rgba(59,130,246,0.12)", color:"var(--accent)" }}>WBUDOWANA</span>}
                        {!cat.builtin && <span style={{ fontSize:9, fontWeight:700, letterSpacing:"0.08em", padding:"2px 6px", borderRadius:4, background:"rgba(245,158,11,0.12)", color:"var(--yellow)" }}>WŁASNA</span>}
                        {cat.showInNav && <span style={{ fontSize:9, fontWeight:700, letterSpacing:"0.08em", padding:"2px 6px", borderRadius:4, background:"rgba(34,197,94,0.12)", color:"var(--green)" }}>W NAWIGACJI</span>}
                      </div>
                      <div style={{ fontSize:11, color:"var(--text2)", marginTop:2 }}>
                        {usage > 0 ? `Używana przez ${usage} ${usage === 1 ? "pozycję" : "pozycje"}` : "Nie używana"}
                      </div>
                    </div>
                    {isManager && (
                      <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                        <button onClick={() => openEditCategory(cat)} title="Edytuj" style={{ background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"6px 10px", cursor:"pointer", color:"var(--text)", fontSize:11, fontWeight:700 }}>✏</button>
                        <button onClick={() => deleteCategory(cat)} disabled={usage > 0} title={usage > 0 ? "Nie można usunąć" : "Usuń"} style={{ background:usage>0?"var(--surface2)":"rgba(239,68,68,0.12)", border:"1px solid var(--border)", borderRadius:8, padding:"6px 10px", cursor:usage>0?"not-allowed":"pointer", color:usage>0?"var(--text2)":"var(--red)", fontSize:11, fontWeight:700, opacity:usage>0?0.5:1 }}>🗑</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ═══ WYPOSAŻENIE — KATEGORIE POMIESZCZEŃ ═══ */}
        {settingsTab === "equipment" && (
          <div>
            <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:12 }}>
              Kategorie pomieszczeń wyposażenia
            </div>
            <p style={{ fontSize:13, color:"var(--text2)", marginBottom:16, lineHeight:1.6 }}>
              Definiuj pomieszczenia/kategorie widoczne w zakładce Wyposażenie pozycji.
              Pomieszczenia globalne są widoczne we wszystkich pozycjach. Możesz też przypisać pomieszczenie do konkretnej pozycji.
            </p>

            {/* Formularz dodawania */}
            {isManager && (
              <div style={{ display:"flex", gap:8, marginBottom:20, padding:12, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, flexWrap:"wrap", alignItems:"flex-end" }}>
                <div style={{ flex:"2 1 160px", minWidth:140 }}>
                  <div style={{ fontSize:10, color:"var(--text2)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:4 }}>Nazwa pomieszczenia</div>
                  <input
                    className="form-input"
                    value={newRoomName}
                    onChange={e => setNewRoomName(e.target.value)}
                    placeholder="np. Pralnia, Garderoba, Piwnica"
                    onKeyDown={e => { if (e.key === "Enter") addRoom(); }}
                  />
                </div>
                <div style={{ flex:"1 1 140px", minWidth:120 }}>
                  <div style={{ fontSize:10, color:"var(--text2)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:4 }}>Zasięg</div>
                  <select className="form-select" value={newRoomAptId} onChange={e => setNewRoomAptId(e.target.value)}>
                    <option value="">Globalny (wszystkie pozycje)</option>
                    {apartments.map(a => <option key={a.id} value={a.id}>Tylko: {a.name}</option>)}
                  </select>
                </div>
                <button
                  className="btn btn-primary"
                  style={{ padding:"10px 18px" }}
                  disabled={!newRoomName.trim()}
                  onClick={addRoom}
                >+ Dodaj</button>
              </div>
            )}

            {/* Globalne */}
            <div style={{ fontSize:10, color:"var(--green)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:8 }}>
              Globalne pomieszczenia ({eqRooms.filter(r => !r.aptId).length})
            </div>
            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:"var(--radius)", overflow:"hidden", marginBottom:20 }}>
              {(() => {
                const globals = eqRooms.filter(r => !r.aptId);
                return globals.map((room, idx) => (
                  <div key={room.id} style={{ padding:"10px 14px", borderBottom:"1px solid var(--border)", display:"flex", alignItems:"center", gap:10 }}>
                    {/* PAKIET 8a.3 — strzałki kolejności */}
                    <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                      <button onClick={() => moveRoom(room.id, -1)} disabled={idx === 0 || !isManager}
                        style={{ background:"none", border:"1px solid var(--border)", borderRadius:4, padding:"1px 6px", cursor:"pointer", color:"var(--text2)", fontSize:10, opacity:(idx===0||!isManager)?0.3:1 }}>▲</button>
                      <button onClick={() => moveRoom(room.id, 1)} disabled={idx === globals.length - 1 || !isManager}
                        style={{ background:"none", border:"1px solid var(--border)", borderRadius:4, padding:"1px 6px", cursor:"pointer", color:"var(--text2)", fontSize:10, opacity:(idx===globals.length-1||!isManager)?0.3:1 }}>▼</button>
                    </div>
                    <div style={{ flex:1 }}>
                      <span style={{ fontSize:14, fontWeight:600 }}>{room.name}</span>
                      {room.builtin && <span style={{ marginLeft:8, fontSize:9, fontWeight:700, letterSpacing:"0.08em", padding:"2px 6px", borderRadius:4, background:"rgba(59,130,246,0.12)", color:"var(--accent)" }}>WBUDOWANA</span>}
                    </div>
                    {/* PAKIET 8a.3 — edycja nazwy */}
                    {isManager && (
                      <button onClick={() => setEditingRoom({ ...room })} title="Edytuj nazwę"
                        style={{ background:"none", border:"1px solid var(--border)", borderRadius:6, padding:"4px 8px", cursor:"pointer", color:"var(--text)", fontSize:12 }}>✏</button>
                    )}
                    {isManager && !room.builtin && (
                      <button onClick={() => deleteRoom(room.id)} style={{ background:"rgba(239,68,68,0.12)", border:"none", borderRadius:8, padding:"6px 10px", cursor:"pointer", color:"var(--red)", fontSize:11, fontWeight:700 }}>🗑</button>
                    )}
                    {/* FIX 3.A — wbudowane też można usunąć (tylko manager), ale dopiero po podwójnym potwierdzeniu; mocniejszy czerwony */}
                    {isManager && room.builtin && (
                      <button onClick={() => { setRoomDeleteText(""); setRoomDeleteStep1(room); }} title="Usuń wbudowaną kategorię (wymaga podwójnego potwierdzenia)" style={{ background:"var(--red)", border:"none", borderRadius:8, padding:"6px 12px", cursor:"pointer", color:"#fff", fontSize:11, fontWeight:700 }}>🗑 Usuń</button>
                    )}
                  </div>
                ));
              })()}
            </div>

            {/* Per-apt */}
            {(() => {
              const perApt = eqRooms.filter(r => r.aptId);
              if (perApt.length === 0) return (
                <p style={{ fontSize:13, color:"var(--text2)", padding:"8px 0" }}>
                  Brak pomieszczeń przypisanych do konkretnych pozycji. Dodaj powyżej z wybranym zasięgiem.
                </p>
              );
              // Grupuj per apt
              const grouped = {};
              perApt.forEach(r => {
                const apt = apartments.find(a => a.id === r.aptId);
                const key = r.aptId;
                if (!grouped[key]) grouped[key] = { apt, rooms: [] };
                grouped[key].rooms.push(r);
              });
              return (
                <>
                  <div style={{ fontSize:10, color:"var(--yellow)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:8 }}>
                    Pomieszczenia per pozycja ({perApt.length})
                  </div>
                  {Object.values(grouped).map(({ apt: a, rooms }) => (
                    <div key={a && a.id || "?"} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:"var(--radius)", overflow:"hidden", marginBottom:10 }}>
                      <div style={{ padding:"10px 16px", background:"var(--surface2)", fontSize:12, fontWeight:700, color:"var(--text2)" }}>
                        {a && a.name || "Nieznana pozycja"}
                      </div>
                      {rooms.map(room => (
                        <div key={room.id} style={{ padding:"10px 16px", borderBottom:"1px solid var(--border)", display:"flex", alignItems:"center", gap:10 }}>
                          <span style={{ flex:1, fontSize:14 }}>{room.name}</span>
                          {isManager && (
                            <button onClick={() => deleteRoom(room.id)} style={{ background:"rgba(239,68,68,0.12)", border:"none", borderRadius:8, padding:"4px 8px", cursor:"pointer", color:"var(--red)", fontSize:10, fontWeight:700 }}>🗑</button>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </>
              );
            })()}
          </div>
        )}

        {/* FIX 3.A — Krok 1: ostrzeżenie przed usunięciem wbudowanej kategorii */}
        {roomDeleteStep1 && (
          <ConfirmModal
            open
            variant="danger"
            title="Czy na pewno chcesz usunąć wbudowane wyposażenie?"
            message={<>
              <strong style={{ color:"var(--text)" }}>{roomDeleteStep1.name}</strong> jest pozycją wbudowaną — była częścią domyślnej konfiguracji aplikacji. Usunięcie spowoduje, że:<br /><br />
              • Kategoria zniknie z list wyposażenia wszystkich apartamentów, które jej używają<br />
              • Pozycje przypisane do tej kategorii zostaną przeniesione do „Niestandardowe"<br />
              • Operacja jest nieodwracalna (nie ma „Cofnij")<br /><br />
              Czy na pewno chcesz kontynuować?
            </>}
            confirmLabel="Tak, kontynuuj"
            cancelLabel="Anuluj"
            onClose={() => setRoomDeleteStep1(null)}
            onConfirm={() => { const r = roomDeleteStep1; setRoomDeleteStep1(null); setRoomDeleteText(""); setRoomDeleteStep2(r); }}
          />
        )}

        {/* FIX 3.A — Krok 2: ostateczne potwierdzenie z przepisaniem nazwy (case-sensitive) */}
        {roomDeleteStep2 && (
          <FloatingModal open onClose={() => { setRoomDeleteStep2(null); setRoomDeleteText(""); }} title="Ostateczne potwierdzenie" size="sm">
            <p style={{ fontSize:14, lineHeight:1.6, marginBottom:12 }}>
              Wpisz nazwę elementu poniżej, żeby potwierdzić usunięcie:<br />
              <strong style={{ color:"var(--red)" }}>{roomDeleteStep2.name}</strong>
            </p>
            <input
              className="form-input"
              autoFocus
              value={roomDeleteText}
              onChange={e => setRoomDeleteText(e.target.value)}
              placeholder="Wpisz dokładną nazwę…"
              style={{ width:"100%", boxSizing:"border-box", marginBottom:14 }}
              onKeyDown={e => { if (e.key === "Enter" && roomDeleteText === roomDeleteStep2.name) deleteBuiltinRoom(roomDeleteStep2); }}
            />
            <div className="btn-row" style={{ display:"flex", gap:10 }}>
              <button className="btn btn-ghost" style={{ flex:1 }} onClick={() => { setRoomDeleteStep2(null); setRoomDeleteText(""); }}>Anuluj</button>
              <button
                className="btn"
                disabled={roomDeleteText !== roomDeleteStep2.name}
                onClick={() => deleteBuiltinRoom(roomDeleteStep2)}
                style={{ flex:1, border:"none", fontWeight:700, background: roomDeleteText === roomDeleteStep2.name ? "var(--red)" : "var(--surface2)", color: roomDeleteText === roomDeleteStep2.name ? "#fff" : "var(--text2)", cursor: roomDeleteText === roomDeleteStep2.name ? "pointer" : "not-allowed" }}
              >Usuń definitywnie</button>
            </div>
          </FloatingModal>
        )}

        {/* PAKIET 8a.3 — Modal edycji nazwy pomieszczenia */}
        {editingRoom && (
          <FloatingModal open onClose={() => setEditingRoom(null)} title="Edytuj pomieszczenie" size="sm">
            <div className="form-group">
              <label className="form-label">Nazwa pomieszczenia *</label>
              <input
                className="form-input"
                value={editingRoom.name || ""}
                onChange={e => setEditingRoom(r => ({ ...r, name: e.target.value }))}
                placeholder="np. Salon, Sypialnia, Łazienka"
                onKeyDown={e => { if (e.key === "Enter") saveRoomEdit(); }}
                style={{ width:"100%", boxSizing:"border-box" }}
              />
            </div>
            <div className="btn-row" style={{ display:"flex", gap:10 }}>
              <button className="btn btn-ghost" style={{ flex:1 }} onClick={() => setEditingRoom(null)}>Anuluj</button>
              <button className="btn btn-primary" style={{ flex:1 }} disabled={!editingRoom.name || !editingRoom.name.trim()} onClick={saveRoomEdit}>Zapisz</button>
            </div>
          </FloatingModal>
        )}

        {/* PAKIET 8a.1 — Modal dodawania/edycji tekstyliów */}
        {editingTextile && (
          <FloatingModal open onClose={() => setEditingTextile(null)} title={editingTextile.create ? "Nowa pozycja tekstyliów" : `Edytuj: ${editingTextile.name || ""}`} size="sm">
            <div className="form-group">
              <label className="form-label">Nazwa *</label>
              <input
                className="form-input"
                value={editingTextile.name || ""}
                onChange={e => setEditingTextile(t => ({ ...t, name: e.target.value }))}
                placeholder="np. Kołdra, Poduszka, Ręcznik duży"
                style={{ width:"100%", boxSizing:"border-box" }}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Rozmiar</label>
              <input
                className="form-input"
                value={editingTextile.size || ""}
                onChange={e => setEditingTextile(t => ({ ...t, size: e.target.value }))}
                placeholder="np. 160/200, 50/70"
                onKeyDown={e => { if (e.key === "Enter") saveTextileEdit(); }}
                style={{ width:"100%", boxSizing:"border-box" }}
              />
            </div>
            <div className="btn-row" style={{ display:"flex", gap:10 }}>
              <button className="btn btn-ghost" style={{ flex:1 }} onClick={() => setEditingTextile(null)}>Anuluj</button>
              <button className="btn btn-primary" style={{ flex:1 }} disabled={!editingTextile.name || !editingTextile.name.trim()} onClick={saveTextileEdit}>Zapisz</button>
            </div>
          </FloatingModal>
        )}

        {/* PAKIET 8a.1 — Usuwanie tekstyliów: zwykłe = jeden confirm, wbudowane = double-confirm z przepisaniem nazwy */}
        {textileDeleteStep1 && !textileDeleteStep1.builtin && (
          <ConfirmModal
            open
            variant="danger"
            title="Usunąć tę pozycję?"
            message={<><strong style={{ color:"var(--text)" }}>{textileDeleteStep1.name}</strong> zniknie z listy globalnych tekstyliów. Istniejące apartamenty zachowają już dodane pozycje.</>}
            confirmLabel="Tak, usuń"
            cancelLabel="Anuluj"
            onClose={() => setTextileDeleteStep1(null)}
            onConfirm={() => confirmDeleteTextile(textileDeleteStep1)}
          />
        )}
        {textileDeleteStep1 && textileDeleteStep1.builtin && (
          <ConfirmModal
            open
            variant="danger"
            title="Czy na pewno chcesz usunąć wbudowaną pozycję?"
            message={<>
              <strong style={{ color:"var(--text)" }}>{textileDeleteStep1.name}</strong> jest pozycją wbudowaną — była częścią domyślnej konfiguracji aplikacji.<br /><br />
              Po usunięciu nie pojawi się przy tworzeniu wyposażenia nowych apartamentów ani jako podpowiedź w zamówieniach. Operacja jest nieodwracalna.<br /><br />
              Czy na pewno chcesz kontynuować?
            </>}
            confirmLabel="Tak, kontynuuj"
            cancelLabel="Anuluj"
            onClose={() => setTextileDeleteStep1(null)}
            onConfirm={() => { const t = textileDeleteStep1; setTextileDeleteStep1(null); setTextileDeleteText(""); setTextileDeleteStep2(t); }}
          />
        )}
        {textileDeleteStep2 && (
          <FloatingModal open onClose={() => { setTextileDeleteStep2(null); setTextileDeleteText(""); }} title="Ostateczne potwierdzenie" size="sm">
            <p style={{ fontSize:14, lineHeight:1.6, marginBottom:12 }}>
              Wpisz nazwę pozycji poniżej, żeby potwierdzić usunięcie:<br />
              <strong style={{ color:"var(--red)" }}>{textileDeleteStep2.name}</strong>
            </p>
            <input
              className="form-input"
              autoFocus
              value={textileDeleteText}
              onChange={e => setTextileDeleteText(e.target.value)}
              placeholder="Wpisz dokładną nazwę…"
              style={{ width:"100%", boxSizing:"border-box", marginBottom:14 }}
              onKeyDown={e => { if (e.key === "Enter" && textileDeleteText === textileDeleteStep2.name) confirmDeleteTextile(textileDeleteStep2); }}
            />
            <div className="btn-row" style={{ display:"flex", gap:10 }}>
              <button className="btn btn-ghost" style={{ flex:1 }} onClick={() => { setTextileDeleteStep2(null); setTextileDeleteText(""); }}>Anuluj</button>
              <button
                className="btn"
                disabled={textileDeleteText !== textileDeleteStep2.name}
                onClick={() => confirmDeleteTextile(textileDeleteStep2)}
                style={{ flex:1, border:"none", fontWeight:700, background: textileDeleteText === textileDeleteStep2.name ? "var(--red)" : "var(--surface2)", color: textileDeleteText === textileDeleteStep2.name ? "#fff" : "var(--text2)", cursor: textileDeleteText === textileDeleteStep2.name ? "pointer" : "not-allowed" }}
              >Usuń definitywnie</button>
            </div>
          </FloatingModal>
        )}

        {/* ═══ ZESPÓŁ — konfiguracja osób dowodzących ═══ */}
        {settingsTab === "team" && (
          <div>
            <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:12 }}>
              Osoby dowodzące sprzątaniem
            </div>
            <p style={{ fontSize:13, color:"var(--text2)", marginBottom:16, lineHeight:1.6 }}>
              Lista osób, które mogą być wybrane jako dowodzący sesją sprzątania w widoku Zespołu Sprzątającego.
            </p>

            {isManager && (
              <div style={{ marginBottom:16 }}>
                <input
                  className="form-input"
                  style={{ width:"100%", marginBottom:8, boxSizing:"border-box" }}
                  value={newLeader}
                  onChange={e => setNewLeader(e.target.value)}
                  placeholder="Imię osoby dowodzącej..."
                  onKeyDown={e => { if (e.key === "Enter") addLeader(); }}
                />
                <div style={{ display:"flex", justifyContent:"flex-end" }}>
                  <button className="btn btn-primary" style={{ padding:"8px 20px", fontSize:12 }} disabled={!newLeader.trim()} onClick={addLeader}>+ Dodaj osobę</button>
                </div>
              </div>
            )}

            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:"var(--radius)", overflow:"hidden" }}>
              {leaders.length === 0 ? (
                <div style={{ padding:"20px 16px", textAlign:"center", color:"var(--text2)", fontSize:14 }}>Brak osób. Dodaj pierwszą powyżej.</div>
              ) : leaders.map((name, idx) => (
                <div key={idx} style={{ padding:"12px 16px", borderBottom:"1px solid var(--border)", display:"flex", alignItems:"center", gap:10 }}>
                  <div className="avatar" style={{ width:32, height:32, fontSize:13 }}>{name[0]}</div>
                  <span style={{ flex:1, fontSize:14, fontWeight:600 }}>{name}</span>
                  {isManager && (
                    <button onClick={() => removeLeader(idx)} style={{ background:"rgba(239,68,68,0.12)", border:"none", borderRadius:8, padding:"6px 10px", cursor:"pointer", color:"var(--red)", fontSize:11, fontWeight:700 }}>🗑</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ═══ FORMULARZ — konfiguracja pól ═══ */}
        {settingsTab === "formbuilder" && (() => {
          const visibleSorted = schemaFields.filter(f => f.visible).sort((a,b) => a.order - b.order);
          const catLabel = (FORM_CATEGORIES.find(c => c.key === formCat) || {}).label || "";
          // PAKIET 8b — grupowanie po user-defined groupOrder z fallbackiem orphan
          const fieldsByGroup = {};
          schemaFields.forEach(f => {
            const g = f.group || "Inne";
            if (!fieldsByGroup[g]) fieldsByGroup[g] = [];
            fieldsByGroup[g].push(f);
          });
          const knownGroups = new Set(groupOrder);
          const orphanFields = schemaFields.filter(f => !knownGroups.has(f.group || "Inne"));
          return (
          <div>
            <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:12 }}>
              Konfiguracja formularza — {catLabel}
            </div>

            {/* Wybór kategorii formularza */}
            <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:14 }}>
              {FORM_CATEGORIES.map(c => (
                <button key={c.key} onClick={() => changeFormCat(c.key)}
                  className={`btn ${formCat === c.key ? "btn-primary" : ""}`}
                  style={{ padding:"6px 16px", fontSize:13 }}>
                  {c.label}
                </button>
              ))}
            </div>

            <p style={{ fontSize:13, color:"var(--text2)", marginBottom:16, lineHeight:1.6 }}>
              Edytuj pola formularza: kliknij ⚙ aby zmienić etykietę, typ, opcje i wartości; przełącz „wymagane" (✱) i „widoczność" (👁); zmień kolejność strzałkami ▲▼. Wbudowanych pól nie można usunąć — tylko ukryć.
            </p>

            {/* PAKIET 8b — sekcja zarządzania grupami */}
            <div style={{ marginBottom:20, padding:12, background:"var(--surface)", borderRadius:8, border:"1px solid var(--border)" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                <div style={{ fontSize:13, fontWeight:600 }}>Grupy formularza ({groupOrder.length})</div>
                {isManager && (
                  <button className="btn btn-primary" style={{ padding:"4px 12px", fontSize:12 }}
                    onClick={() => { setNewGroupName(""); setNewGroupModal(true); }}>+ Nowa grupa</button>
                )}
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                {groupOrder.length === 0 && (
                  <div style={{ fontSize:12, color:"var(--text2)", padding:"6px 0" }}>
                    Brak grup. Dodaj pierwszą grupę powyżej.
                  </div>
                )}
                {groupOrder.map((groupName, idx) => {
                  const fieldCount = (fieldsByGroup[groupName] || []).length;
                  return (
                    <div key={groupName} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 10px", background:"var(--surface2)", borderRadius:6 }}>
                      <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                        <button onClick={() => moveGroupUp(groupName)} disabled={idx === 0 || !isManager}
                          style={{ background:"none", border:"1px solid var(--border)", borderRadius:4, padding:"1px 6px", cursor:"pointer", color:"var(--text2)", fontSize:10, opacity:(idx===0||!isManager)?0.3:1 }}>▲</button>
                        <button onClick={() => moveGroupDown(groupName)} disabled={idx === groupOrder.length - 1 || !isManager}
                          style={{ background:"none", border:"1px solid var(--border)", borderRadius:4, padding:"1px 6px", cursor:"pointer", color:"var(--text2)", fontSize:10, opacity:(idx===groupOrder.length-1||!isManager)?0.3:1 }}>▼</button>
                      </div>
                      <div style={{ flex:1, fontSize:13, fontWeight:600 }}>{groupName}</div>
                      <span style={{ fontSize:11, color:"var(--text2)" }}>{fieldCount} {plForm(fieldCount, "pole", "pola", "pól")}</span>
                      {isManager && (
                        <>
                          <button onClick={() => setEditGroupModal({ oldName: groupName, newName: groupName })} title="Zmień nazwę"
                            style={{ background:"none", border:"1px solid var(--border)", borderRadius:6, padding:"4px 8px", cursor:"pointer", color:"var(--text)", fontSize:12 }}>✏</button>
                          <button onClick={() => setDeleteGroupConfirm(groupName)} title="Usuń grupę"
                            disabled={fieldCount > 0 && groupOrder.length === 1}
                            style={{ background:"rgba(239,68,68,0.12)", border:"none", borderRadius:6, padding:"4px 8px", cursor:(fieldCount>0 && groupOrder.length===1)?"not-allowed":"pointer", color:"var(--red)", fontSize:11, fontWeight:700, opacity:(fieldCount>0 && groupOrder.length===1)?0.5:1 }}>🗑</button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{ display:"flex", gap:24, flexWrap:"wrap", alignItems:"flex-start" }}>
              {/* ── LEWA: edycja pól ── */}
              <div style={{ flex:"1 1 380px", minWidth:300 }}>
                {isManager && (
                  <button className="btn btn-primary" style={{ width:"100%", marginBottom:14 }} onClick={() => setFieldModal({ create:true })}>+ Dodaj własne pole</button>
                )}

                {groupOrder.map(groupName => {
                  const fields = fieldsByGroup[groupName];
                  if (!fields || fields.length === 0) return null;
                  return (
                  <div key={groupName} style={{ marginBottom:16 }}>
                    <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:6, paddingBottom:4, borderBottom:"1px solid var(--border)" }}>
                      {groupName} ({fields.length})
                    </div>
                    {fields.map((f, idx) => (
                      <div key={f.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 0", borderBottom:"1px solid var(--border)" }}>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:13, fontWeight:600, opacity:f.visible?1:0.5 }}>{f.label}</div>
                          <div style={{ fontSize:10, color:"var(--text2)", display:"flex", gap:8, flexWrap:"wrap" }}>
                            <span>{f.type}</span>
                            {f.required && <span style={{ color:"var(--red)" }}>wymagane</span>}
                            {!f.visible && <span>ukryte</span>}
                            {f.custom && <span style={{ color:"var(--yellow)" }}>własne</span>}
                          </div>
                        </div>

                        {isManager ? (
                          <>
                            <label title="Wymagane" style={{ display:"flex", alignItems:"center", gap:3, cursor:"pointer", fontSize:11, color:"var(--text2)" }}>
                              <input type="checkbox" checked={!!f.required} onChange={() => toggleFieldRequired(f.id)} style={{ width:14, height:14 }} />✱
                            </label>
                            <button onClick={() => toggleFieldVisibility(f.id)}
                              style={{ background:"none", border:"none", cursor:"pointer", fontSize:15, padding:0, width:26, textAlign:"center" }}
                              title={f.visible ? "Ukryj w formularzu" : "Pokaż w formularzu"}>
                              {f.visible ? "👁" : "🚫"}
                            </button>
                            <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                              <button onClick={() => moveFieldInGroup(fields, idx, "up")} disabled={idx === 0}
                                style={{ background:"none", border:"1px solid var(--border)", borderRadius:4, padding:"1px 6px", cursor:"pointer", color:"var(--text2)", fontSize:10, opacity:idx===0?0.3:1 }}>▲</button>
                              <button onClick={() => moveFieldInGroup(fields, idx, "down")} disabled={idx === fields.length - 1}
                                style={{ background:"none", border:"1px solid var(--border)", borderRadius:4, padding:"1px 6px", cursor:"pointer", color:"var(--text2)", fontSize:10, opacity:idx===fields.length-1?0.3:1 }}>▼</button>
                            </div>
                            <button onClick={() => setFieldModal({ field:f })} title="Edytuj szczegóły pola"
                              style={{ background:"none", border:"1px solid var(--border)", borderRadius:6, padding:"4px 8px", cursor:"pointer", color:"var(--text)", fontSize:12 }}>⚙</button>
                            {f.custom && (
                              <button onClick={() => setDeleteFieldId(f.id)} title="Usuń pole"
                                style={{ background:"rgba(239,68,68,0.12)", border:"none", borderRadius:6, padding:"4px 8px", cursor:"pointer", color:"var(--red)", fontSize:11, fontWeight:700 }}>🗑</button>
                            )}
                          </>
                        ) : (
                          <span style={{ fontSize:14 }}>{f.visible ? "👁" : "🚫"}</span>
                        )}
                      </div>
                    ))}
                  </div>
                  );
                })}

                {/* PAKIET 8b — pola w grupach spoza groupOrder (fallback) */}
                {orphanFields.length > 0 && (
                  <div style={{ marginBottom:16 }}>
                    <div style={{ fontSize:10, color:"var(--yellow)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:6, paddingBottom:4, borderBottom:"1px solid var(--border)" }}>
                      Inne / bez grupy ({orphanFields.length})
                    </div>
                    {orphanFields.map(f => (
                      <div key={f.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 0", borderBottom:"1px solid var(--border)" }}>
                        <div style={{ flex:1, minWidth:0 }}>
                          <div style={{ fontSize:13, fontWeight:600, opacity:f.visible?1:0.5 }}>{f.label}</div>
                          <div style={{ fontSize:10, color:"var(--text2)", display:"flex", gap:8, flexWrap:"wrap" }}>
                            <span>{f.type}</span>
                            {!f.visible && <span>ukryte</span>}
                            <span style={{ color:"var(--yellow)" }}>grupa: {f.group || "—"}</span>
                          </div>
                        </div>
                        {isManager && (
                          <button onClick={() => setFieldModal({ field:f })} title="Edytuj pole"
                            style={{ background:"none", border:"1px solid var(--border)", borderRadius:6, padding:"4px 8px", cursor:"pointer", color:"var(--text)", fontSize:12 }}>⚙</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {isManager && (
                  <button className="btn" style={{ marginTop:4 }} onClick={() => setShowSchemaReset(true)}>↺ Reset do domyślnych</button>
                )}
              </div>

              {/* ── PRAWA: podgląd ── */}
              <div style={{ flex:"1 1 300px", minWidth:280 }}>
                <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:10 }}>Podgląd formularza</div>
                <div style={{ padding:16, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:12 }}>
                  <FormPreview fields={visibleSorted} />
                </div>
              </div>
            </div>
          </div>
          );
        })()}

        {/* ═══ PAKIET 8a.1 — TEKSTYLIA (globalna lista edytowalna) ═══ */}
        {settingsTab === "textiles" && (
          <div>
            <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:12 }}>
              Standardowe tekstylia
            </div>
            <p style={{ fontSize:13, color:"var(--text2)", marginBottom:16, lineHeight:1.6 }}>
              Lista bazowych elementów tekstyliów używana przy tworzeniu wyposażenia nowych apartamentów oraz w zamówieniach.
              Możesz edytować nazwy/rozmiary, dodawać własne pozycje i usuwać niepotrzebne.
            </p>

            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:"var(--radius)", overflow:"hidden", marginBottom:14 }}>
              {textiles.map((t, idx) => (
                <div key={t.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 14px", borderBottom:"1px solid var(--border)" }}>
                  <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                    <button onClick={() => moveTextile(t.id, -1)} disabled={idx === 0 || !isManager}
                      style={{ background:"none", border:"1px solid var(--border)", borderRadius:4, padding:"1px 6px", cursor:"pointer", color:"var(--text2)", fontSize:10, opacity:(idx===0||!isManager)?0.3:1 }}>▲</button>
                    <button onClick={() => moveTextile(t.id, 1)} disabled={idx === textiles.length - 1 || !isManager}
                      style={{ background:"none", border:"1px solid var(--border)", borderRadius:4, padding:"1px 6px", cursor:"pointer", color:"var(--text2)", fontSize:10, opacity:(idx===textiles.length-1||!isManager)?0.3:1 }}>▼</button>
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:14, fontWeight:600 }}>{t.name}</div>
                    <div style={{ fontSize:11, color:"var(--text2)", marginTop:2 }}>Rozmiar: {t.size || "—"}</div>
                  </div>
                  {t.builtin
                    ? <span style={{ fontSize:9, fontWeight:700, letterSpacing:"0.08em", padding:"2px 6px", borderRadius:4, background:"rgba(59,130,246,0.12)", color:"var(--accent)" }}>WBUDOWANE</span>
                    : <span style={{ fontSize:9, fontWeight:700, letterSpacing:"0.08em", padding:"2px 6px", borderRadius:4, background:"rgba(234,179,8,0.12)", color:"var(--yellow)" }}>WŁASNE</span>}
                  {isManager && (
                    <>
                      <button onClick={() => setEditingTextile({ ...t })} title="Edytuj"
                        style={{ background:"none", border:"1px solid var(--border)", borderRadius:6, padding:"4px 8px", cursor:"pointer", color:"var(--text)", fontSize:12 }}>✏</button>
                      <button onClick={() => handleDeleteTextile(t)} title={t.builtin ? "Usuń wbudowane (wymaga podwójnego potwierdzenia)" : "Usuń"}
                        style={{ background: t.builtin ? "var(--red)" : "rgba(239,68,68,0.12)", border:"none", borderRadius:8, padding:"4px 10px", cursor:"pointer", color: t.builtin ? "#fff" : "var(--red)", fontSize:11, fontWeight:700 }}>🗑</button>
                    </>
                  )}
                </div>
              ))}
            </div>

            {isManager && (
              <button className="btn btn-primary" onClick={() => setEditingTextile({ create:true, name:"", size:"" })}>+ Dodaj tekstylia</button>
            )}
          </div>
        )}

        {/* ═══ PAKIET 8a.4 — WIDOK GŁÓWNY (kolejność kategorii w sidebar) ═══ */}
        {settingsTab === "mainview" && (
          <div>
            <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:12 }}>
              Kolejność kategorii w menu
            </div>
            <p style={{ fontSize:13, color:"var(--text2)", marginBottom:16, lineHeight:1.6 }}>
              Ułóż kategorie w preferowanej kolejności. Zmiany widoczne natychmiast w menu po lewej (lub na górze).
            </p>

            <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:"var(--radius)", overflow:"hidden" }}>
              {categories.filter(c => c.showInNav).map((cat, idx, arr) => (
                <div key={cat.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 14px", borderBottom:"1px solid var(--border)" }}>
                  <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                    <button onClick={() => moveCategory(cat.id, -1)} disabled={idx === 0 || !isManager}
                      style={{ background:"none", border:"1px solid var(--border)", borderRadius:4, padding:"1px 6px", cursor:"pointer", color:"var(--text2)", fontSize:10, opacity:(idx===0||!isManager)?0.3:1 }}>▲</button>
                    <button onClick={() => moveCategory(cat.id, 1)} disabled={idx === arr.length - 1 || !isManager}
                      style={{ background:"none", border:"1px solid var(--border)", borderRadius:4, padding:"1px 6px", cursor:"pointer", color:"var(--text2)", fontSize:10, opacity:(idx===arr.length-1||!isManager)?0.3:1 }}>▼</button>
                  </div>
                  {cat.icon && <Icon name={cat.icon} size={18} color={cat.color} />}
                  <div style={{ flex:1, minWidth:0, fontWeight:600 }}>{cat.name}</div>
                  <div style={{ fontSize:11, color:"var(--text2)" }}>
                    {apartments.filter(a => a.status === cat.name).length} apt.
                  </div>
                </div>
              ))}
              {categories.filter(c => c.showInNav).length === 0 && (
                <div style={{ padding:14, fontSize:13, color:"var(--text2)" }}>
                  Brak kategorii widocznych w nawigacji. Włącz „Pokaż w menu" w zakładce KATEGORIE.
                </div>
              )}
            </div>

            {categories.filter(c => !c.showInNav).length > 0 && (
              <p style={{ fontSize:12, color:"var(--text2)", marginTop:12 }}>
                ℹ️ Kategorie ukryte w nawigacji ({categories.filter(c => !c.showInNav).length}) nie pojawiają się na powyższej liście. Edytuj je w zakładce KATEGORIE aby je pokazać.
              </p>
            )}
          </div>
        )}

        {/* ═══ PAKIET 8a.2 — API (integracje zewnętrzne) ═══ */}
        {settingsTab === "api" && (
          <div>
            <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:12 }}>
              Integracje API
            </div>
            <p style={{ fontSize:13, color:"var(--text2)", marginBottom:20, lineHeight:1.6 }}>
              Konfiguracja zewnętrznych usług i synchronizacji.
            </p>

            {/* KW Hotel — przeniesione z nawigacji */}
            <div style={{ border:"1px solid var(--border)", borderRadius:12, padding:16, marginBottom:16, background:"var(--surface)" }}>
              <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:14, flexWrap:"wrap" }}>
                <Icon name="building" size={20} />
                <div style={{ flex:"1 1 200px", minWidth:0 }}>
                  <div style={{ fontWeight:600, fontSize:15, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>KW Hotel</div>
                  <div style={{ fontSize:12, color:"var(--text2)", marginTop:2 }}>Synchronizacja rezerwacji i statusów</div>
                </div>
                <button
                  className="btn btn-primary"
                  onClick={() => onOpenKw && onOpenKw()}
                  style={{ width:"auto", flex:"0 0 auto", padding:"8px 16px", fontSize:13, whiteSpace:"nowrap" }}
                >Otwórz panel KW</button>
              </div>
              <div style={{ fontSize:12, color:"var(--text2)", lineHeight:1.5 }}>
                Konfiguracja loginu KW dla każdego właściciela znajduje się w sekcji <strong>Właściciele</strong>.
              </div>
            </div>

            <div style={{ fontSize:12, color:"var(--text2)", marginTop:24, textAlign:"center", padding:20, border:"1px dashed var(--border)", borderRadius:8 }}>
              Wkrótce: więcej integracji (Booking.com, Airbnb)
            </div>
          </div>
        )}

        {/* ═══ SZABLONY SMS ═══ */}
        {settingsTab === "sms" && (
          <div>
            <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:12 }}>
              Szablony SMS
            </div>
            <p style={{ fontSize:13, color:"var(--text2)", marginBottom:16, lineHeight:1.6 }}>
              Dla każdej kategorii możesz ustawić własny szablon SMS. Nadpisanie indywidualne w widoku pozycji → zakładka SMS.
            </p>

            {categories.map(cat => {
              const tpl = (settings.smsTemplates || {})[cat.name] || DEFAULT_SMS_TEMPLATES[cat.name];
              return (
                <TemplateCard key={cat.id} type={cat.name} color={cat.color}
                  isEditing={editingType === cat.name}
                  template={tpl}
                  isDefault={tpl === DEFAULT_SMS_TEMPLATES[cat.name]}
                  isManager={isManager}
                  draft={draft} setDraft={setDraft} saved={saved}
                  onStartEdit={() => startEdit(cat.name)}
                  onSave={saveEdit}
                  onReset={() => resetToDefault(cat.name)}
                  onCancel={() => setEditingType(null)}
                />
              );
            })}

            <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginTop:24, marginBottom:12 }}>
              Apartamenty z własnym szablonem ({aptsWithOverride.length})
            </div>
            {aptsWithOverride.length === 0 ? (
              <p style={{ fontSize:13, color:"var(--text2)", padding:"12px 0" }}>
                Żaden apartament nie ma nadpisanego szablonu.
              </p>
            ) : (
              <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:"var(--radius)", overflow:"hidden" }}>
                {aptsWithOverride.map(a => (
                  <div key={a.id} style={{ padding:"12px 14px", borderBottom:"1px solid var(--border)", display:"flex", alignItems:"center", gap:10 }}>
                    <div style={{ flex:1 }}>
                      <div style={{ fontFamily:"var(--font-display)", fontSize:16, letterSpacing:"0.06em" }}>{a.name}</div>
                      <div style={{ fontSize:11, color:"var(--text2)", marginTop:2 }}>Nadpisuje szablon {a.status}</div>
                    </div>
                    {isManager && (
                      <button onClick={() => clearOverride(a.id)} style={{ background:"rgba(239,68,68,0.12)", color:"var(--red)", border:"none", borderRadius:8, padding:"6px 12px", fontSize:11, fontWeight:700, letterSpacing:"0.06em", cursor:"pointer" }}>↺ Przywróć globalny</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      </div>

      {/* ═══ MODAL: Formularz kategorii ═══ */}
      {showCatForm && (
        <FloatingModal open onClose={() => setShowCatForm(false)} title={catForm.id ? "Edytuj kategorię" : "Nowa kategoria"}>

            <div className="form-group">
              <label className="form-label">Nazwa kategorii *</label>
              <input
                className="form-input"
                value={catForm.name}
                onChange={e => setCatForm(f => ({ ...f, name: e.target.value }))}
                placeholder="np. CAMPING, DOMKI, SPRZĄTANIE"
                style={{ textTransform: "uppercase" }}
              />
              <div style={{ fontSize:11, color:"var(--text2)", marginTop:4 }}>
                Nazwa zostanie automatycznie zmieniona na wielkie litery.
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Kolor</label>
              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                {CATEGORY_COLORS.map(c => (
                  <button
                    key={c}
                    onClick={() => setCatForm(f => ({ ...f, color: c }))}
                    style={{
                      width:32, height:32, borderRadius:8,
                      background:c,
                      border: catForm.color === c ? "3px solid var(--text)" : "2px solid var(--border)",
                      cursor:"pointer",
                    }}
                    title={c}
                  />
                ))}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Ikona</label>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(6, 1fr)", gap:6 }}>
                {CATEGORY_ICONS.map(ico => (
                  <button
                    key={ico}
                    onClick={() => setCatForm(f => ({ ...f, icon: ico }))}
                    style={{
                      aspectRatio:"1",
                      borderRadius:8,
                      background: catForm.icon === ico ? `${catForm.color}22` : "var(--surface2)",
                      border: catForm.icon === ico ? `2px solid ${catForm.color}` : "1px solid var(--border)",
                      cursor:"pointer",
                      display:"flex", alignItems:"center", justifyContent:"center",
                    }}
                    title={ico}
                  >
                    <Icon name={ico} size={18} color={catForm.icon === ico ? catForm.color : "var(--text2)"} />
                  </button>
                ))}
              </div>
            </div>

            <div className="form-group">
              <label style={{ display:"flex", alignItems:"center", gap:10, cursor:"pointer" }}>
                <input
                  type="checkbox"
                  checked={catForm.showInNav !== false}
                  onChange={e => setCatForm(f => ({ ...f, showInNav: e.target.checked }))}
                  style={{ width:18, height:18 }}
                />
                <span style={{ fontSize:13, fontWeight:600 }}>Pokaż jako zakładkę w nawigacji</span>
              </label>
              <div style={{ fontSize:11, color:"var(--text2)", marginTop:4, marginLeft:28 }}>
                Jeśli włączone, kategoria pojawi się jako osobna pozycja w menu bocznym.
              </div>
            </div>

            {/* Podgląd */}
            <div style={{ padding:12, background:"var(--surface2)", borderRadius:10, marginBottom:12, display:"flex", alignItems:"center", gap:10 }}>
              <div style={{ width:32, height:32, borderRadius:8, background:`${catForm.color}22`, border:`1px solid ${catForm.color}66`, display:"flex", alignItems:"center", justifyContent:"center" }}>
                <Icon name={catForm.icon} size={16} color={catForm.color} />
              </div>
              <div style={{ fontSize:11, color:"var(--text2)" }}>Podgląd:</div>
              <div style={{ fontFamily:"var(--font-display)", fontSize:14, letterSpacing:"0.06em", color:catForm.color }}>
                {(catForm.name || "NAZWA").toUpperCase()}
              </div>
            </div>

            {catError && (
              <div style={{ padding:"8px 10px", background:"rgba(239,68,68,0.12)", border:"1px solid rgba(239,68,68,0.3)", borderRadius:8, fontSize:12, color:"var(--red)", marginBottom:10, fontWeight:600 }}>
                {catError}
              </div>
            )}

            <div className="btn-row">
              <button className="btn btn-ghost" onClick={() => setShowCatForm(false)}>Anuluj</button>
              <button className="btn btn-primary" onClick={saveCategory} disabled={!catForm.name.trim()}>Zapisz</button>
            </div>
        </FloatingModal>
      )}

      {/* ═══ MODAL: edycja / dodawanie pola formularza ═══ */}
      {fieldModal && (
        <FieldDetailModal
          field={fieldModal.field || null}
          groupNames={groupOrder.length ? groupOrder : [...new Set(schemaFields.map(f => f.group))]}
          onSave={saveFieldModal}
          onClose={() => setFieldModal(null)}
        />
      )}

      {/* PAKIET 8b — Modal: nowa grupa */}
      {newGroupModal && (
        <FloatingModal open onClose={() => { setNewGroupModal(false); setNewGroupName(""); }} title="Nowa grupa" size="sm">
          <div className="form-group">
            <label className="form-label">Nazwa grupy *</label>
            <input
              className="form-input"
              autoFocus
              value={newGroupName}
              onChange={e => setNewGroupName(e.target.value)}
              placeholder="np. Dodatkowe, Marketing, Linki"
              onKeyDown={e => { if (e.key === "Enter" && newGroupName.trim()) handleAddGroup(); }}
              style={{ width:"100%", boxSizing:"border-box" }}
            />
          </div>
          <div className="btn-row" style={{ display:"flex", gap:10 }}>
            <button className="btn btn-ghost" style={{ flex:1 }} onClick={() => { setNewGroupModal(false); setNewGroupName(""); }}>Anuluj</button>
            <button className="btn btn-primary" style={{ flex:1 }} disabled={!newGroupName.trim() || groupOrder.includes(newGroupName.trim())} onClick={handleAddGroup}>Dodaj</button>
          </div>
          {newGroupName.trim() && groupOrder.includes(newGroupName.trim()) && (
            <div style={{ marginTop:10, fontSize:12, color:"var(--yellow)" }}>
              Grupa o tej nazwie już istnieje.
            </div>
          )}
        </FloatingModal>
      )}

      {/* PAKIET 8b — Modal: zmiana nazwy grupy */}
      {editGroupModal && (
        <FloatingModal open onClose={() => setEditGroupModal(null)} title={`Zmień nazwę grupy: ${editGroupModal.oldName}`} size="sm">
          <div className="form-group">
            <label className="form-label">Nowa nazwa *</label>
            <input
              className="form-input"
              autoFocus
              value={editGroupModal.newName || ""}
              onChange={e => setEditGroupModal(g => ({ ...g, newName: e.target.value }))}
              placeholder="Nowa nazwa grupy"
              onKeyDown={e => { if (e.key === "Enter" && editGroupModal.newName.trim()) handleRenameGroup(); }}
              style={{ width:"100%", boxSizing:"border-box" }}
            />
          </div>
          <div className="btn-row" style={{ display:"flex", gap:10 }}>
            <button className="btn btn-ghost" style={{ flex:1 }} onClick={() => setEditGroupModal(null)}>Anuluj</button>
            <button className="btn btn-primary" style={{ flex:1 }}
              disabled={!editGroupModal.newName || !editGroupModal.newName.trim() || editGroupModal.newName.trim() === editGroupModal.oldName || (groupOrder.includes(editGroupModal.newName.trim()) && editGroupModal.newName.trim() !== editGroupModal.oldName)}
              onClick={handleRenameGroup}>Zapisz</button>
          </div>
        </FloatingModal>
      )}

      {/* PAKIET 8b — Confirm: usunięcie grupy */}
      {deleteGroupConfirm && (() => {
        const cnt = schemaFields.filter(f => f.group === deleteGroupConfirm).length;
        return (
          <ConfirmModal
            open
            variant="danger"
            title={`Usunąć grupę „${deleteGroupConfirm}"?`}
            message={cnt > 0
              ? <>Grupa zawiera <strong>{cnt} {plForm(cnt, "pole", "pola", "pól")}</strong>. Pola zostaną przeniesione do grupy „Inne". Kontynuować?</>
              : <>Usunąć pustą grupę „{deleteGroupConfirm}"?</>}
            confirmLabel="Usuń"
            cancelLabel="Anuluj"
            onClose={() => setDeleteGroupConfirm(null)}
            onConfirm={handleDeleteGroup}
          />
        );
      })()}

      {/* ═══ Reset schemy formularza ═══ */}
      <ConfirmModal
        open={showSchemaReset}
        onClose={() => setShowSchemaReset(false)}
        onConfirm={resetSchema}
        title="Reset formularza do domyślnych"
        message="Przywrócić domyślne pola formularza? Wszystkie pola własne zostaną usunięte, a zmiany etykiet, typów, widoczności i kolejności cofnięte. Tej operacji nie można cofnąć."
        variant="danger"
        confirmLabel="Resetuj"
      />

      {/* ═══ Usuwanie pola własnego ═══ */}
      <ConfirmModal
        open={!!deleteFieldId}
        onClose={() => setDeleteFieldId(null)}
        onConfirm={() => { removeCustomField(deleteFieldId); setDeleteFieldId(null); }}
        title="Usuń pole własne"
        message={`Usunąć pole „${(schemaFields.find(f => f.id === deleteFieldId) || {}).label || ""}"? Wartości tego pola zapisane w istniejących pozycjach przestaną być widoczne.`}
        variant="danger"
        confirmLabel="Usuń"
      />
    </div>
  );
};

// ─── MAINTENANCE VIEW — konserwator (tylko lista zadań) ──────────────────────
const MaintenanceView = ({ currentUser, tasks, apartments, onSelectTask, onLogout }) => {
  const [taskFilter, setTaskFilter] = useState("Wszystkie");

  const statusOrder = { "W trakcie": 0, "Nie rozpoczęto": 1, "Zrobione": 2 };
  const sortedTasks = tasks
    .filter(t => taskFilter === "Wszystkie" || t.status === taskFilter)
    .sort((a, b) => { const pa = a.priority==="high"?0:a.priority==="low"?2:1; const pb = b.priority==="high"?0:b.priority==="low"?2:1; if (pa !== pb) return pa - pb; return (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3); });

  return (
    <div className="app-root">
      <style>{styles}</style>
      <div className="app">
        <div className="header">
          <h1>Zadania — konserwator</h1>
          <div className="header-actions">
            <button className="icon-btn" onClick={onLogout} title="Wyloguj">
              <Icon name="logout" size={16} />
            </button>
          </div>
        </div>
        <div className="content" style={{ paddingTop: 0 }}>
          <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:"var(--radius)", padding:16, marginBottom:16 }}>
            <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:4 }}>
              Konserwator
            </div>
            <div style={{ fontFamily:"var(--font-display)", fontSize:24, letterSpacing:"0.06em" }}>
              {currentUser.name}
            </div>
          </div>

          <div className="filter-row" style={{ marginBottom:16 }}>
            {["Wszystkie","W trakcie","Nie rozpoczęto","Zrobione"].map(f => (
              <div key={f} className={`filter-chip ${taskFilter === f ? "active" : ""}`} onClick={() => setTaskFilter(f)}>{f}</div>
            ))}
          </div>

          <div className="section-header">
            <span className="section-title">{sortedTasks.length} zadań</span>
          </div>

          {sortedTasks.length === 0 ? (
            <div className="empty">
              <div className="empty-icon"><Icon name="tasks" size={40} /></div>
              <h3>Brak zadań</h3>
            </div>
          ) : sortedTasks.map(task => {
            const apt = apartments.find(a => a.id === task.apartmentId);
            return (
              <div key={task.id} className="task-card" onClick={() => onSelectTask(task)}>
                <div className="task-card-header">
                  <div style={{ flex:1 }}>
                    {apt && <div className="task-apt">{apt.name}</div>}
                    <div className="task-title">{task.priority==="high" && <span style={{color:"var(--red)",marginRight:6}}>🔴</span>}{task.priority==="low" && <span style={{color:"var(--green)",marginRight:6}}>🟢</span>}{task.title}</div>
                  </div>
                  <TaskStatusBadge status={task.status} />
                </div>
                <div className="task-meta">
                  <div className="task-assignee"><div className="avatar">{task.assignedTo[0]}</div>{task.assignedTo}</div>
                  <span style={{ fontSize:11, color:"var(--text2)" }}>{task.createdAt}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

const CleaningManagerView = ({ apartments, cleaningSessions, onAddSession, onUpdateSession, onDeleteSession, currentUser }) => {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addAptId, setAddAptId] = useState("");
  const [addPerson, setAddPerson] = useState("");

  const sessions = cleaningSessions
    .filter(s => s.date === date)
    .sort((a, b) => {
      const order = { in_progress: 0, planned: 1, done: 2 };
      return (order[a.status] ?? 3) - (order[b.status] ?? 3);
    });

  // Apartamenty z wyjazdem w tym dniu (podpowiedź przy planowaniu)
  const checkoutApts = CleaningSessions.apartmentsCheckingOutOn(date, apartments);
  const checkoutMissingSession = checkoutApts.filter(a => !sessions.some(s => s.apartmentId === a.id));

  const statusColor = { planned: "var(--text2)", in_progress: "var(--accent)", done: "var(--green)" };
  const statusLabel = { planned: "Zaplanowane", in_progress: "W trakcie", done: "Ukończone" };

  const stats = sessions.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});

  const dateLabel = date === today ? "dzisiaj" : date;

  return (
    <div>
      <div className="header">
        <h1>Sprzątanie</h1>
        <div className="header-actions">
          <button className="icon-btn" onClick={() => setShowAddModal(true)} title="Dodaj sesję">
            <Icon name="plus" size={16} color="var(--accent)" />
          </button>
        </div>
      </div>
      <div className="content">
        {/* Date picker */}
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16 }}>
          <button onClick={() => { const d=new Date(date); d.setDate(d.getDate()-1); setDate(d.toISOString().slice(0,10)); }}
            style={{ background:"var(--surface)",border:"1px solid var(--border)",borderRadius:8,padding:"6px 10px",color:"var(--text)",cursor:"pointer",fontSize:16 }}>‹</button>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            style={{ flex:1, background:"var(--surface)",border:"1px solid var(--border)",borderRadius:10,padding:"8px 12px",color:"var(--text)",fontSize:14,fontWeight:600,fontFamily:"var(--font-body)" }} />
          <button onClick={() => { const d=new Date(date); d.setDate(d.getDate()+1); setDate(d.toISOString().slice(0,10)); }}
            style={{ background:"var(--surface)",border:"1px solid var(--border)",borderRadius:8,padding:"6px 10px",color:"var(--text)",cursor:"pointer",fontSize:16 }}>›</button>
          {date !== today && <button onClick={() => setDate(today)}
            style={{ background:"var(--accent)",border:"none",borderRadius:8,padding:"6px 12px",color:"#000",cursor:"pointer",fontSize:11,fontWeight:700 }}>DZIŚ</button>}
        </div>

        {/* Info: apartamenty które zwalniają się danego dnia a nie mają jeszcze sesji */}
        {checkoutMissingSession.length > 0 && (
          <div style={{ background:"rgba(245,158,11,0.1)", border:"1px solid rgba(245,158,11,0.3)", borderRadius:10, padding:"12px 14px", marginBottom:16 }}>
            <div style={{ fontSize:12, color:"var(--yellow)", fontWeight:700, marginBottom:4 }}>
              ⚠ {checkoutMissingSession.length} wyjazd{checkoutMissingSession.length === 1 ? "" : "ów"} {dateLabel} bez zaplanowanego sprzątania
            </div>
            <div style={{ fontSize:11, color:"var(--text2)", marginBottom:10 }}>
              {checkoutMissingSession.map(a => a.name).join(", ")}
            </div>
            <button
              onClick={() => onAddSession("auto", date)}
              style={{ background:"var(--yellow)", border:"none", borderRadius:8, padding:"8px 14px", color:"#000", fontSize:11, fontWeight:700, letterSpacing:"0.06em", cursor:"pointer" }}
            >+ ZAPLANUJ SPRZĄTANIA</button>
          </div>
        )}

        {/* Stats bar */}
        {sessions.length > 0 && (
          <div style={{ display:"flex", gap:8, marginBottom:16 }}>
            {Object.entries({ planned:"Zaplanowane", in_progress:"W trakcie", done:"Ukończone" }).map(([k, label]) => stats[k] ? (
              <div key={k} style={{ flex:1, background:"var(--surface)", border:`1px solid ${statusColor[k]}22`, borderRadius:10, padding:"8px 12px", textAlign:"center" }}>
                <div style={{ fontFamily:"var(--font-display)", fontSize:24, color:statusColor[k], letterSpacing:"0.06em" }}>{stats[k]}</div>
                <div style={{ fontSize:10, color:"var(--text2)", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.08em" }}>{label}</div>
              </div>
            ) : null)}
          </div>
        )}

        {sessions.length === 0 ? (
          <div className="empty">
            <div className="empty-icon"><Icon name="check" size={40} /></div>
            <h3>Brak sesji sprzątania</h3>
            <p style={{ fontSize:13, color:"var(--text2)", marginTop:6, marginBottom:16 }}>
              {checkoutMissingSession.length > 0
                ? `${checkoutMissingSession.length} apartament(ów) zwalnia się ${dateLabel} — kliknij aby zaplanować.`
                : `Brak wyjazdów zaplanowanych na ${dateLabel}. Możesz dodać sprzątanie ręcznie.`}
            </p>
            {checkoutMissingSession.length > 0 ? (
              <button className="btn btn-primary" onClick={() => onAddSession("auto", date)}>
                + Zaplanuj z wyjazdów tego dnia
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
                + Dodaj sprzątanie ręcznie
              </button>
            )}
          </div>
        ) : sessions.map(s => {
          const apt = apartments.find(a => a.id === s.apartmentId);
          return (
            <div key={s.id} style={{ background:"var(--surface)", border:`1px solid ${statusColor[s.status]}33`, borderRadius:"var(--radius)", marginBottom:8, padding:"12px 14px" }}>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <div style={{ width:8, height:8, borderRadius:"50%", background:statusColor[s.status], flexShrink:0 }} />
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:"var(--font-display)", fontSize:17, letterSpacing:"0.06em" }}>{apt && apt.name || "—"}</div>
                  <div style={{ fontSize:11, color:"var(--text2)", marginTop:2 }}>
                    <span style={{ color:statusColor[s.status], fontWeight:700 }}>{statusLabel[s.status]}</span>
                    {s.assignedTo && ` · ${s.assignedTo}`}
                    {s.durationSec > 0 && ` · ${CleaningSessions.formatDuration(s.durationSec)}`}
                  </div>
                  <div style={{ fontSize:10, color:"var(--text2)", marginTop:3, display:"flex", gap:8, flexWrap:"wrap" }}>
                    {apt && apt.checkoutTime && <span style={{ color:"var(--yellow)", fontWeight:700 }}>🕐 do {apt.checkoutTime}</span>}
                    {apt && apt.securityType && <span>🔒 {apt.securityType}{apt && apt.safeCode ? ` · ${apt.safeCode}` : ""}</span>}
                  </div>
                  {s.notes && <div style={{ fontSize:12, color:"var(--text2)", marginTop:4, fontStyle:"italic" }}>"{s.notes}"</div>}
                </div>
                <div style={{ display:"flex", gap:6 }}>
                  {s.status !== "done" && (
                    <button onClick={() => onUpdateSession(s.status === "planned" ? "start" : "finish", s.id, "")}
                      style={{ background: s.status === "planned" ? "rgba(59,130,246,0.15)" : "rgba(34,197,94,0.15)",
                        border:"none", borderRadius:8, padding:"6px 10px", cursor:"pointer",
                        color: s.status === "planned" ? "var(--accent)" : "var(--green)", fontSize:11, fontWeight:700 }}>
                      {s.status === "planned" ? "▶ Start" : "✓ Koniec"}
                    </button>
                  )}
                  <button onClick={() => onDeleteSession(s.id)}
                    style={{ background:"rgba(239,68,68,0.1)", border:"none", borderRadius:8, padding:"6px 8px", cursor:"pointer", color:"var(--red)" }}>
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add session modal */}
      {showAddModal && (
        <FloatingModal open onClose={() => setShowAddModal(false)} title="Dodaj sprzątanie" size="sm">
            <div className="form-group">
              <label className="form-label">Apartament</label>
              <select className="form-select" value={addAptId} onChange={e => setAddAptId(e.target.value)}>
                <option value="">Wybierz apartament</option>
                {apartments.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Przypisz do</label>
              <select className="form-select" value={addPerson} onChange={e => setAddPerson(e.target.value)}>
                <option value="">Dowolna osoba</option>
                {WORKERS.map(w => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
            <div style={{ display:"flex", gap:10, marginTop:8 }}>
              <button className="btn btn-primary" style={{ flex:1 }} onClick={() => {
                if (addAptId) { onAddSession("manual", date, Number(addAptId), addPerson); setShowAddModal(false); setAddAptId(""); setAddPerson(""); }
              }}>Dodaj</button>
              <button className="btn" style={{ flex:1 }} onClick={() => setShowAddModal(false)}>Anuluj</button>
            </div>
        </FloatingModal>
      )}
    </div>
  );
};

// ─── APARTMENT DETAIL — rozszerzony z nowymi zakładkami ──────────────────────
const ApartmentDetail = ({ apt, owner, tasks, cleaningSessions, loans, apartments, files, onBack, onEdit, onAddTask, onSelectTask, onRefreshLoans, onRefreshFiles, currentUser, initialTab }) => {
  const [tab, setTab] = useState(initialTab || "info");
  const [showFileForm, setShowFileForm] = useState(false);
  // Pliki przypisane do tego apartamentu (FIX 2.C)
  const apartmentFiles = (files || []).filter(f => String(f.aptId) === String(apt.id));
  const [taskFilter, setTaskFilter] = useState("Wszystkie");

  // ── Uprawnienia ──────────────────────────────────────────────────────────
  const isManager    = currentUser && currentUser.role === ROLES.MANAGER;
  const canEdit      = isManager; // worker = read-only
  const canAddTask   = isManager;

  // ── Dane per-apartament (z Storage) ───────────────────────────────────────
  // Wyposażenie: seed ze STANDARD_EQUIPMENT z qty=1, pogrupowane po kategorii
  const [equipment, setEquipment] = useState(() => {
    const stored = Storage.get(`apt_equip_${apt.id}`);
    if (stored) return stored;
    return STANDARD_EQUIPMENT.map((e, i) => ({
      id: i + 1, name: e.name, cat: e.cat, qty: 1,
    }));
  });
  const [textiles, setTextiles] = useState(() => {
    const stored = Storage.get(`apt_text_${apt.id}`);
    if (stored) return stored;
    return TextilesService.getAll().map((t, i) => ({
      id: i + 1, name: t.name, size: t.size, qty: apt.capacity >= 6 ? 6 : 4,
    }));
  });
  const [orders, setOrders] = useState(() => Storage.get(`apt_orders_${apt.id}`) || []);

  // ── SMS — globalny z Settings + override per apartament ──────────────────
  // Efektywny szablon wyświetlany po prostu przez Settings.getTemplateForApt(apt)
  // Override = własny szablon dla tego apt, zapisany przez Settings.setOverride
  const [smsOverride, setSmsOverride] = useState(() => {
    const all = Settings.getAll();
    return (all.smsOverrides || {})[apt.id] || null;
  });
  const [editingOverride, setEditingOverride] = useState(false);
  const [overrideDraft, setOverrideDraft] = useState("");
  // FIX 6.4 — ref do textarea + insertVar dla SmsVariablesPanel w zakładce SMS detalu apartamentu.
  const overrideTaRef = useRef(null);
  const insertOverrideVar = (token) => {
    const ta = overrideTaRef.current;
    const cur = overrideDraft || "";
    if (!ta) { setOverrideDraft(cur + token); return; }
    const start = ta.selectionStart, end = ta.selectionEnd;
    setOverrideDraft(cur.slice(0, start) + token + cur.slice(end));
    requestAnimationFrame(() => {
      const el = overrideTaRef.current;
      if (el) { const pos = start + token.length; el.focus(); el.setSelectionRange(pos, pos); }
    });
  };

  const effectiveSmsTemplate = smsOverride ?? ((Settings.getAll().smsTemplates || {})[apt.status] || DEFAULT_SMS_TEMPLATES[apt.status] || DEFAULT_SMS_TEMPLATES["ZARZĄDZANIE"]);
  const hasOverride = smsOverride !== null && smsOverride !== undefined;

  // ── Form state ──────────────────────────────────────────────────────────
  const [newItemName, setNewItemName] = useState({ equip: "", text: "" });
  const [newItemQty,  setNewItemQty]  = useState({ equip: 1,  text: 1  });
  const [newItemSize, setNewItemSize] = useState(""); // tylko dla tekstyliów
  const [newItemCat,  setNewItemCat]  = useState("Niestandardowe"); // kategoria pomieszczenia dla wyposażenia
  const [confirmDelete, setConfirmDelete] = useState(null); // { kind, item }
  const [smsCopied, setSmsCopied] = useState(false);
  // FIX 6.1/6.2 — edycja wyposażenia/tekstyliów przez modal (domyślnie read-only).
  const [editKind, setEditKind] = useState(null); // null | "equip" | "text"
  // FIX 6.3 — w modalu edycji wyposażenia: dodawanie/usuwanie pomieszczeń + podwójne potwierdzenie dla wbudowanych (FIX 3.A).
  const [newRoomInModal, setNewRoomInModal] = useState("");
  const [confirmRoomDelete,   setConfirmRoomDelete]   = useState(null); // pokoj non-builtin
  const [roomDeleteStep1, setRoomDeleteStep1] = useState(null); // builtin: ostrzeżenie
  const [roomDeleteStep2, setRoomDeleteStep2] = useState(null); // builtin: przepisanie nazwy
  const [roomDeleteText,  setRoomDeleteText]  = useState("");

  // ── Notatki (array z datą) ───────────────────────────────────────────────
  const [aptNotes, setAptNotes] = useState(() => Storage.get(`apt_notes_${apt.id}`) || []);
  const [newNote, setNewNote] = useState("");
  const saveNotes = (notes) => { setAptNotes(notes); Storage.set(`apt_notes_${apt.id}`, notes); };
  const addNote = () => {
    if (!newNote.trim() || !canEdit) return;
    saveNotes([{
      id: Date.now(),
      text: newNote.trim(),
      author: currentUser && currentUser.name || "",
      createdAt: new Date().toISOString(),
      history: [], // historia edycji
    }, ...aptNotes]);
    setNewNote("");
  };
  const deleteNote = (id) => { if (canEdit) saveNotes(aptNotes.filter(n => n.id !== id)); };
  const editNote = (id, newText) => {
    if (!canEdit) return;
    saveNotes(aptNotes.map(n => {
      if (n.id !== id) return n;
      return {
        ...n,
        text: newText,
        history: [...(n.history || []), { text: n.text, editedAt: new Date().toISOString(), editedBy: currentUser && currentUser.name || "" }],
      };
    }));
  };
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editNoteDraft, setEditNoteDraft] = useState("");
  const [showNoteHistory, setShowNoteHistory] = useState(null); // note.id

  // ── Klucze z historią zmian ─────────────────────────────────────────────
  const [keysData, setKeysData] = useState(() => {
    const stored = Storage.get(`apt_keys_${apt.id}`);
    if (stored) return stored;
    return { current: apt.keys || "", history: [] };
  });
  const [editingKeys, setEditingKeys] = useState(false);
  const [keysDraft, setKeysDraft] = useState("");
  const saveKeys = (newText) => {
    const updated = {
      current: newText,
      history: [...keysData.history, { text: keysData.current, changedAt: new Date().toISOString(), changedBy: currentUser && currentUser.name || "" }],
    };
    setKeysData(updated);
    Storage.set(`apt_keys_${apt.id}`, updated);
  };
  const [showKeysHistory, setShowKeysHistory] = useState(false);
  const [roomRefresh, setRoomRefresh] = useState(0); // force re-render after adding room

  // ── Pożyczki — formularz z tego apt ────────────────────────────────────
  const [showLoanForm, setShowLoanForm] = useState(false);
  const [loanForm, setLoanForm] = useState({ toAptId: "", items: [{ name: "", qty: 1 }], notes: "" });
  // FIX 3.C — widok pożyczek w detalu: aktywne vs historia
  const [loansShowAll,    setLoansShowAll]    = useState(true);  // false = pokaż tylko aktywne
  const [loanHistoryOpen, setLoanHistoryOpen] = useState(false); // sekcja historii rozwinięta
  const [returnModal, setReturnModal] = useState(null); // pożyczka oznaczana jako zwrócona
  const [returnDate,  setReturnDate]  = useState("");
  const [returnNote,  setReturnNote]  = useState("");
  const addLoanLine = () => setLoanForm(f => ({ ...f, items: [...f.items, { name: "", qty: 1 }] }));
  const removeLoanLine = (idx) => setLoanForm(f => ({ ...f, items: f.items.length > 1 ? f.items.filter((_, i) => i !== idx) : f.items }));
  const updateLoanLine = (idx, p) => setLoanForm(f => ({ ...f, items: f.items.map((l, i) => i === idx ? { ...l, ...p } : l) }));
  const [loanError, setLoanError] = useState("");
  // FIX 9.1b — sumaryczna ilość wypożyczona aktywnie z tego apartamentu per pozycja
  const borrowedOutQty = (() => {
    const m = new Map();
    (loans || [])
      .filter(l => l.status === "active" && l.fromAptId === apt.id)
      .flatMap(l => (l.items || []))
      .forEach(it => m.set(it.name, (m.get(it.name) || 0) + Number(it.qty || 0)));
    return m;
  })();
  // ilość w apartamencie per nazwa (suma — gdyby były duplikaty)
  const equipQtyByName = (() => {
    const m = new Map();
    (equipment || []).forEach(e => m.set(e.name, (m.get(e.name) || 0) + Number(e.qty || 0)));
    return m;
  })();
  const availableQtyFor = (name) => Math.max(0, (equipQtyByName.get(name) || 0) - (borrowedOutQty.get(name) || 0));
  // FIX 9.1b — pokaż tylko pozycje, których jest jeszcze choć 1 sztuka dostępna
  const availableEquip = [...equipQtyByName.entries()]
    .map(([name]) => ({ name, available: availableQtyFor(name) }))
    .filter(e => e.available > 0);
  const availableEquipNames = availableEquip.map(e => e.name);

  const submitLoan = () => {
    if (!loanForm.toAptId) { setLoanError("Wybierz apartament docelowy"); return; }
    const items = loanForm.items.filter(i => i.name.trim());
    if (items.length === 0) { setLoanError("Dodaj przynajmniej jedną pozycję"); return; }
    // FIX 9.1b — walidacja: ilość ≤ dostępne
    for (const it of items) {
      const avail = availableQtyFor(it.name);
      const q = Number(it.qty || 0);
      if (q < 1) { setLoanError(`Ilość '${it.name}' musi być ≥ 1`); return; }
      if (q > avail) { setLoanError(`Nie można pożyczyć ${q} szt. '${it.name}' — dostępne tylko ${avail} szt. w apartamencie`); return; }
    }
    const entry = Loans.add({ fromAptId: apt.id, toAptId: loanForm.toAptId, items, notes: loanForm.notes, createdBy: currentUser && currentUser.name || "" });
    if (!entry) { setLoanError("Nie udało się utworzyć"); return; }
    setShowLoanForm(false);
    setLoanForm({ toAptId: "", items: [{ name: "", qty: 1 }], notes: "" });
    setLoanError("");
    onRefreshLoans && onRefreshLoans(); // Notify parent to refresh loans state
  };

  // FIX 3.C — oznaczanie zwrotu + usuwanie pożyczki z poziomu detalu
  const aptNameOf = (id) => ((apartments || []).find(a => a.id === id) || {}).name || "—";
  const openReturnModal = (loan) => {
    setReturnDate(new Date().toISOString().slice(0, 10));
    setReturnNote("");
    setReturnModal(loan);
  };
  const confirmReturn = () => {
    if (!returnModal) return;
    Loans.markReturned(returnModal.id, { returnedAt: returnDate, note: returnNote });
    setReturnModal(null);
    onRefreshLoans && onRefreshLoans();
  };
  const deleteLoanFromDetail = (id) => {
    if (!isManager) return;
    Loans.remove(id);
    onRefreshLoans && onRefreshLoans();
  };

  // Zamówienia: multi-item w jednym zamówieniu
  // newOrder.items: [{ itemName, qty }]
  const [newOrder, setNewOrder] = useState({
    items: [{ itemName: "", qty: 1 }],
    notes: "",
  });
  const addOrderLine = () => setNewOrder(o => ({ ...o, items: [...o.items, { itemName:"", qty:1 }] }));
  const removeOrderLine = (idx) => setNewOrder(o => ({
    ...o, items: o.items.length > 1 ? o.items.filter((_, i) => i !== idx) : o.items
  }));
  const updateOrderLine = (idx, patch) => setNewOrder(o => ({
    ...o, items: o.items.map((line, i) => i === idx ? { ...line, ...patch } : line)
  }));

  // Sortowanie zadań: w_trakcie → nie_rozpoczęte → zrobione
  const taskOrderMap = { "W trakcie": 0, "Nie rozpoczęto": 1, "Zrobione": 2 };
  const aptTasks = tasks
    .filter(t => t.apartmentId === apt.id)
    .filter(t => taskFilter === "Wszystkie" || t.status === taskFilter)
    .sort((a, b) => { const pa = a.priority==="high"?0:a.priority==="low"?2:1; const pb = b.priority==="high"?0:b.priority==="low"?2:1; if (pa !== pb) return pa - pb; return (taskOrderMap[a.status] ?? 3) - (taskOrderMap[b.status] ?? 3); });

  const aptHistory = cleaningSessions
    ? cleaningSessions.filter(s => s.apartmentId === apt.id).sort((a, b) => b.date.localeCompare(a.date))
    : [];

  const saveEquipment = (newEq)  => { setEquipment(newEq); Storage.set(`apt_equip_${apt.id}`, newEq); };
  const saveTextiles  = (newTx)  => { setTextiles(newTx);  Storage.set(`apt_text_${apt.id}`, newTx); };
  const saveOrders    = (newOrd) => { setOrders(newOrd);   Storage.set(`apt_orders_${apt.id}`, newOrd); };

  // ── Inventory helpers ─────────────────────────────────────────────────────
  const confirmDeleteItem = () => {
    if (!confirmDelete) return;
    const { kind, item } = confirmDelete;
    if (kind === "equip") saveEquipment(equipment.filter(i => i.id !== item.id));
    else                  saveTextiles(textiles.filter(i => i.id !== item.id));
    setConfirmDelete(null);
  };

  const addInventoryItem = (kind) => {
    if (!canEdit) return;
    const field = kind === "equip" ? "equip" : "text";
    const name  = (newItemName[field] || "").trim();
    const qty   = Math.max(1, Number(newItemQty[field]) || 1);
    if (!name) return;
    const list   = kind === "equip" ? equipment : textiles;
    const saveFn = kind === "equip" ? saveEquipment : saveTextiles;
    const nextId = Math.max(0, ...list.map(i => i.id)) + 1;
    if (kind === "equip") {
      saveFn([...list, { id: nextId, name, qty, cat: newItemCat || "Niestandardowe" }]);
      setNewItemCat("Niestandardowe");
    } else {
      saveFn([...list, { id: nextId, name, qty, size: newItemSize || "" }]);
      setNewItemSize("");
    }
    setNewItemName(s => ({ ...s, [field]: "" }));
    setNewItemQty(s => ({ ...s, [field]: 1 }));
  };

  // FIX 6.1/6.2 — bezpośrednie ustawienie ilości (modal używa NumberInput zamiast +/-).
  const setItemQty = (kind, id, qty) => {
    if (!canEdit) return;
    const n = Math.max(0, Number(qty) || 0);
    const list   = kind === "equip" ? equipment : textiles;
    const item   = list.find(i => i.id === id);
    if (!item) return;
    if (n === 0) { setConfirmDelete({ kind, item }); return; }
    const saveFn = kind === "equip" ? saveEquipment : saveTextiles;
    saveFn(list.map(i => i.id === id ? { ...i, qty: n } : i));
  };

  // FIX 6.1 — usuwanie pozycji z modala (zawsze przez ConfirmModal — nie zniknie przez przypadek).
  const askDeleteItem = (kind, item) => { if (canEdit) setConfirmDelete({ kind, item }); };

  // FIX 6.3 — dodawanie pomieszczenia (per-apt), trigger re-renderu selectów przez roomRefresh.
  const addRoomInModal = () => {
    if (!canEdit) return;
    const name = (newRoomInModal || "").trim();
    if (!name) return;
    EquipmentRooms.add({ name, aptId: apt.id });
    setNewRoomInModal("");
    setRoomRefresh(r => r + 1);
  };

  // FIX 6.3 — usunięcie pomieszczenia non-builtin (potwierdzenie przez ConfirmModal).
  const doDeleteRoom = (room) => {
    if (!canEdit || !room) return;
    EquipmentRooms.remove(room.id);
    setConfirmRoomDelete(null);
    setRoomRefresh(r => r + 1);
  };

  // FIX 6.3 + 3.A — usunięcie wbudowanego pomieszczenia: przenosi pozycje z tą kategorią
  // do „Niestandardowe" we WSZYSTKICH apartamentach (analogicznie jak w Ustawieniach).
  const deleteBuiltinRoomFromModal = (room) => {
    if (!canEdit || !room) return;
    EquipmentRooms.remove(room.id);
    let movedItems = 0, touchedApts = 0;
    (apartments || []).forEach(a => {
      const eq = Storage.get(`apt_equip_${a.id}`);
      if (!Array.isArray(eq)) return;
      let changed = false;
      const next = eq.map(it => {
        if (it.cat === room.name) { changed = true; movedItems++; return { ...it, cat: "Niestandardowe" }; }
        return it;
      });
      if (changed) { Storage.set(`apt_equip_${a.id}`, next); touchedApts++; }
    });
    Audit.log("EQUIPMENT_DELETE_BUILTIN", currentUser, { item: room.name, movedItems, apartments: touchedApts });
    // Odśwież własny stan, jeśli to ten apartament też dotyczy
    const ourEq = Storage.get(`apt_equip_${apt.id}`);
    if (Array.isArray(ourEq)) setEquipment(ourEq);
    setRoomDeleteStep1(null);
    setRoomDeleteStep2(null);
    setRoomDeleteText("");
    setRoomRefresh(r => r + 1);
  };

  // ── Orders ────────────────────────────────────────────────────────────────
  const ORDER_STATUS = {
    waiting:    { label: "Oczekuje",        color: "var(--yellow)" },
    processing: { label: "W realizacji",    color: "var(--accent)" },
    done:       { label: "Zrealizowano",    color: "var(--green)"  },
  };

  const addOrder = () => {
    if (!canEdit) return;
    // Filtrujemy puste linie
    const items = newOrder.items
      .map(l => ({ itemName: (l.itemName || "").trim(), qty: Math.max(1, Number(l.qty) || 1) }))
      .filter(l => l.itemName);
    if (items.length === 0) return;
    const entry = {
      id: Date.now(),
      items, // array
      notes: (newOrder.notes || "").trim(),
      status: "waiting",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveOrders([entry, ...orders]);
    setNewOrder({ items:[{ itemName:"", qty:1 }], notes:"" });
  };

  const cycleOrderStatus = (id) => {
    if (!canEdit) return;
    const next = { waiting: "processing", processing: "done", done: "waiting" };
    saveOrders(orders.map(o => o.id === id ? { ...o, status: next[o.status] || "waiting", updatedAt: new Date().toISOString() } : o));
  };

  const deleteOrder = (id) => { if (canEdit) saveOrders(orders.filter(o => o.id !== id)); };

  // ── SMS override helpers ──────────────────────────────────────────────────
  const startOverride = () => {
    setOverrideDraft(smsOverride ?? effectiveSmsTemplate);
    setEditingOverride(true);
  };
  const saveOverride = () => {
    Settings.setOverride(apt.id, overrideDraft);
    setSmsOverride(overrideDraft);
    setEditingOverride(false);
  };
  const removeOverride = () => {
    Settings.removeOverride(apt.id);
    setSmsOverride(null);
    setEditingOverride(false);
  };

  const aptLoans = (loans || []).filter(l => l.fromAptId === apt.id || l.toAptId === apt.id);

  const allTabs = [
    { id:"info",    label:"INFO" },
    { id:"notes",   label:"NOTATKI" },
    { id:"klucze",  label:"KLUCZE" },
    { id:"sms",     label:"SMS" },
    { id:"equip",   label:"WYPOSAŻENIE" },
    { id:"textiles",label:"TEKSTYLIA" },
    { id:"orders",  label:"ZAMÓWIENIA" },
    { id:"loans",   label:`POŻYCZKI (${aptLoans.filter(l=>l.status==="active").length})` },
    { id:"pliki",   label:`PLIKI (${apartmentFiles.length})` },
    { id:"zadania", label:`ZADANIA (${tasks.filter(t=>t.apartmentId===apt.id).length})` },
    { id:"historia",label:`HISTORIA SPRZĄTANIA (${aptHistory.length})` },
  ];

  return (
    <div className="slide-up">
      <div className="header">
        <button className="header-back" onClick={onBack}><Icon name="back" /></button>
        <h1>Informacje ogólne</h1>
        <div className="header-actions">
          {canEdit && <button className="icon-btn" onClick={onEdit}><Icon name="edit" size={16} /></button>}
        </div>
      </div>

      <div className="detail-hero">
        <div style={{ marginBottom: 10 }}>
          <StatusBadge status={apt.aptStatus} />
          {apt.status && <span style={{ marginLeft:8, fontSize:10, fontWeight:700, color:APT_TYPE_COLORS[apt.status], letterSpacing:"0.1em", textTransform:"uppercase" }}>{apt.status}</span>}
        </div>
        <h2>{apt.name}</h2>
        {apt.onlineName && <div style={{ fontSize:14, color:"var(--text2)", marginTop:6, fontWeight:500 }}>{apt.onlineName}</div>}
      </div>

      <div className="action-row">
        {apt.address && <button className="action-btn" onClick={() => window.open(`https://maps.google.com/?q=${encodeURIComponent(apt.address)}`)}><Icon name="map" size={18} color="var(--accent)" />MAPA</button>}
        {apt.bookingLink && <button className="action-btn" onClick={() => window.open(apt.bookingLink)}><Icon name="building" size={18} color="var(--accent)" />BOOKING</button>}
        {canAddTask && <button className="action-btn primary" onClick={onAddTask}><Icon name="plus" size={18} color="#000" />ZADANIE</button>}
      </div>

      {/* Tabs — scrollable (FIX 5.3: kółko myszy + strzałki ‹ ›) */}
      <ScrollableTabs className="tabs">
        {allTabs.map(t => (
          <div key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}
            style={{ whiteSpace:"nowrap", flexShrink:0 }}>
            {t.label}
          </div>
        ))}
      </ScrollableTabs>

      {/* ── INFO ── */}
      {tab === "info" && (() => {
        const visibleFields = FormSchema.visible();
        const infoGroups = {};
        visibleFields.forEach(f => {
          if (!infoGroups[f.group]) infoGroups[f.group] = [];
          infoGroups[f.group].push(f);
        });

        return (
          <div>
            {/* Dynamiczne grupy pól */}
            {Object.entries(infoGroups).map(([groupName, fields]) => {
              // Pokazuj grupę tylko jeśli jest jakieś wypełnione pole
              const hasData = fields.some(f => apt[f.id] && String(apt[f.id]).trim());
              if (!hasData) return null;
              return (
                <div className="detail-section" key={groupName}>
                  <div className="detail-section-title"><Icon name="info" size={14} />{groupName}</div>
                  {fields.map(f => {
                    const val = apt[f.id];
                    if (!val && val !== 0) return null;
                    if (f.type === "checkbox") {
                      return <div className="detail-row" key={f.id}><span className="detail-label">{f.label}</span><span className="detail-value">Tak</span></div>;
                    }
                    if (f.type === "textarea") {
                      return <div key={f.id} style={{ marginBottom:10 }}><div style={{ fontSize:10, color:"var(--text2)", textTransform:"uppercase", letterSpacing:"0.1em", fontWeight:700, marginBottom:4 }}>{f.label}</div><p style={{ fontSize:14, lineHeight:1.6, whiteSpace:"pre-line", margin:0 }}>{val}</p></div>;
                    }
                    if (f.type === "url" && val) {
                      return <div className="detail-row" key={f.id}><span className="detail-label">{f.label}</span><a href={val} target="_blank" rel="noopener noreferrer" style={{ color:"var(--accent)", fontSize:13, fontWeight:600 }}>Otwórz link ↗</a></div>;
                    }
                    return <div className="detail-row" key={f.id}><span className="detail-label">{f.label}</span><span className="detail-value">{val}{f.type === "number" && f.id.includes("Sea") ? " m" : ""}{f.id.includes("cleaning") || f.id.includes("kaucja") || f.id.includes("Cost") ? " zł" : ""}</span></div>;
                  })}
                </div>
              );
            })}

            {/* Właściciel (hardcoded — nie jest częścią form schema) */}
            {isManager && owner && (
              <div className="detail-section">
                <div className="detail-section-title"><Icon name="users" size={14} />Właściciel</div>
                <div className="detail-row"><span className="detail-label">Właściciel</span><span className="detail-value" style={{ fontWeight:600 }}>{owner.lastName} {owner.firstName}</span></div>
                {owner.phone && <div className="detail-row"><span className="detail-label">Telefon</span><span className="detail-value">{owner.phone}</span></div>}
                <div className="detail-row"><span className="detail-label">Login KW</span><span className="detail-value">{owner.kwLogin}</span></div>
                <div className="detail-row"><span className="detail-label">Hasło KW</span><span className="detail-value">{owner.kwPassword}</span></div>
                <div className="detail-row"><span className="detail-label">Prowizja</span><span className="detail-value" style={{ color:"var(--accent)" }}>{owner.percent}%</span></div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── NOTATKI ── */}
      {tab === "notes" && (
        <div className="detail-section">
          <div className="detail-section-title"><Icon name="info" size={14} />Notatki</div>

          {/* Formularz dodawania notatki */}
          {canEdit && (
            <div style={{ marginBottom:16 }}>
              <textarea
                value={newNote}
                onChange={e => setNewNote(e.target.value)}
                placeholder="Dodaj nową notatkę..."
                style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"12px", color:"var(--text)", fontSize:14, fontFamily:"var(--font-body)", resize:"vertical", minHeight:80, boxSizing:"border-box", marginBottom:8 }}
                onKeyDown={e => { if (e.key === "Enter" && e.ctrlKey) addNote(); }}
              />
              <div style={{ display:"flex", justifyContent:"flex-end", gap:8 }}>
                <span style={{ fontSize:11, color:"var(--text2)", alignSelf:"center" }}>Ctrl+Enter aby dodać</span>
                <button
                  className="btn btn-primary"
                  style={{ padding:"8px 20px", fontSize:12 }}
                  disabled={!newNote.trim()}
                  onClick={addNote}
                >+ Dodaj notatkę</button>
              </div>
            </div>
          )}

          {/* Lista notatek chronologicznie */}
          {aptNotes.length === 0 && (
            <p style={{ color:"var(--text2)", fontSize:14, textAlign:"center", padding:"20px 0" }}>Brak notatek. {canEdit ? "Dodaj pierwszą notatkę powyżej." : ""}</p>
          )}

          {aptNotes.map(note => {
            const isEditing = editingNoteId === note.id;
            const historyOpen = showNoteHistory === note.id;
            const hasHistory = note.history && note.history.length > 0;
            return (
              <div key={note.id} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:12, marginBottom:8 }}>
                {!isEditing ? (
                  <>
                    <p style={{ fontSize:14, lineHeight:1.7, whiteSpace:"pre-line", color:"var(--text)", margin:0 }}>{note.text}</p>
                    <div style={{ fontSize:11, color:"var(--text2)", marginTop:8, display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
                      {note.author && <span style={{ fontWeight:600 }}>{note.author}</span>}
                      <span>{new Date(note.createdAt).toLocaleDateString("pl-PL")} {new Date(note.createdAt).toLocaleTimeString("pl-PL", { hour:"2-digit", minute:"2-digit" })}</span>
                      {hasHistory && <span style={{ color:"var(--accent)", fontWeight:600 }}>· edytowano ({note.history.length}x)</span>}
                      <div style={{ marginLeft:"auto", display:"flex", gap:4 }}>
                        {hasHistory && (
                          <button onClick={() => setShowNoteHistory(historyOpen ? null : note.id)}
                            style={{ background:"none", border:"none", color:"var(--text2)", cursor:"pointer", padding:2, fontSize:10, fontWeight:600 }}>
                            {historyOpen ? "▲ Ukryj historię" : "▼ Historia"}
                          </button>
                        )}
                        {canEdit && (
                          <>
                            <button onClick={() => { setEditingNoteId(note.id); setEditNoteDraft(note.text); }}
                              style={{ background:"none", border:"none", color:"var(--accent)", cursor:"pointer", padding:2, fontSize:10, fontWeight:700 }}>✏ Edytuj</button>
                            <button onClick={() => deleteNote(note.id)}
                              style={{ background:"none", border:"none", color:"var(--red)", cursor:"pointer", padding:2, fontSize:10, fontWeight:700 }}>🗑 Usuń</button>
                          </>
                        )}
                      </div>
                    </div>
                    {historyOpen && hasHistory && (
                      <div style={{ marginTop:10, paddingTop:10, borderTop:"1px solid var(--border)" }}>
                        <div style={{ fontSize:10, color:"var(--text2)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:6 }}>Historia zmian</div>
                        {note.history.slice().reverse().map((h, i) => (
                          <div key={i} style={{ padding:"6px 0", borderBottom:"1px solid var(--border)", fontSize:12 }}>
                            <div style={{ color:"var(--text2)", whiteSpace:"pre-line", lineHeight:1.5 }}>{h.text}</div>
                            <div style={{ fontSize:10, color:"var(--text2)", marginTop:4, opacity:0.7 }}>
                              {h.editedBy && `${h.editedBy} · `}{new Date(h.editedAt).toLocaleDateString("pl-PL")} {new Date(h.editedAt).toLocaleTimeString("pl-PL", { hour:"2-digit", minute:"2-digit" })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div>
                    <textarea
                      value={editNoteDraft}
                      onChange={e => setEditNoteDraft(e.target.value)}
                      style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--accent)", borderRadius:8, padding:"10px", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", resize:"vertical", minHeight:70, boxSizing:"border-box", marginBottom:8 }}
                    />
                    <div style={{ display:"flex", gap:6, justifyContent:"flex-end" }}>
                      <button className="btn" style={{ padding:"6px 14px", fontSize:11 }} onClick={() => setEditingNoteId(null)}>Anuluj</button>
                      <button className="btn btn-primary" style={{ padding:"6px 14px", fontSize:11 }}
                        disabled={!editNoteDraft.trim() || editNoteDraft.trim() === note.text}
                        onClick={() => { editNote(note.id, editNoteDraft.trim()); setEditingNoteId(null); }}>Zapisz zmiany</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── KLUCZE ── */}
      {tab === "klucze" && (
        <div className="detail-section">
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
            <div className="detail-section-title" style={{ marginBottom:0 }}><Icon name="key" size={14} />Lista kluczy</div>
            <div style={{ display:"flex", gap:6 }}>
              {keysData.history.length > 0 && (
                <button onClick={() => setShowKeysHistory(h => !h)}
                  style={{ background:"none", border:"1px solid var(--border)", borderRadius:6, padding:"4px 10px", color:"var(--text2)", fontSize:10, fontWeight:700, cursor:"pointer" }}>
                  {showKeysHistory ? "▲ Ukryj historię" : `▼ Historia (${keysData.history.length})`}
                </button>
              )}
              {canEdit && !editingKeys && (
                <button onClick={() => { setKeysDraft(keysData.current); setEditingKeys(true); }}
                  style={{ background:"none", border:"1px solid var(--border)", borderRadius:6, padding:"4px 10px", color:"var(--accent)", fontSize:10, fontWeight:700, cursor:"pointer" }}>
                  ✏ Edytuj
                </button>
              )}
            </div>
          </div>

          {!editingKeys ? (
            <>
              {keysData.current ? keysData.current.split("\n").map((line, i) => line.trim() && (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 0", borderBottom:"1px solid var(--border)" }}>
                  <div style={{ width:6, height:6, borderRadius:"50%", background:"var(--accent)", flexShrink:0 }} />
                  <span style={{ fontSize:14 }}>{line}</span>
                </div>
              )) : <p style={{ color:"var(--text2)", fontSize:14 }}>Brak danych o kluczach</p>}
            </>
          ) : (
            <div>
              <textarea
                value={keysDraft}
                onChange={e => setKeysDraft(e.target.value)}
                placeholder="Każdy klucz w nowej linii..."
                style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--accent)", borderRadius:8, padding:"10px", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", resize:"vertical", minHeight:120, boxSizing:"border-box", marginBottom:8 }}
              />
              <div style={{ display:"flex", gap:6, justifyContent:"flex-end" }}>
                <button className="btn" style={{ padding:"6px 14px", fontSize:11 }} onClick={() => setEditingKeys(false)}>Anuluj</button>
                <button className="btn btn-primary" style={{ padding:"6px 14px", fontSize:11 }}
                  onClick={() => { saveKeys(keysDraft); setEditingKeys(false); }}>Zapisz zmiany</button>
              </div>
            </div>
          )}

          {showKeysHistory && keysData.history.length > 0 && (
            <div style={{ marginTop:12, paddingTop:12, borderTop:"1px solid var(--border)" }}>
              <div style={{ fontSize:10, color:"var(--text2)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:8 }}>Historia zmian kluczy</div>
              {keysData.history.slice().reverse().map((h, i) => (
                <div key={i} style={{ padding:"8px 0", borderBottom:"1px solid var(--border)", fontSize:12 }}>
                  <div style={{ color:"var(--text)", whiteSpace:"pre-line", lineHeight:1.5 }}>{h.text || "(puste)"}</div>
                  <div style={{ fontSize:10, color:"var(--text2)", marginTop:4, opacity:0.7 }}>
                    {h.changedBy && `${h.changedBy} · `}{new Date(h.changedAt).toLocaleDateString("pl-PL")} {new Date(h.changedAt).toLocaleTimeString("pl-PL", { hour:"2-digit", minute:"2-digit" })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── SMS (read-only + optional override dla managera) ── */}
      {tab === "sms" && (
        <div className="detail-section">
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12, flexWrap:"wrap", gap:8 }}>
            <div className="detail-section-title" style={{ marginBottom:0 }}>
              <Icon name="mail" size={14} />Szablon SMS
            </div>
            <span style={{
              fontSize:10, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase",
              padding:"4px 10px", borderRadius:6,
              background: hasOverride ? "rgba(245,158,11,0.15)" : `${APT_TYPE_COLORS[apt.status] || "var(--accent)"}22`,
              color: hasOverride ? "var(--yellow)" : (APT_TYPE_COLORS[apt.status] || "var(--accent)"),
            }}>
              {hasOverride ? "⚙ WŁASNY SZABLON" : `GLOBALNY · ${apt.status || "?"}`}
            </span>
          </div>

          <p style={{ fontSize:12, color:"var(--text2)", marginBottom:12, lineHeight:1.6 }}>
            {hasOverride
              ? "Ten apartament ma własny szablon nadpisujący globalny."
              : `Wyświetlany jest szablon globalny dla typu ${apt.status}. Zarządzaj globalnym szablonem w zakładce Ustawienia.`}
          </p>

          {!editingOverride ? (
            <>
              <div className="sms-template-box">
                {Settings.render(effectiveSmsTemplate, apt)}
              </div>
              <div style={{ display:"flex", gap:6, marginTop:10, flexWrap:"wrap" }}>
                <button className="btn btn-primary" style={{ padding:"8px 14px", fontSize:12 }} onClick={async () => {
                  const text = Settings.render(effectiveSmsTemplate, apt);
                  try {
                    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
                    setSmsCopied(true);
                    setTimeout(() => setSmsCopied(false), 2000);
                  } catch {}
                }}>📋 {smsCopied ? "Skopiowano!" : "Kopiuj"}</button>
                {canEdit && (
                  <button className="btn" style={{ padding:"8px 14px", fontSize:12 }} onClick={startOverride}>
                    {hasOverride ? "✏ Edytuj" : "✏ Nadpisz"}
                  </button>
                )}
                {canEdit && hasOverride && (
                  <button className="btn" style={{ padding:"8px 14px", fontSize:12, background:"rgba(239,68,68,0.12)", color:"var(--red)" }} onClick={removeOverride}>
                    ↺ Globalny
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <SmsVariablesPanel onInsert={insertOverrideVar} />
              <textarea
                ref={overrideTaRef}
                value={overrideDraft}
                onChange={e => setOverrideDraft(e.target.value)}
                style={{ width:"100%", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, padding:"12px", color:"var(--text)", fontSize:13, fontFamily:"var(--font-body)", lineHeight:1.7, resize:"vertical", minHeight:200, boxSizing:"border-box", marginTop:8 }}
              />
              <div style={{ display:"flex", gap:8, marginTop:10 }}>
                <button className="btn btn-primary" style={{ flex:1 }} onClick={saveOverride}>✓ Zapisz jako własny</button>
                <button className="btn" style={{ flex:1 }} onClick={() => setEditingOverride(false)}>Anuluj</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── WYPOSAŻENIE — pogrupowane po kategorii + formularz dodawania ── */}
      {/* FIX 6.1 — wyposażenie: domyślnie read-only, edycja przez modal (przycisk "✏ Edytuj"). */}
      {tab === "equip" && (
        <div className="detail-section">
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, flexWrap:"wrap", marginBottom:8 }}>
            <div className="detail-section-title" style={{ marginBottom:0 }}><Icon name="check" size={14} />Lista wyposażenia</div>
            {canEdit && (
              <button className="btn btn-primary" style={{ padding:"8px 14px", fontSize:12 }} onClick={() => setEditKind("equip")}>
                ✏ Edytuj wyposażenie
              </button>
            )}
          </div>
          <p style={{ fontSize:12, color:"var(--text2)", marginBottom:12 }}>
            Standardowa lista wg załącznika NR 5 · {equipment.length} pozycji
          </p>

          {equipment.length === 0 && <p style={{ color:"var(--text2)", fontSize:14, textAlign:"center", padding:"20px 0" }}>Brak pozycji.</p>}

          {/* Grupowanie po kategorii (read-only) */}
          {(() => {
            const byCat = equipment.reduce((acc, item) => {
              const k = item.cat || "Inne";
              if (!acc[k]) acc[k] = [];
              acc[k].push(item);
              return acc;
            }, {});
            const catOrder = [...EquipmentRooms.namesForApt(apt.id), "Niestandardowe", "Inne"];
            const sortedCats = Object.keys(byCat).sort((a, b) => {
              const ia = catOrder.indexOf(a), ib = catOrder.indexOf(b);
              return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
            });
            // FIX 1.7 — pozycje wypożyczone z tego apartamentu (aktywne pożyczki wychodzące).
            const activeOut = (loans || []).filter(l => l.status === "active" && l.fromAptId === apt.id);
            const normName = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
            const namesMatch = (a, b) => {
              const x = normName(a), y = normName(b);
              if (!x || !y) return false;
              if (x === y) return true;
              const [short, long] = x.length <= y.length ? [x, y] : [y, x];
              return short.length >= 3 && long.includes(short);
            };
            const loanForItem = (name) =>
              activeOut.find(l => (l.items || []).some(it => namesMatch(it.name, name))) || null;
            const aptNameById = (id) => ((apartments || []).find(a => a.id === id) || {}).name || "inny apartament";
            return sortedCats.map(cat => (
              <div key={cat} style={{ marginBottom:16 }}>
                <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:6, paddingBottom:4, borderBottom:"1px solid var(--border)" }}>
                  {cat} ({byCat[cat].length})
                </div>
                {byCat[cat].map(item => {
                  const loan = loanForItem(item.name);
                  return (
                    <div key={item.id} className="inventory-row">
                      <div style={{ flex:1, minWidth:0, display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                        <span style={{ fontSize:14, opacity: loan ? 0.6 : 1 }}>{item.name}</span>
                        {loan && (
                          <button
                            type="button"
                            onClick={() => setTab("loans")}
                            title={`Wypożyczone od ${loan.borrowedAt ? loan.borrowedAt.slice(0,10) : "—"}${loan.returnedAt ? ` do ${loan.returnedAt.slice(0,10)}` : " (brak planowanej daty zwrotu)"}`}
                            style={{ display:"inline-flex", alignItems:"center", gap:4, fontSize:10, fontWeight:700, letterSpacing:"0.04em", padding:"2px 8px", borderRadius:6, background:"rgba(245,158,11,0.15)", color:"var(--yellow)", border:"1px solid rgba(245,158,11,0.3)", cursor:"pointer", whiteSpace:"nowrap" }}
                          >🔄 Wypożyczone do {aptNameById(loan.toAptId)}</button>
                        )}
                      </div>
                      <span style={{ fontSize:14, fontWeight:700, color:"var(--text)", padding:"2px 10px", background:"var(--surface2)", borderRadius:6, minWidth:32, textAlign:"center" }}>×{item.qty}</span>
                    </div>
                  );
                })}
              </div>
            ));
          })()}
        </div>
      )}

      {/* FIX 6.2 — tekstylia: domyślnie read-only, edycja przez modal (przycisk "✏ Edytuj"). */}
      {tab === "textiles" && (
        <div className="detail-section">
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, flexWrap:"wrap", marginBottom:8 }}>
            <div className="detail-section-title" style={{ marginBottom:0 }}><Icon name="star" size={14} />Lista tekstyliów</div>
            {canEdit && (
              <button className="btn btn-primary" style={{ padding:"8px 14px", fontSize:12 }} onClick={() => setEditKind("text")}>
                ✏ Edytuj tekstylia
              </button>
            )}
          </div>
          <p style={{ fontSize:12, color:"var(--text2)", marginBottom:12 }}>
            Standardowa lista wg Wykazu Tekstyliów · apartament {apt.capacity}-osobowy · {textiles.length} pozycji
          </p>

          {textiles.length === 0 && <p style={{ color:"var(--text2)", fontSize:14, textAlign:"center", padding:"20px 0" }}>Brak pozycji.</p>}
          {textiles.map(item => (
            <div key={item.id} className="inventory-row">
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:14 }}>{item.name}</div>
                {item.size && <div style={{ fontSize:11, color:"var(--text2)", marginTop:2 }}>Rozmiar: {item.size}</div>}
              </div>
              <span style={{ fontSize:14, fontWeight:700, color:"var(--text)", padding:"2px 10px", background:"var(--surface2)", borderRadius:6, minWidth:32, textAlign:"center" }}>×{item.qty}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── ZAMÓWIENIA TEKSTYLIÓW — multi-item + dropdown standardowych pozycji ── */}
      {tab === "orders" && (
        <div className="detail-section">
          <div className="detail-section-title"><Icon name="sync" size={14} />Zamówienia tekstyliów</div>
          <p style={{ fontSize:12, color:"var(--text2)", marginBottom:12 }}>
            Zamówienia dla <strong style={{ color:"var(--text)" }}>{apt.name}</strong>. Możesz dodać wiele pozycji w jednym zamówieniu.
          </p>

          {canEdit && (
            <div style={{ padding:14, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, marginBottom:16 }}>
              <div style={{ fontSize:11, color:"var(--text2)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:12 }}>
                Nowe zamówienie
              </div>

              {newOrder.items.map((line, idx) => (
                <div key={idx} style={{ display:"flex", gap:6, marginBottom:8, flexWrap:"wrap" }}>
                  <div style={{ flex:"2 1 180px", minWidth:140, position:"relative" }}>
                    <input
                      className="form-input"
                      list={`order-items-${idx}`}
                      placeholder="Wybierz z listy lub wpisz własną..."
                      value={line.itemName}
                      onChange={e => updateOrderLine(idx, { itemName: e.target.value })}
                      style={{ width:"100%" }}
                    />
                    <datalist id={`order-items-${idx}`}>
                      {getOrderItems().map(name => <option key={name} value={name} />)}
                    </datalist>
                  </div>
                  <NumberInput
                    className="form-input"
                    style={{ width:70 }}
                    steppers={false}
                    min={1}
                    placeholder="szt."
                    value={line.qty}
                    onChange={v => updateOrderLine(idx, { qty: v })}
                  />
                  {newOrder.items.length > 1 && (
                    <button
                      onClick={() => removeOrderLine(idx)}
                      style={{ background:"rgba(239,68,68,0.1)", border:"none", borderRadius:8, padding:"0 12px", color:"var(--red)", cursor:"pointer" }}
                      title="Usuń linię"
                    >−</button>
                  )}
                </div>
              ))}

              <button
                onClick={addOrderLine}
                style={{ background:"none", border:"1px dashed var(--border)", borderRadius:8, padding:"8px 12px", color:"var(--text2)", fontSize:12, fontWeight:600, cursor:"pointer", marginBottom:10, width:"100%" }}
              >+ Dodaj kolejną pozycję</button>

              <textarea
                className="form-input"
                placeholder="Notatki do całego zamówienia (opcjonalnie)..."
                value={newOrder.notes}
                onChange={e => setNewOrder(o => ({ ...o, notes: e.target.value }))}
                style={{ width:"100%", minHeight:50, resize:"vertical", marginBottom:10, fontFamily:"var(--font-body)", boxSizing:"border-box" }}
              />
              <button
                className="btn btn-primary"
                disabled={!newOrder.items.some(l => l.itemName.trim())}
                onClick={addOrder}
                style={{ width:"100%" }}
              >✓ Złóż zamówienie</button>
            </div>
          )}

          {orders.length === 0 ? (
            <p style={{ color:"var(--text2)", fontSize:14, textAlign:"center", padding:"20px 0" }}>Brak zamówień dla tego apartamentu</p>
          ) : orders.map(order => {
            const st = ORDER_STATUS[order.status] || ORDER_STATUS.waiting;
            // Wspieramy oba formaty: nowy (items[]) i stary (itemName/qty)
            const lines = order.items || (order.itemName ? [{ itemName: order.itemName, qty: order.qty || 1 }] : []);
            return (
              <div key={order.id} style={{ background:"var(--surface2)", border:`1px solid ${st.color}33`, borderLeft:`3px solid ${st.color}`, borderRadius:10, padding:12, marginBottom:8 }}>
                <div style={{ display:"flex", alignItems:"flex-start", gap:10, marginBottom:8 }}>
                  <div style={{ flex:1 }}>
                    {lines.map((line, i) => (
                      <div key={i} style={{ fontSize:14, fontWeight:600, marginBottom:2 }}>
                        {line.itemName} <span style={{ color:"var(--text2)", fontWeight:400 }}>× {line.qty}</span>
                      </div>
                    ))}
                    <div style={{ fontSize:10, color:"var(--text2)", marginTop:4 }}>
                      Dodano: {order.createdAt && order.createdAt.slice(0,10)}
                      {order.updatedAt && order.updatedAt !== order.createdAt && ` · Aktualizacja: ${order.updatedAt.slice(0,10)}`}
                    </div>
                  </div>
                  {canEdit && (
                    <button
                      onClick={() => deleteOrder(order.id)}
                      title="Usuń"
                      style={{ background:"rgba(239,68,68,0.1)", border:"none", borderRadius:8, padding:"6px 8px", cursor:"pointer", color:"var(--red)", flexShrink:0 }}
                    ><Icon name="trash" size={12} /></button>
                  )}
                </div>

                {order.notes && (
                  <div style={{ fontSize:12, color:"var(--text2)", fontStyle:"italic", marginBottom:8, paddingLeft:10, borderLeft:"2px solid var(--border)" }}>
                    "{order.notes}"
                  </div>
                )}

                <button
                  onClick={() => canEdit && cycleOrderStatus(order.id)}
                  disabled={!canEdit}
                  style={{
                    width:"100%",
                    background:`${st.color}22`,
                    border:`1px solid ${st.color}`,
                    borderRadius:8,
                    padding:"8px 12px",
                    color:st.color,
                    fontSize:11,
                    fontWeight:700,
                    letterSpacing:"0.08em",
                    textTransform:"uppercase",
                    cursor: canEdit ? "pointer" : "default",
                    display:"flex",
                    alignItems:"center",
                    justifyContent:"center",
                    gap:8,
                    opacity: canEdit ? 1 : 0.85,
                  }}
                  title={canEdit ? "Kliknij aby zmienić status" : ""}
                >
                  <div style={{ width:8, height:8, borderRadius:"50%", background:st.color }} />
                  {st.label}
                  {canEdit && <span style={{ marginLeft:"auto", fontSize:9, opacity:0.7, fontWeight:600 }}>zmień →</span>}
                </button>
              </div>
            );
          })}
        </div>
      )}


      {/* Modal potwierdzenia usunięcia pozycji przy qty=0 */}
      {confirmDelete && (
        <ConfirmModal
          open
          variant="danger"
          title="Usunąć pozycję?"
          message={<>Ilość pozycji <strong style={{ color:"var(--text)" }}>{confirmDelete.item.name}</strong> ma zostać zmniejszona do 0.<br /><br />Czy chcesz całkowicie usunąć tę pozycję z listy?</>}
          confirmLabel="Usuń pozycję"
          onClose={() => setConfirmDelete(null)}
          onConfirm={confirmDeleteItem}
        />
      )}

      {/* FIX 6.1/6.2/6.3 — Modal edycji wyposażenia/tekstyliów (wspólny). */}
      {editKind && (() => {
        const kind = editKind;
        const isEquip = kind === "equip";
        const items   = isEquip ? equipment : textiles;
        const field   = isEquip ? "equip" : "text";
        const roomsForApt = isEquip ? EquipmentRooms.forApt(apt.id) : [];
        // Roomrefresh zmusza re-render listy pomieszczeń (nieużywane bezpośrednio, ale przeczytanie wymusza ślad).
        void roomRefresh;
        return (
          <FloatingModal open onClose={() => setEditKind(null)} title={isEquip ? "Edycja wyposażenia" : "Edycja tekstyliów"} size="lg">
            {/* ── Sekcja: dodawanie nowej pozycji ── */}
            <div style={{ padding:14, background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:10, marginBottom:16 }}>
              <div style={{ fontSize:11, color:"var(--text2)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:10 }}>
                + Dodaj nową pozycję
              </div>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                {isEquip && (
                  <select
                    className="form-select"
                    style={{ flex:"1 1 160px", minWidth:140, fontSize:12 }}
                    value={newItemCat}
                    onChange={e => setNewItemCat(e.target.value)}
                  >
                    {[...EquipmentRooms.namesForApt(apt.id), "Niestandardowe"].filter((v,i,a) => a.indexOf(v) === i).map(c =>
                      <option key={c} value={c}>{c}</option>
                    )}
                  </select>
                )}
                <input
                  className="form-input"
                  style={{ flex:"2 1 140px", minWidth:120 }}
                  placeholder={isEquip ? "Nazwa (np. Zegar ścienny)" : "Nazwa (np. Pled dekoracyjny)"}
                  value={newItemName[field]}
                  onChange={e => setNewItemName(s => ({ ...s, [field]: e.target.value }))}
                  onKeyDown={e => { if (e.key === "Enter") addInventoryItem(kind); }}
                />
                {!isEquip && (
                  <input
                    className="form-input"
                    style={{ width:100 }}
                    placeholder="Rozmiar"
                    value={newItemSize}
                    onChange={e => setNewItemSize(e.target.value)}
                  />
                )}
                <NumberInput
                  className="form-input"
                  style={{ width:80 }}
                  steppers={false}
                  min={1}
                  placeholder="szt."
                  value={newItemQty[field]}
                  onChange={v => setNewItemQty(s => ({ ...s, [field]: v }))}
                />
                <button
                  className="btn btn-primary"
                  style={{ padding:"10px 20px", fontWeight:600 }}
                  disabled={!(newItemName[field] || "").trim()}
                  onClick={() => addInventoryItem(kind)}
                >+ Dodaj</button>
              </div>
            </div>

            {/* ── Sekcja: lista pozycji ── */}
            <div style={{ fontSize:11, color:"var(--text2)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:10 }}>
              Pozycje ({items.length})
            </div>
            {items.length === 0 ? (
              <p style={{ color:"var(--text2)", fontSize:13, textAlign:"center", padding:"16px 0" }}>Brak pozycji.</p>
            ) : (
              <div style={{ marginBottom: isEquip ? 20 : 0 }}>
                {items.map(item => (
                  <div key={item.id} className="inventory-row" style={{ alignItems:"center" }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:14 }}>{item.name}</div>
                      {isEquip
                        ? <div style={{ fontSize:11, color:"var(--text2)", marginTop:2 }}>{item.cat || "Inne"}</div>
                        : (item.size && <div style={{ fontSize:11, color:"var(--text2)", marginTop:2 }}>Rozmiar: {item.size}</div>)
                      }
                    </div>
                    <NumberInput
                      className="form-input"
                      style={{ width:80 }}
                      steppers
                      min={0}
                      value={item.qty}
                      onChange={v => setItemQty(kind, item.id, v)}
                    />
                    <button
                      onClick={() => askDeleteItem(kind, item)}
                      title="Usuń pozycję"
                      style={{ marginLeft:8, background:"rgba(239,68,68,0.12)", border:"none", borderRadius:8, padding:"8px 10px", color:"var(--red)", cursor:"pointer" }}
                    ><Icon name="trash" size={12} /></button>
                  </div>
                ))}
              </div>
            )}

            {/* ── FIX 6.3 — Sekcja Pomieszczeń (tylko dla wyposażenia) — wyraźnie oddzielona ── */}
            {isEquip && (
              <div style={{ marginTop:16, padding:14, background:"rgba(16,185,129,0.06)", border:"1px solid rgba(16,185,129,0.3)", borderRadius:10 }}>
                <div style={{ fontSize:11, color:"var(--green)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:10, display:"flex", alignItems:"center", gap:6 }}>
                  <Icon name="building" size={12} />Pomieszczenia ({roomsForApt.length})
                </div>
                <p style={{ fontSize:11, color:"var(--text2)", marginBottom:10, lineHeight:1.5 }}>
                  Pomieszczenia służą do grupowania pozycji wyposażenia. Globalne są wspólne dla wszystkich apartamentów, lokalne — tylko dla {apt.name}.
                </p>

                {roomsForApt.length > 0 && (
                  <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, overflow:"hidden", marginBottom:10 }}>
                    {roomsForApt.map(room => (
                      <div key={room.id} style={{ padding:"8px 12px", borderBottom:"1px solid var(--border)", display:"flex", alignItems:"center", gap:8 }}>
                        <span style={{ flex:1, fontSize:13 }}>{room.name}</span>
                        {room.builtin && <span style={{ fontSize:9, fontWeight:700, letterSpacing:"0.08em", padding:"2px 6px", borderRadius:4, background:"rgba(59,130,246,0.12)", color:"var(--accent)" }}>WBUDOWANA</span>}
                        {!room.builtin && !room.aptId && <span style={{ fontSize:9, fontWeight:700, letterSpacing:"0.08em", padding:"2px 6px", borderRadius:4, background:"rgba(16,185,129,0.12)", color:"var(--green)" }}>GLOBALNA</span>}
                        {!room.builtin && room.aptId && <span style={{ fontSize:9, fontWeight:700, letterSpacing:"0.08em", padding:"2px 6px", borderRadius:4, background:"rgba(245,158,11,0.12)", color:"var(--yellow)" }}>LOKALNA</span>}
                        {!room.builtin && (
                          <button onClick={() => setConfirmRoomDelete(room)} title="Usuń pomieszczenie" style={{ background:"rgba(239,68,68,0.12)", border:"none", borderRadius:6, padding:"4px 8px", cursor:"pointer", color:"var(--red)", fontSize:11, fontWeight:700 }}>🗑</button>
                        )}
                        {room.builtin && (
                          <button onClick={() => { setRoomDeleteText(""); setRoomDeleteStep1(room); }} title="Usuń wbudowane (podwójne potwierdzenie)" style={{ background:"var(--red)", border:"none", borderRadius:6, padding:"4px 8px", cursor:"pointer", color:"#fff", fontSize:11, fontWeight:700 }}>🗑</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                  <input
                    className="form-input"
                    style={{ flex:"1 1 180px", minWidth:140 }}
                    placeholder="Nazwa nowego pomieszczenia (np. Garderoba)"
                    value={newRoomInModal}
                    onChange={e => setNewRoomInModal(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") addRoomInModal(); }}
                  />
                  <button
                    className="btn"
                    style={{ background:"var(--green)", color:"#fff", border:"none", padding:"10px 16px", fontWeight:700 }}
                    disabled={!newRoomInModal.trim()}
                    onClick={addRoomInModal}
                  >+ Dodaj pomieszczenie</button>
                </div>
              </div>
            )}

            <div className="btn-row" style={{ marginTop:20 }}>
              <button className="btn btn-primary" style={{ flex:1 }} onClick={() => setEditKind(null)}>Zamknij</button>
            </div>
          </FloatingModal>
        );
      })()}

      {/* FIX 6.3 — pomieszczenie non-builtin: pojedyncze potwierdzenie */}
      {confirmRoomDelete && (
        <ConfirmModal
          open
          variant="danger"
          title="Usunąć pomieszczenie?"
          message={<>Pomieszczenie <strong style={{ color:"var(--text)" }}>{confirmRoomDelete.name}</strong> zostanie usunięte. Pozycje wyposażenia przypisane do tego pomieszczenia zachowają swoją kategorię w danych (mogą trafić do „Inne" w wyświetlaniu).</>}
          confirmLabel="Usuń"
          onClose={() => setConfirmRoomDelete(null)}
          onConfirm={() => doDeleteRoom(confirmRoomDelete)}
        />
      )}

      {/* FIX 6.3 + 3.A — krok 1: ostrzeżenie przed usunięciem wbudowanego pomieszczenia */}
      {roomDeleteStep1 && (
        <ConfirmModal
          open
          variant="danger"
          title="Czy na pewno chcesz usunąć wbudowane pomieszczenie?"
          message={<>
            <strong style={{ color:"var(--text)" }}>{roomDeleteStep1.name}</strong> to pomieszczenie wbudowane (domyślna konfiguracja). Usunięcie spowoduje, że:<br /><br />
            • Pomieszczenie zniknie u WSZYSTKICH apartamentów<br />
            • Pozycje wyposażenia przypisane do niego zostaną przeniesione do „Niestandardowe"<br />
            • Operacja jest nieodwracalna<br /><br />
            Czy chcesz kontynuować?
          </>}
          confirmLabel="Tak, kontynuuj"
          onClose={() => setRoomDeleteStep1(null)}
          onConfirm={() => { const r = roomDeleteStep1; setRoomDeleteStep1(null); setRoomDeleteText(""); setRoomDeleteStep2(r); }}
        />
      )}

      {/* FIX 6.3 + 3.A — krok 2: przepisanie nazwy */}
      {roomDeleteStep2 && (
        <FloatingModal open onClose={() => { setRoomDeleteStep2(null); setRoomDeleteText(""); }} title="Ostateczne potwierdzenie" size="sm">
          <p style={{ fontSize:14, lineHeight:1.6, marginBottom:12 }}>
            Wpisz nazwę pomieszczenia poniżej, żeby potwierdzić usunięcie:<br />
            <strong style={{ color:"var(--red)" }}>{roomDeleteStep2.name}</strong>
          </p>
          <input
            className="form-input"
            autoFocus
            value={roomDeleteText}
            onChange={e => setRoomDeleteText(e.target.value)}
            placeholder="Wpisz dokładną nazwę…"
            style={{ width:"100%", boxSizing:"border-box", marginBottom:14 }}
            onKeyDown={e => { if (e.key === "Enter" && roomDeleteText === roomDeleteStep2.name) deleteBuiltinRoomFromModal(roomDeleteStep2); }}
          />
          <div className="btn-row" style={{ display:"flex", gap:10 }}>
            <button className="btn btn-ghost" style={{ flex:1 }} onClick={() => { setRoomDeleteStep2(null); setRoomDeleteText(""); }}>Anuluj</button>
            <button
              className="btn"
              disabled={roomDeleteText !== roomDeleteStep2.name}
              onClick={() => deleteBuiltinRoomFromModal(roomDeleteStep2)}
              style={{ flex:1, border:"none", fontWeight:700, background: roomDeleteText === roomDeleteStep2.name ? "var(--red)" : "var(--surface2)", color: roomDeleteText === roomDeleteStep2.name ? "#fff" : "var(--text2)", cursor: roomDeleteText === roomDeleteStep2.name ? "pointer" : "not-allowed" }}
            >Usuń definitywnie</button>
          </div>
        </FloatingModal>
      )}

      {/* ── POŻYCZKI (z/do tego apartamentu) — FIX 3.C: aktywne vs historia ── */}
      {tab === "loans" && (() => {
        const activeLoans  = aptLoans.filter(l => l.status === "active");
        const historyLoans = aptLoans.filter(l => l.status === "returned")
          .sort((a, b) => (b.returnedAt || "").localeCompare(a.returnedAt || ""));
        // Kierunek pożyczki względem tego apartamentu (wychodząca / przychodząca)
        const dirLabel = (loan) => loan.fromAptId === apt.id
          ? { icon:"📤", text:`Pożyczone DO: ${aptNameOf(loan.toAptId)}` }
          : { icon:"📥", text:`Pożyczone OD: ${aptNameOf(loan.fromAptId)}` };

        return (
        <div className="detail-section">
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12, gap:8, flexWrap:"wrap" }}>
            <div className="detail-section-title" style={{ marginBottom:0, display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
              <Icon name="swap" size={14} />Pożyczki wyposażenia
              <span style={{ fontSize:10, fontWeight:700, letterSpacing:"0.06em", padding:"2px 8px", borderRadius:20, background:"rgba(59,130,246,0.15)", color:"var(--accent)" }}>{activeLoans.length} aktywne</span>
              <span style={{ fontSize:10, fontWeight:700, letterSpacing:"0.06em", padding:"2px 8px", borderRadius:20, background:"var(--surface2)", color:"var(--text2)" }}>{historyLoans.length} w historii</span>
            </div>
            {canEdit && !showLoanForm && (
              <button className="btn btn-primary" onClick={() => setShowLoanForm(true)}>
                + Nowa pożyczka
              </button>
            )}
          </div>

          {/* Formularz nowej pożyczki z tego apt (FIX 3.B: tylko WOLNE wyposażenie tego apartamentu) */}
          {showLoanForm && canEdit && (
            <div style={{ padding:14, background:"var(--surface2)", border:"1px solid var(--accent)", borderRadius:10, marginBottom:16 }}>
              <div style={{ fontSize:11, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:12 }}>
                Wypożycz z {apt.name} do:
              </div>
              <div className="form-group">
                <label className="form-label">Do apartamentu *</label>
                <select className="form-select" value={loanForm.toAptId} onChange={e => setLoanForm(f => ({ ...f, toAptId: e.target.value }))}>
                  <option value="">— wybierz —</option>
                  {(apartments || []).filter(a => a.id !== apt.id).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Pozycje (tylko wolne wyposażenie tego apartamentu)</label>
                {/* FIX 1.7 + 3.B — pozycje ograniczone do wyposażenia TEGO apartamentu, z pominięciem
                    tych już aktywnie wypożyczonych. Nie da się wypożyczyć tego samego dwa razy. */}
                {availableEquipNames.length === 0 ? (
                  <div style={{ fontSize:12, color:"var(--text2)", padding:"8px 10px", background:"var(--surface)", border:"1px dashed var(--border)", borderRadius:8 }}>
                    Brak wolnego wyposażenia do pożyczenia z tego apartamentu (wszystko jest już wypożyczone albo lista wyposażenia jest pusta).
                  </div>
                ) : (
                  <>
                    {loanForm.items.map((item, idx) => {
                      const opts = item.name && !availableEquipNames.includes(item.name) ? [item.name, ...availableEquipNames] : availableEquipNames;
                      // FIX 9.1b — max ilość = dostępne w tym apartamencie
                      const avail = item.name ? availableQtyFor(item.name) : null;
                      return (
                      <div key={idx} style={{ display:"flex", gap:6, marginBottom:6 }}>
                        <select className="form-select" style={{ flex:1 }} value={item.name} onChange={e => updateLoanLine(idx, { name: e.target.value })}>
                          <option value="">— wybierz pozycję —</option>
                          {opts.map(n => <option key={n} value={n}>{n} (dostępne: {availableQtyFor(n)})</option>)}
                        </select>
                        <NumberInput className="form-input" style={{ width:70 }} steppers={false} min={1} max={avail || undefined} value={item.qty} onChange={v => updateLoanLine(idx, { qty: v })} />
                        {loanForm.items.length > 1 && <button onClick={() => removeLoanLine(idx)} style={{ background:"rgba(239,68,68,0.1)", border:"none", borderRadius:8, padding:"0 10px", color:"var(--red)", cursor:"pointer" }}>−</button>}
                      </div>
                      );
                    })}
                    <button onClick={addLoanLine} style={{ background:"none", border:"1px dashed var(--border)", borderRadius:8, padding:"6px 12px", color:"var(--text2)", fontSize:11, fontWeight:600, cursor:"pointer", width:"100%", marginTop:4 }}>+ Kolejna pozycja</button>
                  </>
                )}
              </div>
              <div className="form-group">
                <label className="form-label">Notatki</label>
                <input className="form-input" value={loanForm.notes} onChange={e => setLoanForm(f => ({ ...f, notes: e.target.value }))} placeholder="opcjonalnie..." />
              </div>
              {loanError && <div style={{ padding:"6px 10px", background:"rgba(239,68,68,0.12)", borderRadius:8, fontSize:12, color:"var(--red)", marginBottom:8, fontWeight:600 }}>{loanError}</div>}
              <div style={{ display:"flex", gap:8 }}>
                <button className="btn btn-primary" style={{ flex:1, fontSize:12, opacity: availableEquipNames.length === 0 ? 0.5 : 1, cursor: availableEquipNames.length === 0 ? "not-allowed" : "pointer" }} disabled={availableEquipNames.length === 0} onClick={submitLoan}>✓ Utwórz pożyczkę</button>
                <button className="btn" style={{ flex:1, fontSize:12 }} onClick={() => { setShowLoanForm(false); setLoanError(""); }}>Anuluj</button>
              </div>
            </div>
          )}

          {aptLoans.length === 0 && !showLoanForm ? (
            <p style={{ color:"var(--text2)", fontSize:14, textAlign:"center", padding:"20px 0" }}>
              Brak pożyczek. {canEdit ? "Kliknij \"+ Nowa pożyczka\" aby wypożyczyć wyposażenie." : ""}
            </p>
          ) : (
            <>
              {/* Toggle widoku: tylko aktywne / wszystkie */}
              <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:12 }}>
                <button
                  onClick={() => setLoansShowAll(v => !v)}
                  style={{ background:"none", border:"1px solid var(--border)", borderRadius:8, padding:"5px 12px", color:"var(--text2)", fontSize:11, fontWeight:700, cursor:"pointer" }}
                >{loansShowAll ? "Pokaż tylko aktywne" : "Pokaż wszystkie"}</button>
              </div>

              {/* SEKCJA 1 — AKTYWNE (wyróżnione akcentem po lewej) */}
              <div style={{ fontSize:10, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:8 }}>
                Aktywne pożyczki ({activeLoans.length})
              </div>
              {activeLoans.length === 0 && (
                <p style={{ color:"var(--text2)", fontSize:13, padding:"4px 0 12px" }}>Brak aktywnych pożyczek.</p>
              )}
              {activeLoans.map(loan => {
                const d = dirLabel(loan);
                return (
                  <div key={loan.id} style={{ background:"var(--surface2)", border:"1px solid rgba(59,130,246,0.25)", borderLeft:"3px solid var(--accent)", borderRadius:10, padding:14, marginBottom:8 }}>
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, marginBottom:8, flexWrap:"wrap" }}>
                      <div style={{ fontSize:13, fontWeight:700 }}>
                        {loan.items.map(it => `${it.name} × ${it.qty}`).join(", ")}
                      </div>
                      <span style={{ fontSize:10, fontWeight:700, padding:"2px 8px", borderRadius:4, background:"rgba(245,158,11,0.15)", color:"var(--yellow)" }}>AKTYWNA</span>
                    </div>
                    <div style={{ borderTop:"1px solid var(--border)", paddingTop:8, fontSize:12, color:"var(--text2)", lineHeight:1.8 }}>
                      <div>{d.icon} {d.text}</div>
                      {loan.createdBy && <div>👤 Wzięte przez: {loan.createdBy}</div>}
                      <div>📅 Od: {loan.borrowedAt && loan.borrowedAt.slice(0,10)}</div>
                      {loan.notes && <div>📝 Notatka: „{loan.notes}"</div>}
                    </div>
                    {canEdit && (
                      <div style={{ display:"flex", gap:8, marginTop:10 }}>
                        <button onClick={() => openReturnModal(loan)} style={{ flex:1, background:"rgba(34,197,94,0.15)", color:"var(--green)", border:"1px solid rgba(34,197,94,0.3)", borderRadius:8, padding:"8px 12px", fontSize:11, fontWeight:700, letterSpacing:"0.06em", cursor:"pointer" }}>✓ Oznacz jako zwrócone</button>
                        {isManager && (
                          <button onClick={() => deleteLoanFromDetail(loan.id)} title="Usuń pożyczkę" style={{ background:"rgba(239,68,68,0.1)", border:"1px solid rgba(239,68,68,0.3)", borderRadius:8, padding:"6px 10px", cursor:"pointer", color:"var(--red)" }}><Icon name="trash" size={12} /></button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* SEKCJA 2 — HISTORIA ZWROTÓW (domyślnie zwinięta) */}
              {loansShowAll && (
                <div style={{ marginTop:16 }}>
                  <button
                    onClick={() => setLoanHistoryOpen(v => !v)}
                    style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"space-between", background:"var(--surface2)", border:"1px solid var(--border)", borderRadius:8, padding:"8px 12px", cursor:"pointer", color:"var(--text2)", fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase" }}
                  >
                    <span>Historia zwrotów ({historyLoans.length})</span>
                    <span>{loanHistoryOpen ? "▲ zwiń" : "▼ rozwiń"}</span>
                  </button>
                  {loanHistoryOpen && (
                    historyLoans.length === 0 ? (
                      <p style={{ color:"var(--text2)", fontSize:13, padding:"10px 0" }}>Brak zwróconych pożyczek.</p>
                    ) : (
                      <div style={{ marginTop:8 }}>
                        {historyLoans.map(loan => {
                          const d = dirLabel(loan);
                          return (
                            <div key={loan.id} style={{ background:"var(--surface)", border:"1px solid var(--border)", borderLeft:"3px solid var(--green)", borderRadius:8, padding:"10px 12px", marginBottom:6, fontSize:12 }}>
                              <div style={{ display:"flex", justifyContent:"space-between", gap:8, flexWrap:"wrap" }}>
                                <span style={{ fontWeight:600 }}>{loan.items.map(it => `${it.name} × ${it.qty}`).join(", ")}</span>
                                <span style={{ color:"var(--text2)" }}>{d.text}</span>
                              </div>
                              <div style={{ color:"var(--text2)", marginTop:4 }}>
                                {loan.borrowedAt && loan.borrowedAt.slice(0,10)} – {loan.returnedAt && loan.returnedAt.slice(0,10)}
                                {loan.returnNote && <> · 📝 „{loan.returnNote}"</>}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )
                  )}
                </div>
              )}
            </>
          )}
        </div>
        );
      })()}

      {/* FIX 3.C — modal oznaczania pożyczki jako zwróconej */}
      {returnModal && (
        <FloatingModal open onClose={() => setReturnModal(null)} title="Oznacz pożyczkę jako zwróconą" size="sm">
          <p style={{ fontSize:14, lineHeight:1.6, marginBottom:14 }}>
            {returnModal.items.map(it => `${it.name} × ${it.qty}`).join(", ")} — pożyczone z <strong style={{ color:"var(--text)" }}>{aptNameOf(returnModal.fromAptId)}</strong> do <strong style={{ color:"var(--text)" }}>{aptNameOf(returnModal.toAptId)}</strong> dnia {returnModal.borrowedAt && returnModal.borrowedAt.slice(0,10)}.<br />
            Czy element wrócił do <strong style={{ color:"var(--text)" }}>{aptNameOf(returnModal.fromAptId)}</strong>?
          </p>
          <div className="form-group">
            <label className="form-label">Data zwrotu</label>
            <input type="date" className="form-input" value={returnDate} onChange={e => setReturnDate(e.target.value)} style={{ width:"100%", boxSizing:"border-box" }} />
          </div>
          <div className="form-group">
            <label className="form-label">Notatka (opcjonalna)</label>
            <textarea className="form-textarea" value={returnNote} onChange={e => setReturnNote(e.target.value)} placeholder="np. stan dobry, zwrócone osobiście..." />
          </div>
          <div className="btn-row" style={{ display:"flex", gap:10 }}>
            <button className="btn btn-ghost" style={{ flex:1 }} onClick={() => setReturnModal(null)}>Anuluj</button>
            <button className="btn btn-primary" style={{ flex:1 }} disabled={!returnDate} onClick={confirmReturn}>Potwierdź zwrot</button>
          </div>
        </FloatingModal>
      )}

      {/* ── ZADANIA ── */}
      {tab === "zadania" && (
        <div className="content" style={{ paddingTop:8 }}>
          {/* Filter chips */}
          <div className="filter-row" style={{ marginBottom:12 }}>
            {["Wszystkie","W trakcie","Nie rozpoczęto","Zrobione"].map(f => (
              <div key={f} className={`filter-chip ${taskFilter === f ? "active" : ""}`} onClick={() => setTaskFilter(f)}>{f}</div>
            ))}
          </div>
          {canAddTask && <button className="btn btn-primary" style={{ marginBottom:16 }} onClick={onAddTask}>+ Dodaj zadanie</button>}
          {aptTasks.length === 0 ? (
            <div className="empty"><div className="empty-icon"><Icon name="tasks" size={40} /></div><h3>Brak zadań</h3></div>
          ) : aptTasks.map(t => (
            <div key={t.id} className="task-card" onClick={() => onSelectTask && onSelectTask(t)}>
              <div className="task-card-header">
                <div style={{ flex:1 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", marginBottom:6 }}>
                    <PriorityTile priority={t.priority} />
                    <TaskStatusBadge status={t.status} />
                  </div>
                  <div className="task-title">{t.title}</div>
                </div>
                <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:6 }}>
                  <div className="avatar" style={{ width:28, height:28, fontSize:12 }}>{t.assignedTo && t.assignedTo[0] || "?"}</div>
                  <span style={{ fontSize:10, color:"var(--text2)", fontWeight:600 }}>{t.assignedTo}</span>
                </div>
              </div>
              {t.nextCheckout && (
                <div className="task-meta">
                  <span style={{ fontSize:11, color:"var(--green)", display:"flex", alignItems:"center", gap:4 }}>
                    <Icon name="calendar" size={11} color="var(--green)" />Wyjazd: {t.nextCheckout.slice(0,10)}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── HISTORIA SPRZĄTANIA ── */}
      {tab === "historia" && (
        <div className="detail-section">
          <div className="detail-section-title"><Icon name="calendar" size={14} />Historia sprzątania</div>
          {aptHistory.length === 0 ? (
            <p style={{ color:"var(--text2)", fontSize:14 }}>Brak historii sprzątania dla tego apartamentu.</p>
          ) : aptHistory.map(s => {
            const statusColor = { planned:"var(--text2)", in_progress:"var(--accent)", done:"var(--green)" };
            const statusLabel = { planned:"Zaplanowane", in_progress:"W trakcie", done:"Ukończone" };
            return (
              <div key={s.id} className="history-row">
                <div>
                  <div className="history-date">{s.date}</div>
                  <div className="history-person">{s.assignedTo || "—"}</div>
                  {s.notes && <div style={{ fontSize:11, color:"var(--text2)", fontStyle:"italic", marginTop:2 }}>"{s.notes}"</div>}
                </div>
                <div style={{ marginLeft:"auto", display:"flex", flexDirection:"column", alignItems:"flex-end", gap:4 }}>
                  <span className="history-status-badge" style={{ background:`${statusColor[s.status]}22`, color:statusColor[s.status] }}>{statusLabel[s.status]}</span>
                  {s.durationSec > 0 && <div className="history-duration">{CleaningSessions.formatDuration(s.durationSec)}</div>}
                  {s.finishedAt && <div style={{ fontSize:10, color:"var(--text2)" }}>{s.finishedAt.slice(11,16)}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── PLIKI (FIX 2.C) — pliki przypisane do tego apartamentu ── */}
      {tab === "pliki" && (
        <div className="detail-section">
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16, gap:12 }}>
            <div className="detail-section-title" style={{ marginBottom:0 }}><Icon name="file" size={14} />Pliki apartamentu</div>
            {canEdit && (
              <button className="btn btn-primary" style={{ width:"auto", padding:"6px 14px", fontSize:11 }} onClick={() => setShowFileForm(true)}>+ Dodaj plik</button>
            )}
          </div>
          {apartmentFiles.length === 0 ? (
            <div className="empty" style={{ padding:"32px 20px" }}>
              <div className="empty-icon"><Icon name="file" size={40} /></div>
              <h3>Brak plików</h3>
              <p style={{ color:"var(--text2)", fontSize:13, marginTop:4 }}>Brak plików dla tego apartamentu.</p>
              {canEdit && <button className="btn btn-primary" style={{ marginTop:16, width:"auto", padding:"10px 18px" }} onClick={() => setShowFileForm(true)}>+ Dodaj plik</button>}
            </div>
          ) : (
            FILE_CATEGORIES.filter(cat => apartmentFiles.some(f => (f.category || "other") === cat.id)).map(cat => {
              const catFiles = apartmentFiles.filter(f => (f.category || "other") === cat.id);
              const color = FILE_CAT_COLORS[cat.id] || "var(--text2)";
              return (
                <div key={cat.id} style={{ marginBottom:18 }}>
                  <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", color, marginBottom:8 }}>{cat.label} ({catFiles.length})</div>
                  {catFiles.map(f => (
                    <div key={f.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 12px", background:"var(--surface)", border:"1px solid var(--border)", borderLeft:`3px solid ${color}`, borderRadius:10, marginBottom:8 }}>
                      <Icon name="file" size={16} color={color} />
                      <a href={f.url} target="_blank" rel="noopener noreferrer" style={{ flex:1, minWidth:0, textDecoration:"none", color:"var(--text)" }}>
                        <div style={{ fontSize:13, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{f.name}</div>
                        <div style={{ fontSize:11, color:"var(--text2)", marginTop:2 }}>
                          {f.addedAt && `dodano ${f.addedAt.slice(0,10)}`}{f.addedBy && ` · ${f.addedBy}`}
                        </div>
                        {f.description && <div style={{ fontSize:11, color:"var(--text2)", marginTop:2, fontStyle:"italic" }}>{f.description}</div>}
                      </a>
                      <a href={f.url} target="_blank" rel="noopener noreferrer" title="Otwórz w nowej karcie" style={{ color:"var(--accent)", display:"inline-flex", flexShrink:0 }}><Icon name="link" size={16} color="var(--accent)" /></a>
                      {currentUser && currentUser.role === ROLES.MANAGER && (
                        <button onClick={() => { Files.remove(f.id); onRefreshFiles && onRefreshFiles(); }}
                          style={{ background:"rgba(239,68,68,0.1)", border:"none", borderRadius:8, padding:"6px 8px", cursor:"pointer", color:"var(--red)", flexShrink:0 }} title="Usuń">
                          <Icon name="trash" size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              );
            })
          )}
        </div>
      )}

      {showFileForm && (
        <FileForm
          apartments={apartments}
          currentUser={currentUser}
          lockedAptId={apt.id}
          lockedAptName={apt.name}
          onClose={() => setShowFileForm(false)}
          onSaved={() => { onRefreshFiles && onRefreshFiles(); setShowFileForm(false); }}
        />
      )}
    </div>
  );
};

const TaskDetail = ({ task, apt, onBack, onEdit, onDelete, onComplete, onAccept, currentUser }) => {
  const isManager = currentUser && currentUser.role === ROLES.MANAGER;
  const canAct = currentUser && currentUser.role !== ROLES.CLEANING;
  const today = new Date().toISOString().slice(0, 10);

  const [showComplete, setShowComplete] = useState(false);
  const [acceptPerson, setAcceptPerson] = useState(currentUser && currentUser.name || "");
  const [protocol, setProtocol] = useState({
    executor: task.completionExecutor || currentUser && currentUser.name || "",
    notes: task.completionNotes || "",
    date: task.completedAt && task.completedAt.slice(0, 10) || today,
    timeSpent: task.completionTime || "",
    materials: task.completionMaterials || "",
    costNet: task.completionCost || "",
    photoLinks: task.completionPhotos || "",
  });

  const setP = (k, v) => setProtocol(p => ({ ...p, [k]: v }));
  const handleComplete = () => { onComplete && onComplete(task.id, protocol); setShowComplete(false); };
  const handleAccept = () => { onAccept && onAccept(task.id, acceptPerson); };

  const hasProtocol = task.status === "Zrobione" && (task.completionNotes || task.completionExecutor);

  // Time tracking calculations
  const timeDiff = (from, to) => {
    if (!from || !to) return null;
    const ms = new Date(to).getTime() - new Date(from).getTime();
    if (ms < 0) return null;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h > 24) { const d = Math.floor(h / 24); return `${d}d ${h % 24}h`; }
    return h > 0 ? `${h}h ${m}min` : `${m}min`;
  };
  const timeToAccept = timeDiff(task.createdAt, task.acceptedAt);
  const timeFromAccept = timeDiff(task.acceptedAt, task.completedAt);
  const totalTime = timeDiff(task.createdAt, task.completedAt);

  return (
    <div className="slide-up">
      {/* FIX 9.6 — jeden pasek (hero) z nazwą + statusem + akcjami (Edytuj/Wstecz). */}
      <div className="detail-hero">
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
          <button className="icon-btn" onClick={onBack} title="Wstecz"><Icon name="back" size={16} /></button>
          {apt && <div style={{ flex:1, fontSize: 11, color: "var(--accent)", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" }}>{apt.name}</div>}
          {isManager && (
            <>
              <button className="icon-btn" onClick={onEdit} title="Edytuj"><Icon name="edit" size={16} /></button>
              <button className="icon-btn" onClick={onDelete} title="Usuń" style={{ color: "var(--red)" }}><Icon name="trash" size={16} color="var(--red)" /></button>
            </>
          )}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", marginBottom: 8 }}>
          <PriorityTile priority={task.priority} />
          <TaskStatusBadge status={task.status} />
        </div>
        <h2 style={{ margin:0 }}>{task.title}</h2>
      </div>
      <div className="detail-section">
        <div className="detail-row"><span className="detail-label">Zlecono</span><span className="detail-value">{task.createdAt}</span></div>
        {task.orderBy && <div className="detail-row"><span className="detail-label">Zlecający</span><span className="detail-value">{task.orderBy}</span></div>}
        <div className="detail-row"><span className="detail-label">Przypisano do</span><span className="detail-value" style={{ display: "flex", alignItems: "center", gap: 8 }}><div className="avatar">{task.assignedTo[0]}</div>{task.assignedTo}</span></div>
        {task.nextCheckout && <div className="detail-row"><span className="detail-label">Wyjazd gości</span><span className="detail-value" style={{ color: "var(--green)" }}>➜ {task.nextCheckout}</span></div>}
        {task.nextCheckin && <div className="detail-row"><span className="detail-label">Przyjazd gości</span><span className="detail-value" style={{ color: "var(--accent2)" }}>➜ {task.nextCheckin}</span></div>}
        {task.notes && <div className="detail-row"><span className="detail-label">Notatki</span><span className="detail-value" style={{ whiteSpace:"pre-line" }}>{task.notes}</span></div>}
      </div>

      {/* Przyjęcie zlecenia — info */}
      {task.acceptedAt && (
        <div className="detail-section">
          <div className="detail-section-title"><Icon name="user" size={14} />Przyjęcie zlecenia</div>
          <div className="detail-row"><span className="detail-label">Przyjął</span><span className="detail-value" style={{ fontWeight:600 }}>{task.acceptedBy || "—"}</span></div>
          <div className="detail-row"><span className="detail-label">Data przyjęcia</span><span className="detail-value">{task.acceptedAt.slice(0,10)} {task.acceptedAt.slice(11,16)}</span></div>
          {timeToAccept && <div className="detail-row"><span className="detail-label">Czas do przyjęcia</span><span className="detail-value" style={{ color:"var(--yellow)" }}>{timeToAccept}</span></div>}
        </div>
      )}

      {/* Statystyki czasu (po ukończeniu) */}
      {task.status === "Zrobione" && (task.acceptedAt || task.completedAt) && (
        <div className="detail-section">
          <div className="detail-section-title"><Icon name="calendar" size={14} />Czas realizacji</div>
          {timeToAccept && <div className="detail-row"><span className="detail-label">Utworzenie → przyjęcie</span><span className="detail-value">{timeToAccept}</span></div>}
          {timeFromAccept && <div className="detail-row"><span className="detail-label">Przyjęcie → zakończenie</span><span className="detail-value" style={{ color:"var(--accent)" }}>{timeFromAccept}</span></div>}
          {totalTime && <div className="detail-row"><span className="detail-label">Całkowity czas</span><span className="detail-value" style={{ fontWeight:700, color:"var(--green)" }}>{totalTime}</span></div>}
        </div>
      )}

      {/* Przycisk przyjęcia zlecenia (dla "Nie rozpoczęto") */}
      {task.status === "Nie rozpoczęto" && canAct && (
        <div className="detail-section">
          <div style={{ padding:14, background:"var(--surface)", border:"1px solid var(--accent)", borderRadius:"var(--radius)" }}>
            <div style={{ fontSize:11, color:"var(--accent)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:10 }}>Przyjmij zlecenie</div>
            <div className="form-group">
              <label className="form-label">Kto przyjmuje?</label>
              <select className="form-select" value={acceptPerson} onChange={e => setAcceptPerson(e.target.value)}>
                {WORKERS.map(w => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
            <button className="btn btn-primary" style={{ width:"100%", background:"var(--accent)", color:"#000" }} disabled={!acceptPerson} onClick={handleAccept}>
              ▶ Przyjmuję do realizacji
            </button>
          </div>
        </div>
      )}

      {/* Wyświetlanie istniejącego protokołu */}
      {hasProtocol && (
        <div className="detail-section">
          <div className="detail-section-title"><Icon name="check" size={14} />Protokół ukończenia</div>
          <div style={{ background:"rgba(34,197,94,0.06)", border:"1px solid rgba(34,197,94,0.15)", borderRadius:10, padding:14 }}>
            {task.completionExecutor && <div className="detail-row"><span className="detail-label">Wykonał</span><span className="detail-value" style={{ fontWeight:600 }}>{task.completionExecutor}</span></div>}
            {task.completedAt && <div className="detail-row"><span className="detail-label">Data ukończenia</span><span className="detail-value">{task.completedAt.slice(0,10)}</span></div>}
            {task.completionTime && <div className="detail-row"><span className="detail-label">Czas realizacji</span><span className="detail-value">{task.completionTime}</span></div>}
            {task.completionNotes && (
              <div style={{ marginTop:10 }}>
                <div style={{ fontSize:10, color:"var(--text2)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:4 }}>Uwagi po wykonaniu</div>
                <div style={{ fontSize:13, lineHeight:1.6, whiteSpace:"pre-line" }}>{task.completionNotes}</div>
              </div>
            )}
            {task.completionMaterials && (
              <div style={{ marginTop:10 }}>
                <div style={{ fontSize:10, color:"var(--text2)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:4 }}>Zużyte materiały</div>
                <div style={{ fontSize:13, lineHeight:1.6, whiteSpace:"pre-line" }}>{task.completionMaterials}</div>
              </div>
            )}
            {task.completionCost && (
              <div className="detail-row" style={{ marginTop:8 }}>
                <span className="detail-label">Koszt netto</span>
                <span className="detail-value" style={{ fontWeight:700, color:"var(--accent)" }}>{task.completionCost} zł</span>
              </div>
            )}
            {task.completionPhotos && (
              <div style={{ marginTop:10 }}>
                <div style={{ fontSize:10, color:"var(--text2)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:4 }}>Linki do zdjęć</div>
                {task.completionPhotos.split("\n").filter(l => l.trim()).map((link, i) => (
                  <a key={i} href={link.trim()} target="_blank" rel="noopener noreferrer"
                    style={{ display:"flex", alignItems:"center", gap:6, padding:"6px 0", color:"var(--accent)", fontSize:12, fontWeight:600, textDecoration:"none" }}>
                    <Icon name="link" size={12} color="var(--accent)" />{link.trim().length > 60 ? link.trim().slice(0,60) + "..." : link.trim()}
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Formularz protokołu (dla niezakończonych zadań) */}
      {task.status !== "Zrobione" && canAct && (
        <div className="detail-section">
          {!showComplete ? (
            <button
              className="btn btn-primary"
              style={{ width:"100%", background:"var(--green)", color:"#000" }}
              onClick={() => setShowComplete(true)}
            >✓ Zakończ zadanie z protokołem</button>
          ) : (
            <div style={{ padding:14, background:"var(--surface)", border:"1px solid var(--green)", borderRadius:"var(--radius)" }}>
              <div style={{ fontSize:11, color:"var(--green)", fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:14 }}>
                Protokół ukończenia zadania
              </div>

              <div className="form-group">
                <label className="form-label">Kto wykonał *</label>
                <select className="form-select" value={protocol.executor} onChange={e => setP("executor", e.target.value)}>
                  <option value="">— wybierz —</option>
                  {WORKERS.map(w => <option key={w} value={w}>{w}</option>)}
                  <option value={currentUser && currentUser.name}>{currentUser && currentUser.name} (ja)</option>
                </select>
              </div>

              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                <div className="form-group">
                  <label className="form-label">Data ukończenia</label>
                  <input className="form-input" type="date" value={protocol.date} onChange={e => setP("date", e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Czas realizacji</label>
                  <input className="form-input" placeholder="np. 2h 30min" value={protocol.timeSpent} onChange={e => setP("timeSpent", e.target.value)} />
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Uwagi po wykonaniu</label>
                <textarea
                  className="form-textarea"
                  value={protocol.notes}
                  onChange={e => setP("notes", e.target.value)}
                  placeholder="Opisz co zostało zrobione, ewentualne uwagi..."
                  style={{ minHeight:80 }}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Zużyte materiały</label>
                <textarea
                  className="form-textarea"
                  value={protocol.materials}
                  onChange={e => setP("materials", e.target.value)}
                  placeholder="np. 2x żarówka LED, 1x filtr..."
                  style={{ minHeight:60 }}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Koszt netto (zł)</label>
                <NumberInput className="form-input" step={0.01} min={0} placeholder="0.00" value={protocol.costNet} onChange={v => setP("costNet", v)} />
              </div>

              <div className="form-group">
                <label className="form-label">Linki do zdjęć (Google Photos, Drive)</label>
                <textarea
                  className="form-textarea"
                  value={protocol.photoLinks}
                  onChange={e => setP("photoLinks", e.target.value)}
                  placeholder={"https://photos.google.com/...\nhttps://drive.google.com/..."}
                  style={{ minHeight:60 }}
                />
                <div style={{ fontSize:11, color:"var(--text2)", marginTop:4 }}>
                  Wklej linki do zdjęć — każdy w nowej linii. Upload plików nie jest dostępny w wersji PWA.
                </div>
              </div>

              <div style={{ display:"flex", gap:8 }}>
                <button className="btn btn-primary" style={{ flex:1, background:"var(--green)", color:"#000" }}
                  disabled={!protocol.executor}
                  onClick={handleComplete}>
                  ✓ Potwierdź ukończenie
                </button>
                <button className="btn" style={{ flex:1 }} onClick={() => setShowComplete(false)}>Anuluj</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const OwnerDetail = ({ owner, apartments, onBack, onEdit, onSelectApt, renderAptIndicators, currentUser }) => {
  const ownerApts = apartments.filter(a => a.ownerId === owner.id);
  const isManager = currentUser && currentUser.role === ROLES.MANAGER;
  return (
    <div className="slide-up">
      <div className="header">
        <button className="header-back" onClick={onBack}><Icon name="back" /></button>
        <h1>{owner.lastName} {owner.firstName}</h1>
        {isManager && (
          <div className="header-actions">
            <button className="icon-btn" onClick={onEdit}><Icon name="edit" size={16} /></button>
          </div>
        )}
      </div>
      <div className="detail-hero" style={{ textAlign: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          <div className="owner-avatar" style={{ width: 64, height: 64, fontSize: 22, marginBottom: 8 }}>{owner.lastName[0]}{owner.firstName[0]}</div>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 700, letterSpacing: "0.02em", color: "var(--text)", lineHeight: 1.1 }}>{owner.lastName} {owner.firstName}</h2>
          <div style={{ fontSize: 14, color: "var(--text2)", fontWeight: 500 }}>{owner.phone || "—"}</div>
          <div style={{ fontSize: 14, color: "var(--text2)", fontWeight: 500 }}>{owner.email || "—"}</div>
        </div>
      </div>
      <div className="action-row">
        <button className="action-btn" onClick={() => window.open(`tel:${owner.phone}`)}><Icon name="phone" size={18} color="var(--accent)" />ZADZWOŃ</button>
        <button className="action-btn" onClick={() => window.open(`mailto:${owner.email}`)}><Icon name="mail" size={18} color="var(--accent)" />E-MAIL</button>
      </div>
      <div className="detail-section">
        <div className="detail-section-title"><Icon name="info" size={14} />Dane kontaktowe</div>
        {owner.status && <div className="detail-row"><span className="detail-label">Typ umowy</span><span className="detail-value" style={{ color: APT_TYPE_COLORS[owner.status] || "var(--text)", fontWeight: 700 }}>{owner.status}</span></div>}
        <div className="detail-row"><span className="detail-label">Telefon</span><span className="detail-value">{owner.phone || "—"}</span></div>
        <div className="detail-row"><span className="detail-label">E-mail</span><span className="detail-value">{owner.email || "—"}</span></div>
      </div>
      {isManager && (
        <>
          <div className="detail-section">
            <div className="detail-section-title">Panel KW Hotel</div>
            <div className="detail-row"><span className="detail-label">Login</span><span className="detail-value">{owner.kwLogin}</span></div>
            <div className="detail-row"><span className="detail-label">Hasło</span><span className="detail-value">{owner.kwPassword}</span></div>
          </div>
          <div className="detail-section">
            <div className="detail-section-title">Rozliczenia</div>
            <div className="detail-row"><span className="detail-label">Prowizja</span><span className="detail-value" style={{ color: "var(--accent)", fontSize: 24, fontFamily: "var(--font-display)", fontWeight: 400, letterSpacing: "0.06em" }}>{owner.percent}%</span></div>
            <div className="detail-row"><span className="detail-label">Metoda</span><span className="detail-value">{owner.billingMethod}</span></div>
            <div className="detail-row"><span className="detail-label">Dane faktury</span><span className="detail-value">{owner.invoiceData}</span></div>
          </div>
        </>
      )}

      {/* Pola własne właściciela (PAKIET 5) — z konfiguracji formularza */}
      {(() => {
        const filled = FormSchema.visible("owner").filter(f => f.custom && (owner[f.id] || owner[f.id] === 0));
        if (filled.length === 0) return null;
        return (
          <div className="detail-section">
            <div className="detail-section-title"><Icon name="info" size={14} />Dodatkowe informacje</div>
            {filled.map(f => {
              const val = owner[f.id];
              if (f.type === "checkbox") return <div className="detail-row" key={f.id}><span className="detail-label">{f.label}</span><span className="detail-value">Tak</span></div>;
              if (f.type === "textarea") return <div key={f.id} style={{ marginBottom:10 }}><div style={{ fontSize:10, color:"var(--text2)", textTransform:"uppercase", letterSpacing:"0.1em", fontWeight:700, marginBottom:4 }}>{f.label}</div><p style={{ fontSize:14, lineHeight:1.6, whiteSpace:"pre-line", margin:0 }}>{val}</p></div>;
              if (f.type === "url") return <div className="detail-row" key={f.id}><span className="detail-label">{f.label}</span><a href={val} target="_blank" rel="noopener noreferrer" style={{ color:"var(--accent)", fontSize:13, fontWeight:600 }}>Otwórz link ↗</a></div>;
              return <div className="detail-row" key={f.id}><span className="detail-label">{f.label}</span><span className="detail-value">{val}</span></div>;
            })}
          </div>
        );
      })()}

      <div className="detail-section">
        <div className="detail-section-title">Apartamenty ({ownerApts.length})</div>
        {ownerApts.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text2)" }}>Brak przypisanych apartamentów.</div>
        ) : ownerApts.map(a => (
          <div key={a.id} className="apt-row" onClick={() => onSelectApt && onSelectApt(a)}>
            <div className="apt-row-left">
              <div style={{ minWidth:0 }}>
                <div style={{ display:"flex",alignItems:"center",gap:8,flexWrap:"wrap" }}>
                  <div className="apt-row-name">{a.name}</div>
                  {a.capacity > 0 && <span style={{ fontSize:10,color:"var(--text2)",fontWeight:600 }}>👥 {a.capacity} os.</span>}
                </div>
                {renderAptIndicators && renderAptIndicators(a)}
              </div>
            </div>
            <div style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:5,flexShrink:0 }}>
              {a.aptStatus && <StatusBadge status={a.aptStatus} />}
              {a.status && <span style={{ fontSize:9,fontWeight:700,color:APT_TYPE_COLORS[a.status]||"var(--text2)",letterSpacing:"0.06em",textTransform:"uppercase",textAlign:"center" }}>{a.status}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};


const StatusBar = ({ online, queueSize }) => {
  if (online && queueSize === 0) return null;
  return (
    <div style={{ position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,zIndex:998,
      background:!online?"rgba(239,68,68,0.97)":"rgba(245,158,11,0.97)",
      backdropFilter:"blur(12px)",padding:"10px 16px",display:"flex",alignItems:"center",gap:8,
      fontSize:12,fontWeight:700,borderBottom:`1px solid ${!online?"rgba(239,68,68,0.4)":"rgba(245,158,11,0.4)"}`
    }}>
      {!online
        ? <><Icon name="x" size={14} color="#fff" /><span style={{ color:"#fff" }}>Offline — zmiany zapisywane lokalnie</span></>
        : <><Icon name="sync" size={14} color="#000" /><span style={{ color:"#000" }}>{queueSize} operacji czeka na synchronizację</span></>
      }
    </div>
  );
};

const ToastNotification = ({ toast, toastColors }) => {
  if (!toast) return null;
  const color = toastColors[toast.type] || "var(--accent)";
  return (
    <div style={{ position:"fixed",top:56,left:"50%",transform:"translateX(-50%)",
      width:"calc(100% - 32px)",maxWidth:398,zIndex:997,
      background:"var(--surface2)",border:`1px solid ${color}`,borderLeft:`4px solid ${color}`,
      borderRadius:12,padding:"11px 14px",display:"flex",alignItems:"center",gap:10,
      animation:"fadeIn 0.2s ease",boxShadow:"0 4px 24px rgba(0,0,0,0.4)"
    }}>
      <div style={{ width:8,height:8,borderRadius:"50%",background:color,flexShrink:0 }} />
      <span style={{ fontSize:13,fontWeight:600,flex:1 }}>{toast.msg}</span>
    </div>
  );
};

const AuditPanelView = ({ entries, onClose, storageKB }) => {
  const ac = { LOGIN:"#10B981",LOGIN_DEMO:"#10B981",LOGOUT:"#94A3B8",INSERT:"#3B82F6",UPDATE:"#F59E0B",DELETE:"#EF4444",DELETE_TASK:"#EF4444",TASK_STATUS:"#A78BFA",ACCESS_DENIED:"#EF4444",QUEUE_FLUSH:"#3B82F6",TOKEN_REFRESH:"#F59E0B" };
  return (
    <FloatingModal open onClose={onClose} title="Audit Log" size="md">
        <div style={{ fontSize:11,color:"var(--text2)",marginBottom:12,fontWeight:600 }}>
          {entries.length} wpisów · localStorage · Storage: {storageKB} KB
        </div>
        {entries.length === 0
          ? <div className="empty"><div className="empty-icon"><Icon name="shield" size={36} /></div><h3>Brak wpisów</h3></div>
          : entries.map((e, i) => (
            <div key={i} style={{ padding:"9px 0",borderBottom:"1px solid var(--border)",display:"flex",gap:10 }}>
              <div style={{ width:7,height:7,borderRadius:"50%",background:ac[e.action]||"#888",flexShrink:0,marginTop:4 }} />
              <div style={{ flex:1 }}>
                <div style={{ display:"flex",justifyContent:"space-between" }}>
                  <span style={{ fontSize:11,fontWeight:700,color:ac[e.action]||"#888",letterSpacing:"0.06em" }}>{e.action}</span>
                  <span style={{ fontSize:10,color:"var(--text2)" }}>{e.ts && e.ts.slice(11,19)}</span>
                </div>
                <div style={{ fontSize:11,color:"var(--text2)",marginTop:1 }}>{e.user} · {e.ts && e.ts.slice(0,10)}</div>
              </div>
            </div>
          ))}
    </FloatingModal>
  );
};

const Shell = ({ children, online, queueSize, toast, toastColors, showAudit, onCloseAudit }) => (
  <div className="app">
    <style>{styles}</style>
    <StatusBar online={online} queueSize={queueSize} />
    <ToastNotification toast={toast} toastColors={toastColors} />
    {showAudit && (
      <AuditPanelView
        entries={Audit.getRecent(50)}
        onClose={onCloseAudit}
        storageKB={Storage.getUsageKB()}
      />
    )}
    {children}
  </div>
);

// ─── MAIN APP ─────────────────────────────────────────────────────────────────


// ════════════════════════════════════════════════════════════════════════════
// § APP — główny komponent (#58: separacja warstw przez hooki i kontekst)
// ════════════════════════════════════════════════════════════════════════════

export default function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  // ── Theme ─────────────────────────────────────────────────────────────────
  const [theme, setTheme] = useState(() => Storage.get("theme") || "dark");  // MUST-4: bez prefiksu
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    Storage.set("theme", theme);  // MUST-4: bez prefiksu
  }, [theme]);
  const toggleTheme = () => setTheme(t => t === "dark" ? "light" : "dark");

  // ── Układ listy apartamentów: "multi" (wiele kolumn) | "single" (jedna) ─────
  const [aptColumns, setAptColumns] = useState(() => Storage.get("aptColumns") || "multi");
  useEffect(() => { Storage.set("aptColumns", aptColumns); }, [aptColumns]);

  // ── Master-detail: split (lista lewo / detal prawo) tylko na szerokich ekranach ─
  const isWide = useMediaQuery("(min-width: 1280px)");

  // ── Pozycja menu na desktopie: "left" (panel boczny) | "top" (pasek u góry) ─────
  // Wąski widok zawsze ma pasek na dole (niezależnie od tego ustawienia).
  const [navPos, setNavPos] = useState(() => Storage.get("navPos") || "left");
  useEffect(() => { Storage.set("navPos", navPos); }, [navPos]);
  // Pasek u góry tylko gdy okno wystarczająco szerokie (ten sam próg co master-detail).
  // Węższe okno → automatycznie panel boczny.
  const navTop = navPos === "top" && isWide;

  const [tab, setTab] = useState("apartments");
  const [apartments, setApartments] = useState(MOCK_APARTMENTS);
  const [owners, setOwners] = useState(MOCK_OWNERS);
  const [tasks, setTasks] = useState(MOCK_TASKS);
  const [cleaningSessions, setCleaningSessions] = useState(() => CleaningSessions.getAll());
  const [categories, setCategories] = useState(() => Categories.getAll());
  const [loans, setLoans] = useState(() => Loans.getAll());
  const [files, setFiles] = useState(() => Files.getAll());

  // Helpers: refresh from storage
  const refreshCleaning   = () => setCleaningSessions(CleaningSessions.getAll());
  const refreshCategories = () => setCategories(Categories.getAll());
  const refreshLoans      = () => setLoans(Loans.getAll());
  const refreshFiles      = () => setFiles(Files.getAll());

  // Ikonki statusu przy wierszu apartamentu w listach głównych:
  //  • zadanie — czerwone = oczekujące, żółte = w trakcie
  //  • pożyczka — żółte = apartament ma aktywną pożyczkę (z lub do)
  // Zwykła funkcja (nie komponent) — wstawiana inline, bez resetu stanu.
  const renderAptIndicators = (apt) => {
    const active = tasks.filter(t => t.apartmentId === apt.id && (t.status === "W trakcie" || t.status === "Nie rozpoczęto"));
    const inProg = active.some(t => t.status === "W trakcie");
    const hasTask = active.length > 0;
    const hasLoan = (loans || []).some(l => l.status === "active" && (l.fromAptId === apt.id || l.toAptId === apt.id));
    // FIX 7.6 — aktywne zamówienia (status ≠ "done") liczone z apt_orders_<id>.
    const aptOrders = Storage.get(`apt_orders_${apt.id}`) || [];
    const activeOrders = aptOrders.filter(o => o.status !== "done").length;
    return (
      <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:6 }}>
        {/* Zadania — klik → zakładka Zadania apartamentu; przygaszone gdy brak */}
        <button type="button" className="apt-ind"
          title={hasTask ? (inProg ? "Zadanie w trakcie — otwórz zadania" : "Oczekujące zadanie — otwórz zadania") : "Zadania apartamentu"}
          onClick={(e) => { e.stopPropagation(); openApt(apt, "zadania"); }}>
          <span style={{ display:"inline-flex", opacity: hasTask ? 1 : 0.4 }}>
            <Icon name="tasks" size={16} color={hasTask ? (inProg ? "var(--yellow)" : "var(--red)") : "var(--text2)"} />
          </span>
        </button>
        {/* Pożyczki — klik → zakładka Pożyczki apartamentu; przygaszone gdy brak */}
        <button type="button" className="apt-ind"
          title={hasLoan ? "Aktywna pożyczka — otwórz pożyczki" : "Pożyczki apartamentu"}
          onClick={(e) => { e.stopPropagation(); openApt(apt, "loans"); }}>
          <span style={{ display:"inline-flex", opacity: hasLoan ? 1 : 0.4 }}>
            <Icon name="swap" size={16} color={hasLoan ? "var(--yellow)" : "var(--text2)"} />
          </span>
        </button>
        {/* FIX 7.6 — Zamówienia — klik → zakładka Zamówienia; pokazuje liczbę gdy > 0 */}
        <button type="button" className="apt-ind"
          title={activeOrders > 0 ? `${activeOrders} aktywne zamówienie/-a — otwórz zamówienia` : "Zamówienia apartamentu"}
          onClick={(e) => { e.stopPropagation(); openApt(apt, "orders"); }}>
          <span style={{ display:"inline-flex", alignItems:"center", gap:3, opacity: activeOrders > 0 ? 1 : 0.4 }}>
            <Icon name="package" size={16} color={activeOrders > 0 ? "var(--accent)" : "var(--text2)"} />
            {activeOrders > 0 && <span style={{ fontSize:11, fontWeight:700, color:"var(--accent)", letterSpacing:"0.02em" }}>{activeOrders}</span>}
          </span>
        </button>
      </div>
    );
  };

  const [selectedApt, setSelectedApt] = useState(null);
  const [aptInitialTab, setAptInitialTab] = useState(null);
  // Otwórz apartament na konkretnej zakładce (klik w ikonę w wierszu listy)
  const openApt = (apt, initialTab = null) => { setAptInitialTab(initialTab); setSelectedApt(apt); };
  const [selectedTask, setSelectedTask] = useState(null);
  const [selectedOwner, setSelectedOwner] = useState(null);
  const [expandedOwnerId, setExpandedOwnerId] = useState(null); // rozwinięta lista pozycji właściciela (klik w kafelek)

  // ── PAKIET 7 — nawigacja: zwijanie grup, submenu Ustawień, deep-link do zakładki ──
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try { return Storage.get("nav_collapsed") || {}; } catch { return {}; }
  });
  const toggleNavGroup = (key) => {
    setNavCollapsed(prev => {
      const next = { ...prev, [key]: !prev[key] };
      Storage.set("nav_collapsed", next);
      return next;
    });
  };
  const [settingsExpanded, setSettingsExpanded] = useState(() => {
    try { return Storage.get("nav_settings_expanded") || false; } catch { return false; }
  });
  const toggleSettingsExpanded = () => {
    setSettingsExpanded(v => { const nv = !v; Storage.set("nav_settings_expanded", nv); return nv; });
  };
  // Deep-link do konkretnej zakładki w SettingsView; bump licznik wymusza re-aplikację
  // tej samej zakładki po ponownym kliknięciu (np. user wszedł w "Ogólne", potem klik "Ogólne" → nadal działa).
  const [settingsInitialTab, setSettingsInitialTab] = useState(null);
  const [settingsTabBump, setSettingsTabBump] = useState(0);
  const goToSettingsTab = (tabId) => {
    setSettingsInitialTab(tabId);
    setSettingsTabBump(b => b + 1);
    setTab("settings"); setSelectedApt(null); setSelectedTask(null); setSelectedOwner(null);
  };

  // PAKIET 7.2 — liczniki w nawigacji (memo, żeby nie liczyć przy każdym renderze).
  // Hooki MUSZĄ być nad early-returnami dla roli (CLEANING/MAINTENANCE niżej).
  const taskCount = useMemo(
    () => tasks.filter(t => t.status === "Nie rozpoczęto" || t.status === "W trakcie").length,
    [tasks]
  );
  const loanCount = useMemo(
    () => (loans || []).filter(l => l.status === "active").length,
    [loans]
  );
  // Apartament przypisany do kategorii przez a.status === cat.name (patrz tab "cat_…").
  const categoryCounts = useMemo(() => {
    const counts = {};
    apartments.forEach(a => {
      if (a.status) counts[a.status] = (counts[a.status] || 0) + 1;
    });
    return counts;
  }, [apartments]);

  const [showAptForm, setShowAptForm] = useState(false);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [showOwnerForm, setShowOwnerForm] = useState(false);
  const [editingApt, setEditingApt] = useState(null);
  const [editingTask, setEditingTask] = useState(null);
  const [editingOwner, setEditingOwner] = useState(null);
  const [prefillApt, setPrefillApt] = useState(null);
  const [defaultCategory, setDefaultCategory] = useState(""); // pre-fill from cat_ tab
  const [showMoreMenu, setShowMoreMenu] = useState(false); // mobile "more" menu

  const [aptSearch, setAptSearch] = useState("");
  const [aptFilter, setAptFilter] = useState("Wszystkie");
  const [taskFilter, setTaskFilter] = useState("Wszystkie");
  const [taskSearch, setTaskSearch] = useState(""); // FIX 9.4
  const [kwSyncing, setKwSyncing] = useState(false);
  const [showKwModal, setShowKwModal] = useState(false); // PAKIET 8a.2 — KW jako modal (otwierany z Ustawienia → API)
  const [showAudit, setShowAudit] = useState(false);

  // Hooki z nowej architektury
  const { toast, show: showToast, showError } = useToast();
  const { online, queueSize } = useOnlineSync(currentUser);

  // FIX #54: toast z pełnym typem błędu (#54)
  const toastColors = {
    success:"var(--green)", error:"var(--red)", warn:"var(--yellow)", info:"var(--accent)",
    auth:"var(--red)", forbidden:"var(--red)", validation:"var(--yellow)",
    timeout:"var(--yellow)", network:"var(--yellow)", server:"var(--red)",
    rate_limit:"var(--yellow)", unknown:"var(--yellow)",
  };

  // FIX #23/#48: multi-tab sync — pełne (LOGIN/LOGOUT/SESSION_EXPIRED) (#8)
  useMultiTab(
    (reason) => {
      setCurrentUser(null);
      const msg = reason === "session_expired" ? "Sesja wygasła" : "Wylogowano w innej karcie";
      showToast(msg, "auth");
    },
    () => { /* SESSION_REFRESHED — nic nie robimy w UI */ }
  );

  // Auth init — używa AuthManager (#2)
  useEffect(() => {
    const init = async () => {
      Storage.cleanup();
      try {
        if (CONFIG.isDemo) {
          // Demo: sprawdź in-memory state (AuthManager.currentUser ustawiony przez signInDemo)
          const user = AuthManager.currentUser;
          if (is.user(user)) setCurrentUser(user);
        } else {
          // Próbuj odtworzyć sesję z sessionStorage
          const stored = SessionStore.load();
          if (stored && !isExpired(stored)) {
            const res = await apiRequest({ method: "GET", path: "/auth/v1/user", ctx: "init:getUser" });
            if (res.ok && res.data) {
              const meta = res.data.user_metadata || {};
              const u = { id: res.data.id, email: res.data.email, role: meta.role || ROLES.WORKER, name: meta.name || res.data.email.split("@")[0] };
              AuthManager._currentUser = u;
              setCurrentUser(u);
            } else {
              AuthManager._forceLogout("init_restore_failed");
            }
          }
        }
      } catch {}
      setAuthLoading(false);
    };
    // Subscribe na zmiany auth (login z innego miejsca, force logout)
    const unsub = AuthManager.subscribe(event => {
      if (event.type === "LOGIN")  setCurrentUser(AuthManager.currentUser);
      if (event.type === "LOGOUT") setCurrentUser(null);
    });
    init();
    return unsub;
  }, []);

  const handleLogin = (user) => setCurrentUser(user);

  const handleLogout = async () => {
    await AuthManager.signOut();
    setCurrentUser(null);
  };

  // Data operations — z guard, DB call, optymistyczny update, error handling
  const nextId = (arr) => Math.max(...arr.map(x => x.id), 0) + 1;

  const saveApt = async (form) => {
    if (!guard(currentUser, "write:apartments", (m) => showToast(`🚫 ${m}`, "forbidden"))) return;
    try {
      if (editingApt) {
        setApartments(prev => prev.map(a => a.id === editingApt.id ? { ...editingApt, ...form } : a));
        if (!CONFIG.isDemo) {
          const r = await db.update("apartments", form, `id=eq.${editingApt.id}`);
          if (!r.ok) showError(r.error, "update_apartment");
          else showToast("✅ Apartament zaktualizowany", "success");
        } else showToast("✅ Apartament zaktualizowany", "success");
      } else {
        const newApt = { ...form, id: nextId(apartments) };
        setApartments(prev => [...prev, newApt]);
        if (!CONFIG.isDemo) {
          const r = await db.insert("apartments", newApt);
          if (!r.ok) showError(r.error, "insert_apartment");
          else showToast("✅ Apartament dodany", "success");
        } else showToast("✅ Apartament dodany", "success");
      }
    } catch (e) { showError(e, "saveApt"); }
    setShowAptForm(false); setEditingApt(null);
  };

  const saveTask = async (form) => {
    if (!guard(currentUser, "write:tasks", (m) => showToast(`🚫 ${m}`, "forbidden"))) return;
    const today = new Date().toISOString().slice(0, 10);
    try {
      if (editingTask) {
        const updated = { ...editingTask, ...form };
        setTasks(prev => prev.map(t => t.id === editingTask.id ? updated : t));
        if (selectedTask) setSelectedTask(updated);
        if (!CONFIG.isDemo) {
          const r = await db.update("tasks", form, `id=eq.${editingTask.id}`);
          if (!r.ok) showError(r.error, "update_task");
          else showToast("✅ Zadanie zaktualizowane", "success");
        } else showToast("✅ Zadanie zaktualizowane", "success");
      } else {
        const newTask = { ...form, id: nextId(tasks), createdAt: today, photo: null };
        setTasks(prev => [...prev, newTask]);
        if (!CONFIG.isDemo) {
          const r = await db.insert("tasks", newTask);
          if (!r.ok) showError(r.error, "insert_task");
          else showToast("✅ Zadanie dodane", "success");
        } else showToast("✅ Zadanie dodane", "success");
      }
    } catch (e) { showError(e, "saveTask"); }
    setShowTaskForm(false); setEditingTask(null); setPrefillApt(null);
  };

  const saveOwner = async (form) => {
    // FIX 1.3 — NumberInput trzyma prowizję jako string; konwersja na number przy zapisie
    form = { ...form, percent: (form.percent === "" || form.percent == null) ? 0 : (Number(form.percent) || 0) };
    if (!guard(currentUser, "write:owners", (m) => showToast(`🚫 ${m}`, "forbidden"))) return;
    try {
      if (editingOwner) {
        setOwners(prev => prev.map(o => o.id === editingOwner.id ? { ...editingOwner, ...form } : o));
        if (!CONFIG.isDemo) {
          const r = await db.update("owners", form, `id=eq.${editingOwner.id}`);
          if (!r.ok) showError(r.error, "update_owner");
          else showToast("✅ Właściciel zaktualizowany", "success");
        } else showToast("✅ Właściciel zaktualizowany", "success");
      } else {
        const newOwner = { ...form, id: nextId(owners) };
        setOwners(prev => [...prev, newOwner]);
        if (!CONFIG.isDemo) {
          const r = await db.insert("owners", newOwner);
          if (!r.ok) showError(r.error, "insert_owner");
          else showToast("✅ Właściciel dodany", "success");
        } else showToast("✅ Właściciel dodany", "success");
      }
    } catch (e) { showError(e, "saveOwner"); }
    setShowOwnerForm(false); setEditingOwner(null);
  };

  // FIX 2.A — window.confirm zastąpione przez ConfirmModal. deleteTask tylko prosi
  // o potwierdzenie (ustawia id), faktyczne usunięcie robi performDeleteTask.
  const [confirmDeleteTaskId, setConfirmDeleteTaskId] = useState(null);
  const deleteTask = (id) => {
    if (!guard(currentUser, "delete:tasks", (m) => showToast(`🚫 ${m}`, "forbidden"))) return;
    setConfirmDeleteTaskId(id);
  };
  const performDeleteTask = async () => {
    const id = confirmDeleteTaskId;
    if (id == null) return;
    setConfirmDeleteTaskId(null);
    setTasks(prev => prev.filter(t => t.id !== id));
    if (!CONFIG.isDemo) {
      const r = await db.delete("tasks", `id=eq.${id}`);
      if (!r.ok) showError(r.error, "delete_task");
    }
    Audit.log("DELETE_TASK", currentUser, { taskId: id });
    showToast("Zadanie usunięte", "info");
    setSelectedTask(null);
  };
  const taskDeleteConfirm = (
    <ConfirmModal
      open={confirmDeleteTaskId != null}
      variant="danger"
      title="Usunąć zadanie?"
      message="Tego nie można cofnąć."
      confirmLabel="Usuń zadanie"
      onClose={() => setConfirmDeleteTaskId(null)}
      onConfirm={performDeleteTask}
    />
  );

  const updateTaskStatus = async (taskId, newStatus) => {
    const task = tasks.find(t => t.id === taskId);
    if (currentUser.role === ROLES.WORKER && task && task.assignedTo !== currentUser.name) {
      showToast("🚫 Możesz zmieniać status tylko własnych zadań", "forbidden");
      Audit.log("ACCESS_DENIED", currentUser, { action: "update_other_task", taskId });
      return;
    }
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus } : t));
    if (!CONFIG.isDemo) await db.update("tasks", { status: newStatus }, `id=eq.${taskId}`);
    Audit.log("TASK_STATUS", currentUser, { taskId, newStatus });
  };

  const handleKwSync = () => {
    setKwSyncing(true);
    setTimeout(() => { setKwSyncing(false); showToast("✅ KW Hotel: pobrano 3 rezerwacje, zaktualizowano 5 statusów", "success"); }, 2000);
  };

  // ── Cleaning session handlers ──────────────────────────────────────────────
  const handleAddSession = (type, date, aptId, assignedTo) => {
    if (type === "auto") {
      CleaningSessions.planForDate(date, apartments);
    } else {
      CleaningSessions.addSession(aptId, date, assignedTo || "");
    }
    refreshCleaning();
  };

  const handleUpdateSession = (action, id, notes) => {
    if (action === "start")  CleaningSessions.startSession(id);
    if (action === "stop")   CleaningSessions.stopSession(id);
    if (action === "finish") CleaningSessions.finishSession(id, notes);
    refreshCleaning();
  };

  const handleDeleteSession = (id) => {
    CleaningSessions.deleteSession(id);
    refreshCleaning();
  };

  // ── Filtry apartamentów ────────────────────────────────────────────────────
  // Szukanie: nazwa, adres, piętro, notatki, WiFi, uwagi
  // Filtr statusowy: chip (Wolny/Zajęty/typ umowy)
  // Filtry zaawansowane: piętro, odległość od morza, pojemność, parking
  const [aptFiltersOpen, setAptFiltersOpen] = useState(false);
  const [aptAdvFilters, setAptAdvFilters] = useState({
    aptStatus: "",     // Wolny | Zajęty | Wolny/Dzisiaj przyjazd | Dzisiaj wyjazd gości | Zajęty/Jutro się zwolni
    floor: "",         // konkretne piętro lub "PARTER"
    maxSea: "",        // max odległość od morza (m)
    minCapacity: "",   // min liczba osób
    parking: "",       // GARAŻ | NAZIEMNE
    secType: "",       // SEJFIK | KLAMKA GENEROWANA
  });

  const setAdvFilter = (k, v) => setAptAdvFilters(f => ({ ...f, [k]: v }));
  const clearAdvFilters = () => setAptAdvFilters({ aptStatus:"", floor:"", maxSea:"", minCapacity:"", parking:"", secType:"" });
  const advFiltersActive = Object.values(aptAdvFilters).some(v => v !== "");

  const filteredApts = apartments.filter(a => {
    // Szukanie po kilku polach jednocześnie
    const q = aptSearch.toLowerCase();
    const matchSearch = !q ||
      a.name.toLowerCase().includes(q) ||
      (a.address || "").toLowerCase().includes(q) ||
      (a.floor || "").toLowerCase().includes(q) ||
      (a.aptNumber || "").toLowerCase().includes(q) ||
      (a.notes || "").toLowerCase().includes(q) ||
      (a.onlineName || "").toLowerCase().includes(q);

    // Filtry chipów — tylko typ umowy
    // Filtry chipów — dynamiczne z kategorii
    const matchChip = aptFilter === "Wszystkie" || a.status === aptFilter;

    // Filtry zaawansowane
    const { aptStatus, floor, maxSea, minCapacity, parking, secType } = aptAdvFilters;
    const matchStatus   = !aptStatus   || a.aptStatus === aptStatus;
    const matchFloor    = !floor       || String(a.floor || "").toLowerCase() === floor.toLowerCase();
    const matchSea      = !maxSea      || Number(a.distanceSea) <= Number(maxSea);
    const matchCap      = !minCapacity || Number(a.capacity)    >= Number(minCapacity);
    const matchParking  = !parking     || (a.parking || "").toUpperCase().includes(parking.toUpperCase());
    const matchSecType  = !secType     || (a.securityType || "").toUpperCase().includes(secType.toUpperCase());

    return matchSearch && matchChip && matchStatus && matchFloor && matchSea && matchCap && matchParking && matchSecType;
  });

  // FIX 9.4 — filtr statusu + wyszukiwanie po tytule/notatkach/osobie/lokalizacji
  const filteredTasks = (() => {
    const q = taskSearch.trim().toLowerCase();
    return tasks.filter(t => {
      const matchStatus = taskFilter === "Wszystkie" || t.status === taskFilter;
      const matchSearch = !q || [t.title, t.notes, t.assignedTo, t.location]
        .some(v => (v || "").toLowerCase().includes(q));
      return matchStatus && matchSearch;
    });
  })();

  // Unikalne wartości pięter i typów parkingu do dropdownów
  const uniqueFloors   = [...new Set(apartments.map(a => a.floor).filter(Boolean))].sort();
  const uniqueParking  = [...new Set(apartments.map(a => a.parking).filter(Boolean))].sort();
  const uniqueSecTypes = [...new Set(apartments.map(a => a.securityType).filter(Boolean))].sort();

  const isManager = currentUser && currentUser.role === ROLES.MANAGER;

  // FIX #57: Fallback gdy Supabase niedostępny — pokazuj dane lokalne (#57)
  // (już obsługiwane przez optimistic update + MOCK_* jako initial state)

// ── StatusBar — top-level (nie wewnątrz App!) ─────────────────────────────
// WAŻNE: komponenty definiowane wewnątrz App() są remontowane przy każdym
// renderze → input traci focus. Definicja top-level to fix.

  // ── Loading ────────────────────────────────────────────────────────────────
  if (authLoading) {
    return (
      <div className="app"><style>{styles}</style>
        <div className="loading-screen">
          <div style={{ marginBottom:24 }}>
            <VelarLogo size={48} withWordmark taglineText="Property Management Suite" />
          </div>
          <div className="spinner" />
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="app-root">
        <style>{styles}</style>
        <div className="app" style={{ maxWidth:"none", margin:"0 auto" }}>
          <div style={{ maxWidth:480, margin:"0 auto" }}>
            <LoginScreen onLogin={handleLogin} />
          </div>
        </div>
      </div>
    );
  }

  // Worker teraz widzi widok managera ale w trybie read-only
  // (upranienia kontrolowane przez guard() w akcjach)

  if (currentUser.role === ROLES.CLEANING) {
    return (
      <CleaningTeamView
        currentUser={currentUser}
        apartments={apartments}
        cleaningSessions={cleaningSessions}
        onUpdateSession={handleUpdateSession}
        onLogout={handleLogout}
      />
    );
  }

  if (currentUser.role === ROLES.MAINTENANCE) {
    // Jeśli maintenance user wybrał zadanie — pokaż TaskDetail z pełnym protokołem
    if (selectedTask) {
      const apt = apartments.find(a => a.id === selectedTask.apartmentId);
      return (
        <div className="app-root">
          <style>{styles}</style>
          <div className="app" style={{ maxWidth:"none", margin:0 }}>
            <TaskDetail task={selectedTask} apt={apt} currentUser={currentUser}
              onBack={() => setSelectedTask(null)}
              onEdit={() => { setEditingTask(selectedTask); setShowTaskForm(true); }}
              onDelete={() => deleteTask(selectedTask.id)}
              onComplete={(id, protocol) => {
                const updates = {
                  status: "Zrobione",
                  completionExecutor: protocol.executor || "",
                  completionNotes: protocol.notes || "",
                  completedAt: protocol.date || new Date().toISOString().slice(0,10),
                  completionTime: protocol.timeSpent || "",
                  completionMaterials: protocol.materials || "",
                  completionCost: protocol.costNet || "",
                  completionPhotos: protocol.photoLinks || "",
                };
                setTasks(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
                setSelectedTask(prev => prev && prev.id === id ? { ...prev, ...updates } : prev);
              }}
              onAccept={(id, person) => {
                const updates = { status: "W trakcie", acceptedBy: person, acceptedAt: new Date().toISOString() };
                setTasks(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
                setSelectedTask(prev => prev && prev.id === id ? { ...prev, ...updates } : prev);
              }}
            />
            {taskDeleteConfirm}
            {showTaskForm && <TaskForm task={editingTask} apartments={apartments} onSave={saveTask} onToast={showToast} onClose={() => { setShowTaskForm(false); setEditingTask(null); }} />}
          </div>
        </div>
      );
    }
    return (
      <MaintenanceView
        currentUser={currentUser}
        tasks={tasks}
        apartments={apartments}
        onSelectTask={setSelectedTask}
        onLogout={handleLogout}
      />
    );
  }

  const isReadOnly = currentUser.role === ROLES.WORKER;
  const roleLabel  = isReadOnly ? "Worker (tylko odczyt)" : "Manager";

  // ── Sidebar desktop nav ───────────────────────────────────────────────────
  // Kategorie z flagą showInNav są automatycznie dodawane do menu
  const categoriesInNav = categories.filter(c => c.showInNav);

  // PAKIET 7.5 — submenu Ustawień (zakładki SettingsView)
  // PAKIET 8a — kolejność odzwierciedla układ ScrollableTabs w SettingsView
  const settingsSubItems = [
    { id: "general",     label: "Ogólne" },
    { id: "mainview",    label: "Widok główny" },
    { id: "categories",  label: "Kategorie" },
    { id: "equipment",   label: "Wyposażenie" },
    { id: "textiles",    label: "Tekstylia" },
    { id: "team",        label: "Zespół" },
    { id: "formbuilder", label: "Formularz" },
    { id: "sms",         label: "Szablony SMS" },
    { id: "api",         label: "API" },
  ];

  // PAKIET 7.4 — wydzielona grupa "Pozostałe" z "Operacji"
  const operationsItems = [
    { id:"cleaning", icon:"check", label:"Sprzątanie" },
    { id:"tasks",    icon:"tasks", label:"Zadania",  count: taskCount },
    { id:"loans",    icon:"swap",  label:"Pożyczki", count: loanCount },
  ];
  // PAKIET 8a.2 — KW Hotel usunięte z nawigacji (przeniesione do Ustawienia → API).
  // Panel KW jest renderowany jako FloatingModal — Settings → API → "Otwórz panel KW" ustawia showKwModal=true.
  const otherItems = [
    { id:"files",    icon:"file",     label:"Pliki" },
    { id:"owners",   icon:"users",    label:"Właściciele" },
  ];

  const renderBadge = (n) => (n > 0 ? <span className="nav-badge">{n}</span> : null);

  // PAKIET 7.3 — nagłówek grupy jako klikalny przycisk (zwijanie + persist Storage).
  // W trybie navTop nagłówki są ukryte (CSS .app-root.nav-top .sidebar-section { display: none })
  // → klasa sidebar-section-toggle też się chowa, więc zwijanie nie działa na pasku górnym, ale itemy zawsze widoczne.
  const renderGroupHeader = (key, label) => (
    <button type="button" className="sidebar-section sidebar-section-toggle"
      onClick={() => toggleNavGroup(key)}>
      <span className="nav-arrow">{navCollapsed[key] ? "▸" : "▾"}</span>
      <span>{label}</span>
    </button>
  );

  // FIX: SidebarNav jako PLAIN JSX (nie funkcja-komponent), bo `const SidebarNav = () => {}`
  // wewnątrz App tworzył NOWY typ komponentu przy każdym renderze → React unmount/mount
  // → ScrollableTabs resetował scrollLeft do 0 → animacja edge tab zawsze szła „od początku listy".
  const navItems = (
    <>
      <div
        className={`sidebar-item ${tab === "apartments" && !selectedApt && !selectedTask && !selectedOwner ? "active" : ""}`}
        onClick={() => { setTab("apartments"); setSelectedApt(null); setSelectedTask(null); setSelectedOwner(null); }}
      >
        <Icon name="home" size={18} /><span className="sidebar-item-label">Wszystkie pozycje</span>
      </div>

      {categoriesInNav.length > 0 && (
        <>
          {renderGroupHeader("categories", "Kategorie")}
          {!navCollapsed.categories && categoriesInNav.map(cat => {
            const cnt = categoryCounts[cat.name] || 0;
            return (
              <div key={cat.id}
                className={`sidebar-item ${tab === `cat_${cat.id}` ? "active" : ""}`}
                onClick={() => { setTab(`cat_${cat.id}`); setSelectedApt(null); setSelectedTask(null); setSelectedOwner(null); }}
                style={tab === `cat_${cat.id}` ? { borderLeftColor: cat.color, color: cat.color, background: `${cat.color}0a` } : {}}
              >
                <Icon name={cat.icon || "home"} size={18} color={tab === `cat_${cat.id}` ? cat.color : undefined} />
                <span className="sidebar-item-label">{cat.name}</span>
                {renderBadge(cnt)}
              </div>
            );
          })}
        </>
      )}

      {renderGroupHeader("operations", "Operacje")}
      {!navCollapsed.operations && operationsItems.map(item => (
        <div key={item.id}
          className={`sidebar-item ${tab === item.id && !selectedApt && !selectedTask && !selectedOwner ? "active" : ""}`}
          onClick={() => { setTab(item.id); setSelectedApt(null); setSelectedTask(null); setSelectedOwner(null); }}>
          <Icon name={item.icon} size={18} />
          <span className="sidebar-item-label">{item.label}</span>
          {renderBadge(item.count || 0)}
        </div>
      ))}

      {renderGroupHeader("others", "Pozostałe")}
      {!navCollapsed.others && (
        <>
          {otherItems.map(item => (
            <div key={item.id}
              className={`sidebar-item ${tab === item.id && !selectedApt && !selectedTask && !selectedOwner ? "active" : ""}`}
              onClick={() => { setTab(item.id); setSelectedApt(null); setSelectedTask(null); setSelectedOwner(null); }}>
              <Icon name={item.icon} size={18} />
              <span className="sidebar-item-label">{item.label}</span>
            </div>
          ))}
          {/* PAKIET 7.5 — Ustawienia z rozwijanym submenu.
              W trybie lewego menu klik w wiersz rozwija też submenu (strzałka i tak chowana w navTop). */}
          <div
            className={`sidebar-item ${tab === "settings" && !selectedApt && !selectedTask && !selectedOwner ? "active" : ""}`}
            onClick={() => {
              setTab("settings"); setSelectedApt(null); setSelectedTask(null); setSelectedOwner(null);
              if (!navTop && !settingsExpanded) {
                setSettingsExpanded(true);
                Storage.set("nav_settings_expanded", true);
              }
            }}>
            <Icon name="settings" size={18} />
            <span className="sidebar-item-label">Ustawienia</span>
            <button type="button"
              className="sidebar-expand-btn"
              title={settingsExpanded ? "Zwiń" : "Rozwiń zakładki ustawień"}
              onClick={(e) => { e.stopPropagation(); toggleSettingsExpanded(); }}>
              {settingsExpanded ? "▾" : "▸"}
            </button>
          </div>
          {settingsExpanded && settingsSubItems.map(sub => (
            <div key={sub.id}
              className={`sidebar-item sidebar-subitem ${tab === "settings" && settingsInitialTab === sub.id ? "active" : ""}`}
              onClick={() => goToSettingsTab(sub.id)}>
              <span className="sidebar-item-label">{sub.label}</span>
            </div>
          ))}
        </>
      )}
    </>
  );
  const sidebarNav = (
    <nav className="sidebar">
      <div className="sidebar-logo">
        <VelarLogo size={navTop ? 26 : 28} withWordmark taglineText={navTop ? null : "Property Suite"} />
      </div>
      <div className="sidebar-nav">
        {navTop
          ? <ScrollableTabs className="sidebar-nav-scroll">{navItems}</ScrollableTabs>
          : navItems}
      </div>
      <div className="sidebar-footer">
        <div className="sidebar-user">{currentUser.name} · {roleLabel}</div>
        {can(currentUser, "view:audit") && (
          <button onClick={() => setShowAudit(true)} style={{ width:"100%",background:"none",border:"1px solid var(--border)",borderRadius:8,padding:"7px 12px",color:"var(--text2)",fontSize:11,fontWeight:700,cursor:"pointer",marginBottom:6,display:"flex",alignItems:"center",gap:6,letterSpacing:"0.06em" }}>
            <Icon name="shield" size={12} />Audit Log
          </button>
        )}
        <button onClick={handleLogout} style={{ width:"100%",background:"none",border:"1px solid var(--border)",borderRadius:8,padding:"7px 12px",color:"var(--text2)",fontSize:11,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:6,letterSpacing:"0.06em" }}>
          <Icon name="logout" size={12} />Wyloguj
        </button>
      </div>
    </nav>
  );

  // ── Manager routing — selectedTask PRZED selectedApt ─────────────────────
  const sp = { online, queueSize, toast, toastColors, showAudit, onCloseAudit: () => setShowAudit(false) };

  // Detal aktualnie zaznaczonej encji (priorytet: zadanie > apartament > właściciel).
  const detailNode = (() => {
    if (selectedTask) {
      const apt = apartments.find(a => a.id === selectedTask.apartmentId);
      return (
        <TaskDetail task={selectedTask} apt={apt} currentUser={currentUser}
          onBack={() => setSelectedTask(null)}
          onEdit={() => { setEditingTask(selectedTask); setShowTaskForm(true); }}
          onDelete={() => deleteTask(selectedTask.id)}
          onComplete={(id, protocol) => {
            const updates = {
              status: "Zrobione",
              completionExecutor: protocol.executor || "",
              completionNotes: protocol.notes || "",
              completedAt: protocol.date || new Date().toISOString().slice(0,10),
              completionTime: protocol.timeSpent || "",
              completionMaterials: protocol.materials || "",
              completionCost: protocol.costNet || "",
              completionPhotos: protocol.photoLinks || "",
            };
            setTasks(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
            setSelectedTask(prev => prev && prev.id === id ? { ...prev, ...updates } : prev);
          }}
          onAccept={(id, person) => {
            const updates = { status: "W trakcie", acceptedBy: person, acceptedAt: new Date().toISOString() };
            setTasks(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
            setSelectedTask(prev => prev && prev.id === id ? { ...prev, ...updates } : prev);
          }}
        />
      );
    }
    if (selectedApt) {
      const owner = owners.find(o => o.id === selectedApt.ownerId);
      return (
        <ApartmentDetail apt={selectedApt} owner={owner} tasks={tasks} cleaningSessions={cleaningSessions} loans={loans} apartments={apartments} files={files} currentUser={currentUser} initialTab={aptInitialTab}
          onBack={() => { setSelectedApt(null); setAptInitialTab(null); }}
          onEdit={() => { setEditingApt(selectedApt); setShowAptForm(true); }}
          onAddTask={() => { setPrefillApt(selectedApt.id); setShowTaskForm(true); }}
          onSelectTask={(task) => setSelectedTask(task)}
          onRefreshLoans={refreshLoans}
          onRefreshFiles={refreshFiles}
        />
      );
    }
    if (selectedOwner) {
      return (
        <OwnerDetail owner={selectedOwner} apartments={apartments} currentUser={currentUser}
          onBack={() => setSelectedOwner(null)}
          onEdit={() => { setEditingOwner(selectedOwner); setShowOwnerForm(true); }}
          onSelectApt={(apt) => openApt(apt)}
          renderAptIndicators={renderAptIndicators}
        />
      );
    }
    return null;
  })();

  // Modale (apartament / zadanie / właściciel) — renderowane RAZ, działają w obu trybach
  // (pełny ekran i split). onSave aktualizuje też zaznaczoną encję jeśli jest otwarta.
  const modals = (
    <>
      {taskDeleteConfirm}
      {showAptForm && <ApartmentForm apt={editingApt} owners={owners} defaultCategory={defaultCategory} onSave={f => { saveApt(f); if (selectedApt) setSelectedApt(a => ({ ...a, ...f })); }} onClose={() => { setShowAptForm(false); setEditingApt(null); }} onGoToSettings={() => { setShowAptForm(false); setTab("settings"); }} />}
      {showTaskForm && <TaskForm task={editingTask || (prefillApt ? { apartmentId: prefillApt } : null)} apartments={apartments} onSave={saveTask} onToast={showToast} onClose={() => { setShowTaskForm(false); setEditingTask(null); setPrefillApt(null); }} />}
      {showOwnerForm && <OwnerForm owner={editingOwner} onSave={o => { saveOwner(o); if (selectedOwner) setSelectedOwner(prev => ({ ...prev, ...o })); }} onClose={() => { setShowOwnerForm(false); setEditingOwner(null); }} />}
    </>
  );

  // Wąski ekran (< 1280px): detal na pełnym ekranie z przyciskiem „wstecz" (jak dotąd).
  if (detailNode && !isWide) {
    return (
      <div className={`app-root ${navTop ? "nav-top" : ""}`}>
        {sidebarNav}
        <Shell {...sp}>
          {detailNode}
          {modals}
        </Shell>
      </div>
    );
  }

  // ── Main navigation ────────────────────────────────────────────────────────
  const tabContent = (
    <>
      {tab === "apartments" && (
        <>
          <div className="header">
            <h1>Apartamenty</h1>
            <div className="header-actions">
              <div className="role-badge manager"><Icon name="shield" size={10} />Manager</div>
              {can(currentUser, "view:audit") && (
                <button className="icon-btn" onClick={() => setShowAudit(true)} title="Audit Log">
                  <Icon name="shield" size={16} color="var(--accent)" />
                </button>
              )}
              <button className="icon-btn" onClick={handleKwSync} title="Synchronizuj z KW Hotel">
                <Icon name="sync" size={16} color={kwSyncing ? "var(--accent)" : "currentColor"} />
              </button>
              <button className="icon-btn" onClick={handleLogout} title="Wyloguj"><Icon name="logout" size={16} /></button>
            </div>
          </div>
          <div className="content">
            <div className="sync-banner">
              <div className="sync-dot" />
              <div>
                <div style={{ fontSize:13,fontFamily:"var(--font-display)",fontWeight:400,letterSpacing:"0.08em" }}>KW Hotel — połączono</div>
                <div style={{ fontSize:11,color:"var(--text2)" }}>Ostatnia synchronizacja: dzisiaj 20:05</div>
              </div>
              <button className="icon-btn" style={{ marginLeft:"auto" }} onClick={handleKwSync}><Icon name="sync" size={14} /></button>
            </div>
            {/* Pasek wyszukiwania */}
            <div className="search-bar">
              <Icon name="search" size={16} color="var(--text2)" />
              <input
                placeholder="Szukaj: nazwa, adres, piętro, notatki..."
                value={aptSearch}
                onChange={e => setAptSearch(e.target.value)}
                autoComplete="off"
              />
              {aptSearch && (
                <button onClick={() => setAptSearch("")} style={{ background:"none",border:"none",color:"var(--text2)",cursor:"pointer",padding:0,lineHeight:1 }}>
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>

            {/* Filtry statusowe */}
            <div className="filter-row">
              {["Wszystkie", ...categories.map(c => c.name)].map(f => (
                <div key={f} className={`filter-chip ${aptFilter === f ? "active" : ""}`} onClick={() => setAptFilter(f)}>{f}</div>
              ))}
            </div>

            {/* Filtry zaawansowane — toggle */}
            <div style={{ marginBottom:12 }}>
              <button
                onClick={() => setAptFiltersOpen(o => !o)}
                style={{ background:"none",border:"1px solid var(--border)",borderRadius:20,padding:"5px 14px",fontSize:11,fontWeight:700,color:advFiltersActive?"var(--accent)":"var(--text2)",cursor:"pointer",display:"flex",alignItems:"center",gap:6,letterSpacing:"0.08em" }}
              >
                <Icon name="search" size={12} color={advFiltersActive?"var(--accent)":"var(--text2)"} />
                FILTRY ZAAWANSOWANE {advFiltersActive && `(${Object.values(aptAdvFilters).filter(v=>v).length})`}
                {advFiltersActive && (
                  <span onClick={e => { e.stopPropagation(); clearAdvFilters(); }} style={{ marginLeft:4,color:"var(--text2)",fontWeight:400 }}>✕ wyczyść</span>
                )}
              </button>

              {aptFiltersOpen && (
                <div style={{ marginTop:10,display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,padding:"14px",background:"var(--surface)",border:"1px solid var(--border)",borderRadius:12 }}>
                  <div style={{ gridColumn:"1/-1" }}>
                    <label style={{ fontSize:10,color:"var(--text2)",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:4 }}>Status apartamentu</label>
                    <select className="form-select" style={{ fontSize:12 }} value={aptAdvFilters.aptStatus} onChange={e => setAdvFilter("aptStatus", e.target.value)}>
                      <option value="">Wszystkie</option>
                      <option value="Wolny">Wolny</option>
                      <option value="Zajęty">Zajęty</option>
                      <option value="Wolny/Dzisiaj przyjazd">Wolny/Dzisiaj przyjazd</option>
                      <option value="Dzisiaj wyjazd gości">Dzisiaj wyjazd gości</option>
                      <option value="Zajęty/Jutro się zwolni">Zajęty/Jutro się zwolni</option>
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize:10,color:"var(--text2)",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:4 }}>Piętro</label>
                    <select className="form-select" style={{ fontSize:12 }} value={aptAdvFilters.floor} onChange={e => setAdvFilter("floor", e.target.value)}>
                      <option value="">Wszystkie</option>
                      {uniqueFloors.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize:10,color:"var(--text2)",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:4 }}>Parking</label>
                    <select className="form-select" style={{ fontSize:12 }} value={aptAdvFilters.parking} onChange={e => setAdvFilter("parking", e.target.value)}>
                      <option value="">Wszystkie</option>
                      {uniqueParking.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize:10,color:"var(--text2)",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:4 }}>Min. osób</label>
                    <select className="form-select" style={{ fontSize:12 }} value={aptAdvFilters.minCapacity} onChange={e => setAdvFilter("minCapacity", e.target.value)}>
                      <option value="">Dowolna</option>
                      {[2,4,5,6].map(n => <option key={n} value={n}>{n}+</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize:10,color:"var(--text2)",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:4 }}>Max od morza (m)</label>
                    <select className="form-select" style={{ fontSize:12 }} value={aptAdvFilters.maxSea} onChange={e => setAdvFilter("maxSea", e.target.value)}>
                      <option value="">Dowolna</option>
                      <option value="0">Bezpośrednio (0 m)</option>
                      <option value="100">do 100 m</option>
                      <option value="200">do 200 m</option>
                      <option value="500">do 500 m</option>
                    </select>
                  </div>
                  <div style={{ gridColumn:"1/-1" }}>
                    <label style={{ fontSize:10,color:"var(--text2)",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:4 }}>Typ zabezpieczenia</label>
                    <select className="form-select" style={{ fontSize:12 }} value={aptAdvFilters.secType} onChange={e => setAdvFilter("secType", e.target.value)}>
                      <option value="">Wszystkie</option>
                      {uniqueSecTypes.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
              )}
            </div>

            {/* Licznik wyników */}
            <div style={{ fontSize:11,color:"var(--text2)",fontWeight:600,marginBottom:8,letterSpacing:"0.06em",textTransform:"uppercase" }}>
              {filteredApts.length} {filteredApts.length === 1 ? "apartament" : filteredApts.length < 5 ? "apartamenty" : "apartamentów"}
              {(aptSearch || aptFilter !== "Wszystkie" || advFiltersActive) && (
                <button onClick={() => { setAptSearch(""); setAptFilter("Wszystkie"); clearAdvFilters(); }}
                  style={{ marginLeft:8,background:"none",border:"none",color:"var(--text2)",cursor:"pointer",fontSize:11,textDecoration:"underline",fontWeight:600 }}>
                  wyczyść filtry
                </button>
              )}
            </div>

            <div>
              {filteredApts.length === 0
                ? <div className="empty"><h3>Brak wyników</h3><p style={{ fontSize:13,color:"var(--text2)",marginTop:6 }}>Zmień kryteria wyszukiwania</p></div>
                : <div className="apt-list-grid" style={aptColumns === "single" ? { gridTemplateColumns:"1fr" } : undefined}>{filteredApts.map(apt => {
                  return (
                    <div key={apt.id} className={`apt-row ${selectedApt && selectedApt.id === apt.id ? "active" : ""}`} onClick={() => openApt(apt)}>
                      <div className="apt-row-left">
                        <div style={{ minWidth:0 }}>
                          <div style={{ display:"flex",alignItems:"center",gap:8,flexWrap:"wrap" }}>
                            <div className="apt-row-name">{apt.name}</div>
                            {apt.capacity > 0 && <span style={{ fontSize:10,color:"var(--text2)",fontWeight:600 }}>👥 {apt.capacity} os.</span>}
                          </div>
                          {renderAptIndicators(apt)}
                        </div>
                      </div>
                      <div style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:5,flexShrink:0 }}>
                        {apt.aptStatus && <StatusBadge status={apt.aptStatus} />}
                        {apt.status && <span style={{ fontSize:9,fontWeight:700,color:APT_TYPE_COLORS[apt.status]||"var(--text2)",letterSpacing:"0.06em",textTransform:"uppercase",textAlign:"center" }}>{apt.status}</span>}
                      </div>
                    </div>
                  );
                })}</div>}
            </div>
          </div>
          {!isReadOnly && <button className="fab" onClick={() => { setEditingApt(null); setDefaultCategory(""); setShowAptForm(true); }}>
            <Icon name="plus" size={22} color="#000" />
          </button>}
        </>
      )}

      {/* ── CLEANING TAB ── */}
      {tab === "cleaning" && (
        <CleaningManagerView
          apartments={apartments}
          cleaningSessions={cleaningSessions}
          onAddSession={handleAddSession}
          onUpdateSession={handleUpdateSession}
          onDeleteSession={handleDeleteSession}
          currentUser={currentUser}
        />
      )}

      {/* ── SETTINGS TAB ── */}
      {tab === "settings" && (
        <SettingsView
          apartments={apartments}
          currentUser={currentUser}
          onCategoriesChange={refreshCategories}
          theme={theme}
          onToggleTheme={toggleTheme}
          aptColumns={aptColumns}
          onSetAptColumns={setAptColumns}
          navPos={navPos}
          onSetNavPos={setNavPos}
          initialTab={settingsInitialTab}
          initialTabBump={settingsTabBump}
          onOpenKw={() => setShowKwModal(true)}
        />
      )}

      {/* ── LOANS TAB ── */}
      {tab === "loans" && (
        <LoansView
          apartments={apartments}
          loans={loans}
          onUpdate={refreshLoans}
          currentUser={currentUser}
        />
      )}

      {/* ── FILES TAB ── */}
      {tab === "files" && (
        <FilesView
          apartments={apartments}
          files={files}
          onUpdate={refreshFiles}
          currentUser={currentUser}
        />
      )}

      {/* ── CATEGORY-FILTERED APARTMENTS TAB ── */}
      {tab.startsWith("cat_") && (() => {
        const catId = tab.slice(4);
        const cat = categories.find(c => c.id === catId);
        if (!cat) {
          return (
            <div className="content">
              <div className="empty">
                <div className="empty-icon"><Icon name="info" size={40} /></div>
                <h3>Kategoria nie istnieje</h3>
                <p style={{ fontSize:13, color:"var(--text2)", marginTop:6 }}>
                  Została prawdopodobnie usunięta. Wybierz inną zakładkę z menu bocznego.
                </p>
              </div>
            </div>
          );
        }
        const filtered = apartments.filter(a => a.status === cat.name);
        return (
          <>
            <div className="header">
              <h1 style={{ color: cat.color }}>{cat.name}</h1>
              <div className="header-actions">
                <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.1em", color:"var(--text2)", padding:"4px 10px", borderRadius:6, background:"var(--surface2)" }}>
                  {filtered.length} {filtered.length === 1 ? "pozycja" : "pozycji"}
                </div>
                {!isReadOnly && (
                  <button className="icon-btn" onClick={() => { setEditingApt(null); const c = categories.find(x=>x.id===tab.slice(4)); setDefaultCategory(c && c.name||""); setShowAptForm(true); }} title="Dodaj pozycję">
                    <Icon name="plus" size={16} color="var(--accent)" />
                  </button>
                )}
                <button className="icon-btn" onClick={handleLogout} title="Wyloguj"><Icon name="logout" size={16} /></button>
              </div>
            </div>
            <div className="content">
              <p style={{ fontSize:13, color:"var(--text2)", marginBottom:16, lineHeight:1.6 }}>
                Pozycje z kategorii <strong style={{ color: cat.color }}>{cat.name}</strong>
              </p>
              {filtered.length === 0 ? (
                <div className="empty">
                  <div className="empty-icon"><Icon name={cat.icon || "home"} size={40} color={cat.color} /></div>
                  <h3>Brak pozycji w tej kategorii</h3>
                  {!isReadOnly && (
                    <button className="btn btn-primary" style={{ marginTop:16 }} onClick={() => { setEditingApt(null); setShowAptForm(true); }}>
                      + Dodaj pierwszą pozycję
                    </button>
                  )}
                </div>
              ) : (
                <div>
                  {filtered.map(apt => {
                    return (
                      <div key={apt.id} className={`apt-row ${selectedApt && selectedApt.id === apt.id ? "active" : ""}`} onClick={() => openApt(apt)}>
                        <div className="apt-row-left">
                          <div style={{ minWidth:0 }}>
                            <div style={{ display:"flex",alignItems:"center",gap:8,flexWrap:"wrap" }}>
                              <div className="apt-row-name">{apt.name}</div>
                              {apt.capacity > 0 && <span style={{ fontSize:10,color:"var(--text2)",fontWeight:600 }}>👥 {apt.capacity} os.</span>}
                            </div>
                            {renderAptIndicators(apt)}
                          </div>
                        </div>
                        <div style={{ display:"flex",flexDirection:"column",alignItems:"center",gap:5,flexShrink:0 }}>
                          {apt.aptStatus && <StatusBadge status={apt.aptStatus} />}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        );
      })()}
      {tab === "tasks" && (
        <>
          <div className="header">
            <h1>Zadania</h1>
            <div className="header-actions">
              <button className="icon-btn" onClick={handleLogout} title="Wyloguj"><Icon name="logout" size={16} /></button>
            </div>
          </div>
          <div className="content">
            {/* FIX 9.4 — wyszukiwanie zadań */}
            <input
              className="form-input"
              placeholder="🔍 Szukaj zadań (tytuł, notatki, osoba)..."
              value={taskSearch}
              onChange={e => setTaskSearch(e.target.value)}
              style={{ marginBottom: 12 }}
            />
            <div className="filter-row">
              {["Wszystkie","Nie rozpoczęto","W trakcie","Zrobione"].map(f => (
                <div key={f} className={`filter-chip ${taskFilter === f ? "active" : ""}`} onClick={() => setTaskFilter(f)}>{f}</div>
              ))}
            </div>
            <div className="section-header">
              <span className="section-title">{filteredTasks.length} zadań</span>
            </div>
            {filteredTasks.length === 0
              ? <div className="empty"><div className="empty-icon"><Icon name="tasks" size={40} /></div><h3>Brak zadań</h3></div>
              : filteredTasks.map(task => {
                const apt = apartments.find(a => a.id === task.apartmentId);
                return (
                  <div key={task.id} className={`task-card ${selectedTask && selectedTask.id === task.id ? "active" : ""}`} onClick={() => setSelectedTask(task)}>
                    <div className="task-card-header">
                      <div style={{ flex:1, minWidth:0 }}>
                        {apt && <div className="task-apt">{apt.name}</div>}
                        <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", margin:"4px 0 6px" }}>
                          <PriorityTile priority={task.priority} />
                          <TaskStatusBadge status={task.status} />
                        </div>
                        <div className="task-title">{task.title}</div>
                      </div>
                    </div>
                    <div className="task-meta">
                      <div className="task-assignee"><div className="avatar">{task.assignedTo && task.assignedTo[0] || "?"}</div>{task.assignedTo}</div>
                      <span style={{ fontSize:11,color:"var(--text2)" }}>{task.createdAt}</span>
                      {task.nextCheckout && (
                        <span style={{ fontSize:11,color:"var(--green)",display:"flex",alignItems:"center",gap:4 }}>
                          <Icon name="calendar" size={11} color="var(--green)" />{task.nextCheckout.slice(0,10)}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
          {!isReadOnly && <button className="fab" onClick={() => { setEditingTask(null); setShowTaskForm(true); }}>
            <Icon name="plus" size={22} color="#000" />
          </button>}
        </>
      )}

      {tab === "owners" && (
        <>
          <div className="header">
            <h1>Właściciele</h1>
            <div className="header-actions">
              <button className="icon-btn" onClick={handleLogout} title="Wyloguj"><Icon name="logout" size={16} /></button>
            </div>
          </div>
          <div className="content">
            {owners.map(owner => {
              const ownerApts = apartments.filter(a => a.ownerId === owner.id);
              const expanded = expandedOwnerId === owner.id;
              return (
                <div key={owner.id} className={`owner-card ${selectedOwner && selectedOwner.id === owner.id ? "active" : ""}`} onClick={() => setSelectedOwner(owner)}>
                  <div className="owner-header">
                    <button type="button" className="owner-count-tile"
                      title={expanded ? "Ukryj pozycje" : "Pokaż przypisane pozycje"}
                      onClick={(e) => { e.stopPropagation(); setExpandedOwnerId(expanded ? null : owner.id); }}>
                      <span className="owner-count-num">{ownerApts.length}</span>
                      <span className="owner-count-label">poz.</span>
                    </button>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div className="owner-name">{owner.lastName} {owner.firstName}</div>
                      {owner.phone && <div className="owner-sub">{owner.phone}</div>}
                      {owner.email && <div className="owner-sub" style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{owner.email}</div>}
                      {!owner.phone && !owner.email && <div className="owner-sub">—</div>}
                    </div>
                    <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:6, flexShrink:0 }}>
                      {owner.status && <span style={{ fontSize:9,fontWeight:700,letterSpacing:"0.08em",color:APT_TYPE_COLORS[owner.status]||"var(--text2)",textTransform:"uppercase",padding:"3px 8px",borderRadius:6,background:`${APT_TYPE_COLORS[owner.status]||"#888"}1a` }}>{owner.status}</span>}
                      {owner.percent > 0 && <span style={{ fontFamily:"var(--font-display)",fontWeight:600,fontSize:22,color:"var(--accent)",letterSpacing:"0.02em",lineHeight:1 }}>{owner.percent}%</span>}
                    </div>
                  </div>
                  {expanded && (
                    <div className="owner-apts-list" onClick={(e) => e.stopPropagation()}>
                      <div className="owner-apts-head">{ownerApts.length} {plForm(ownerApts.length, "pozycja", "pozycje", "pozycji")}</div>
                      {ownerApts.length === 0 ? (
                        <div style={{ fontSize:13, color:"var(--text2)" }}>Brak przypisanych pozycji.</div>
                      ) : ownerApts.map(a => (
                        <div key={a.id} className="owner-apt-item" onClick={() => openApt(a)}>
                          <span className="owner-apt-name">{a.name}</span>
                          {a.aptStatus && <StatusBadge status={a.aptStatus} />}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {!isReadOnly && <button className="fab" onClick={() => { setEditingOwner(null); setShowOwnerForm(true); }}>
            <Icon name="plus" size={22} color="#000" />
          </button>}
        </>
      )}

      {/* PAKIET 8a.2 — Panel KW jako FloatingModal (otwierany z Ustawienia → API). */}
      {showKwModal && (
        <FloatingModal open onClose={() => setShowKwModal(false)} title="KW Hotel" size="lg">
          <div className="kw-card">
            <div className="kw-header">
              <div className="kw-logo">KW</div>
              <div><div className="kw-title">KW Hotel Integration</div><div className="kw-sub">REST API v2 — połączono</div></div>
              <div className="sync-dot" style={{ marginLeft:"auto" }} />
            </div>
            <button className="btn btn-primary" onClick={handleKwSync} style={{ marginTop:4 }}>
              {kwSyncing ? "Synchronizuję..." : "Synchronizuj teraz"}
            </button>
          </div>
          <div style={{ background:"var(--surface)",border:"1px solid var(--border)",borderRadius:"var(--radius)",padding:16,marginBottom:12 }}>
            <div style={{ fontSize:10,color:"var(--text2)",textTransform:"uppercase",letterSpacing:"0.1em",fontWeight:700,marginBottom:12 }}>Aktywne rezerwacje</div>
            {apartments.filter(a => a.aptStatus==="Zajęty"||a.aptStatus==="Wolny/Dzisiaj przyjazd").map(a => (
              <div key={a.id} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:"1px solid var(--border)" }}>
                <div>
                  <div style={{ fontFamily:"var(--font-display)",fontSize:16,letterSpacing:"0.06em" }}>{a.name}</div>
                  <div style={{ fontSize:11,color:"var(--text2)",marginTop:2 }}>{a.onlineName}</div>
                </div>
                <StatusBadge status={a.aptStatus} />
              </div>
            ))}
          </div>
          <div style={{ background:"var(--surface)",border:"1px solid var(--border)",borderRadius:"var(--radius)",padding:16 }}>
            <div style={{ fontSize:10,color:"var(--text2)",textTransform:"uppercase",letterSpacing:"0.1em",fontWeight:700,marginBottom:12 }}>Konfiguracja API</div>
            <div className="form-group"><label className="form-label">API URL</label><input className="form-input" defaultValue="https://api.kwhotel.com/v2/" /></div>
            <div className="form-group"><label className="form-label">Token</label><input className="form-input" type="password" defaultValue="••••••••••••••••" /></div>
            <div className="form-group">
              <label className="form-label">Auto-sync co</label>
              <select className="form-select" defaultValue="30">
                <option value="5">Co 5 minut</option><option value="15">Co 15 minut</option>
                <option value="30">Co 30 minut</option><option value="60">Co godzinę</option>
              </select>
            </div>
            <button className="btn btn-primary">Zapisz konfigurację</button>
          </div>
        </FloatingModal>
      )}

      {/* Mobile "more" menu overlay */}
      {showMoreMenu && (
        <div style={{ position:"fixed", bottom:70, left:0, right:0, zIndex:110, padding:"0 12px" }}>
          <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:16, padding:8, maxWidth:430, margin:"0 auto", boxShadow:"0 -4px 20px rgba(0,0,0,0.3)" }}>
            {[["owners","users","Właściciele"],["files","file","Pliki"],["loans","swap","Pożyczki"],["settings","settings","Ustawienia"]].map(([t, icon, label]) => (
              <button key={t} onClick={() => { setTab(t); setShowMoreMenu(false); }}
                style={{ display:"flex", alignItems:"center", gap:12, width:"100%", padding:"12px 16px", background:tab === t ? "var(--surface2)" : "none", border:"none", borderRadius:10, color:tab === t ? "var(--accent)" : "var(--text)", cursor:"pointer", fontSize:14, fontWeight:tab === t ? 700 : 500, fontFamily:"var(--font-body)" }}>
                <Icon name={icon} size={18} color={tab === t ? "var(--accent)" : "var(--text2)"} />{label}
              </button>
            ))}
          </div>
        </div>
      )}
      {showMoreMenu && <div style={{ position:"fixed", inset:0, zIndex:105 }} onClick={() => setShowMoreMenu(false)} />}

      <nav className="bottom-nav">
        {[["apartments","home","Pozycje"],["cleaning","check","Sprzątanie"],["tasks","tasks","Zadania"]].map(([t, icon, label]) => (
          <button key={t} className={`nav-item ${tab === t ? "active" : ""}`} onClick={() => { setTab(t); setShowMoreMenu(false); }}>
            <Icon name={icon} size={20} /><span>{label}</span>
          </button>
        ))}
        <button className={`nav-item ${showMoreMenu || ["owners","files","loans","settings"].includes(tab) ? "active" : ""}`}
          onClick={() => setShowMoreMenu(m => !m)}>
          <Icon name="info" size={20} /><span>Więcej</span>
        </button>
      </nav>
    </>
  );

  return (
    <div className={`app-root ${navTop ? "nav-top" : ""}`}>
      {sidebarNav}
      <Shell {...sp}>
        {detailNode && isWide ? (
          <div className="md-split">
            <div className="md-master">{tabContent}</div>
            <div className="md-detail">{detailNode}</div>
          </div>
        ) : tabContent}
        {modals}
      </Shell>
    </div>
  );
}
