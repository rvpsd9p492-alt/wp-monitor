/* Cloud-Sicherung über Supabase (Auth + REST, ohne Zusatzbibliothek), Tabelle wp_records.
   Gleiches Supabase-Projekt und gleiches Konto wie die Leichtathletik-App, eigene Tabelle.
   Ablauf: 1. vom Server holen, was seit dem letzten Abgleich neu ist, 2. lokal zusammenführen
   (neuere Änderung gewinnt), 3. lokale Änderungen und Löschungen hochladen. */
(function () {
  "use strict";
  const CFG = window.WP_CLOUD || {};
  const URL_ = String(CFG.url || "").replace(/\/+$/, "");
  const KEY = String(CFG.anonKey || "");
  const configured = !!(URL_ && KEY);
  const K = WP.KEYS, KINDS = WP.KINDS;
  const OVERLAP_MS = 5 * 60 * 1000, PAGE = 1000;

  const st = () => WP.load(K.cloud, {}) || {};
  const put = (s) => WP.save(K.cloud, s);
  let syncing = false, timer = null, again = false;
  const listeners = new Set();

  // Postgres liefert Mikrosekunden; Safari liest sicher nur Millisekunden.
  const ms = (t) => {
    if (!t) return 0;
    const v = new Date(String(t).replace(/(\.\d{3})\d+/, "$1").replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")).getTime();
    return isFinite(v) ? v : 0;
  };

  function eachLocal(fn) { // fn(kind, id, data, updatedAt)
    const d = WP.data();
    Object.keys(KINDS).forEach((kind) => d[KINDS[kind]].forEach((r) => fn(kind, r.id, r, r.updatedAt)));
    fn("config", "config", d.config, d.config.updatedAt);
  }
  function pending() {
    const pushed = st().pushed || {};
    let n = 0;
    eachLocal((kind, id, r, at) => { if (ms(at) > 0 && pushed[kind + ":" + id] !== ms(at)) n++; });
    return n + (WP.load(K.deleted, []) || []).length;
  }
  function status() {
    const s = st(), loggedIn = !!(s.session && s.session.refresh_token), p = loggedIn ? pending() : 0;
    return { configured, loggedIn, email: loggedIn ? s.session.email : null, syncing, pending: p,
      lastSyncAt: s.lastSyncAt || null, error: s.error || null, clean: loggedIn && p === 0 && !!s.lastSyncAt && !s.error };
  }
  function emit() { const x = status(); listeners.forEach((fn) => { try { fn(x); } catch (e) {} }); }

  /* ---------- HTTP ---------- */
  class CloudError extends Error { constructor(msg, code) { super(msg); this.code = code; } }
  async function http(path, o) {
    o = o || {};
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try {
      res = await fetch(URL_ + path, {
        method: o.method || "GET",
        headers: Object.assign({ apikey: KEY, "Content-Type": "application/json" },
          o.token ? { Authorization: "Bearer " + o.token } : {}, o.headers || {}),
        body: o.body ? JSON.stringify(o.body) : undefined, signal: ctrl.signal,
      });
    } catch (e) { throw new CloudError("Keine Verbindung zum Server.", "offline"); } finally { clearTimeout(t); }
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) throw new CloudError(String(data && (data.error_description || data.msg || data.message || data.error) || "Fehler " + res.status), res.status);
    return data;
  }
  function germanAuthError(e) {
    const m = String(e && e.message || "");
    if (e && e.code === "offline") return "Keine Internetverbindung.";
    if (/invalid login credentials/i.test(m)) return "E-Mail oder Passwort falsch.";
    if (/email not confirmed/i.test(m)) return "E-Mail-Adresse noch nicht bestätigt.";
    if (/rate limit|too many/i.test(m)) return "Zu viele Versuche – bitte kurz warten.";
    return m;
  }

  /* ---------- Anmeldung ---------- */
  function storeSession(d) {
    const s = st();
    s.session = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + (d.expires_in || 3600) * 1000,
      user_id: d.user && d.user.id, email: d.user && d.user.email };
    s.error = null;
    put(s);
  }
  async function signIn(email, password) {
    if (!configured) throw new Error("Cloud-Sicherung ist nicht eingerichtet.");
    try {
      const d = await http("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } });
      const prev = st().session;
      if (prev && prev.user_id && d.user && prev.user_id !== d.user.id) put({}); // anderes Konto: alles neu abgleichen
      storeSession(d);
    } catch (e) { throw new Error(germanAuthError(e)); }
    emit();
    return sync({ force: true });
  }
  async function signOut() {
    const s = st();
    if (s.session && s.session.access_token) http("/auth/v1/logout", { method: "POST", token: s.session.access_token }).catch(() => {});
    put({}); emit();
  }
  async function token() {
    const s = st();
    if (!s.session || !s.session.refresh_token) throw new CloudError("Nicht angemeldet.", "auth");
    if (s.session.access_token && s.session.expires_at - Date.now() > 60000) return s.session;
    try {
      storeSession(await http("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: s.session.refresh_token } }));
      return st().session;
    } catch (e) {
      if (e.code === "offline") throw e;
      const s2 = st(); delete s2.session; s2.error = "Anmeldung abgelaufen – bitte erneut anmelden."; put(s2);
      throw new CloudError(s2.error, "auth");
    }
  }

  /* ---------- Abgleich ---------- */
  function applyRemote(rows, s) {
    const pushed = s.pushed || (s.pushed = {}), d = WP.data(), tomb = WP.load(K.deleted, []) || [];
    let changed = false;
    rows.forEach((row) => {
      const t = ms(row.updated_at), key = row.kind + ":" + row.id;
      if (row.kind === "config") {
        if (!row.deleted && row.data && t > ms(d.config.updatedAt)) {
          d.config = { values: row.data.values || {}, updatedAt: new Date(t).toISOString() }; changed = true;
        }
        pushed[key] = t;
        return;
      }
      const field = KINDS[row.kind];
      if (!field) return; // unbekannte Art (neuere App-Version): ignorieren
      const list = d[field], i = list.findIndex((x) => x.id === row.id), local = i >= 0 ? list[i] : null;
      if (local && ms(local.updatedAt) > t) return; // lokal neuer → wird hochgeladen
      const lt = tomb.find((x) => x.kind === row.kind && x.id === row.id);
      if (lt && ms(lt.at) > t) return; // lokal später gelöscht → Löschung wird hochgeladen
      if (row.deleted) { if (local) { list.splice(i, 1); changed = true; } }
      else if (row.data) {
        const rec = Object.assign({}, row.data, { id: row.id, updatedAt: new Date(t).toISOString() });
        if (i >= 0) list[i] = rec; else list.push(rec);
        changed = true;
      }
      pushed[key] = t;
    });
    if (changed) WP.save(K.data, d);
    return changed;
  }
  async function pull(sess, s) {
    let cursor = s.cursor ? new Date(ms(s.cursor) - OVERLAP_MS).toISOString() : null, changed = false, maxAt = s.cursor || null;
    for (;;) {
      const rows = await http("/rest/v1/wp_records?select=kind,id,data,deleted,updated_at,server_at&order=server_at.asc&limit=" + PAGE
        + (cursor ? "&server_at=gt." + encodeURIComponent(cursor) : ""), { token: sess.access_token });
      if (!Array.isArray(rows) || !rows.length) break;
      if (applyRemote(rows, s)) changed = true;
      const last = rows[rows.length - 1].server_at;
      if (!maxAt || ms(last) > ms(maxAt)) maxAt = last;
      if (rows.length < PAGE) break;
      cursor = last;
    }
    s.cursor = maxAt;
    return changed;
  }
  async function push(sess, s) {
    const pushed = s.pushed || (s.pushed = {}), rows = [], marks = [];
    const add = (kind, id, data, at, deleted) => {
      rows.push({ user_id: sess.user_id, kind, id, data, deleted: !!deleted, updated_at: at });
      marks.push([kind + ":" + id, ms(at)]);
    };
    // Vorgaben mit Zeitstempel 1970 (öffentliche Gradtagzahlen) liegen auf jedem Gerät schon vor: nicht hochladen
    eachLocal((kind, id, r, at) => { if (ms(at) > 0 && pushed[kind + ":" + id] !== ms(at)) add(kind, id, r, at); });
    const tomb = WP.load(K.deleted, []) || [];
    tomb.forEach((x) => add(x.kind, x.id, null, x.at, true));
    for (let i = 0; i < rows.length; i += 500) {
      await http("/rest/v1/wp_records?on_conflict=user_id,kind,id", { method: "POST", token: sess.access_token,
        body: rows.slice(i, i + 500), headers: { Prefer: "resolution=merge-duplicates,return=minimal" } });
    }
    marks.forEach(([k, t]) => { pushed[k] = t; });
    const sent = new Set(tomb.map((x) => x.kind + ":" + x.id + ":" + x.at));
    WP.save(K.deleted, (WP.load(K.deleted, []) || []).filter((x) => !sent.has(x.kind + ":" + x.id + ":" + x.at)));
    return rows.length;
  }
  async function sync(opts) {
    if (!configured) return status();
    const s0 = st();
    if (!s0.session || !s0.session.refresh_token) return status();
    if (syncing) { again = true; return status(); }
    if (!(opts && opts.force) && navigator.onLine === false) return status();
    syncing = true; emit();
    let changed = false;
    try {
      const sess = await token(), s = st();
      changed = await pull(sess, s);
      put(s);
      await push(sess, s);
      s.lastSyncAt = new Date().toISOString(); s.error = null;
      put(s);
    } catch (e) {
      const s = st(); s.error = e.code === "offline" ? null : (e.message || "Abgleich fehlgeschlagen."); put(s);
    } finally { syncing = false; }
    emit();
    if (changed) window.dispatchEvent(new CustomEvent("wp:synced"));
    if (again) { again = false; schedule(500); }
    return status();
  }
  function schedule(delay) {
    if (!configured || !status().loggedIn) return;
    clearTimeout(timer);
    timer = setTimeout(() => sync(), delay == null ? 2000 : delay);
  }

  window.addEventListener("wp:changed", () => { emit(); schedule(); });
  window.addEventListener("online", () => schedule(500));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") schedule(300); });
  if (configured) setTimeout(() => sync(), 300);

  /* ---------- Schlüssel für Home Assistant ---------- */
  // Eigener geheimer Schlüssel je Benutzer; damit legt Home Assistant über die Funktion wp_ingest Ablesungen an.
  function newToken() {
    const b = new Uint8Array(24); crypto.getRandomValues(b);
    return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function ingestKey(opts) {
    const sess = await token();
    let tok = null;
    if (!(opts && opts.renew)) {
      const rows = await http("/rest/v1/wp_ingest_tokens?select=token", { token: sess.access_token });
      tok = Array.isArray(rows) && rows[0] ? rows[0].token : null;
    }
    if (!tok && opts && opts.create) {
      tok = newToken();
      await http("/rest/v1/wp_ingest_tokens?on_conflict=user_id", { method: "POST", token: sess.access_token,
        body: [{ user_id: sess.user_id, token: tok }], headers: { Prefer: "resolution=merge-duplicates,return=minimal" } });
    }
    return tok ? { token: tok, url: URL_ + "/rest/v1/rpc/wp_ingest", apikey: KEY } : null;
  }

  WP.cloud = { configured, status, signIn, signOut, sync, ingestKey, onStatus: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
})();
