/*
 * app.js — registratore delle lezioni (pagina del link in bio).
 *
 * Percorso dell'audio (versione del 9 ottobre 2026, dopo una lezione persa: i pezzi WAV non compressi
 * richiedevano circa 470 kbit/s in invio, più di quanto la rete dell'aula reggesse):
 *   microfono → worklet.js (24.000 Hz) → motore.js: compressione Opus SUL TELEFONO (24 kbit/s: un'ora
 *   ≈ 11 MB, 14 volte meno del WAV) in un file Ogg costruito pagina per pagina (circa 1 s di audio
 *   ciascuna) → ogni pagina salvata SUBITO sul telefono (IndexedDB) → invio al cloud circa ogni 10 s, per
 *   posizione in byte, con richieste che si adattano alla rete (più piccole se è lenta, più grandi per
 *   recuperare l'arretrato) → all'arresto gli ultimi secondi viaggiano insieme alla richiesta di
 *   chiusura: quando compare "Salvata nel cloud" il file è nel cloud, con la stessa dimensione che ha sul
 *   telefono.
 *
 *  - La copia sul telefono resta anche dopo l'invio (ultime registrazioni) e si può scaricare.
 *  - Quando l'audio non riesce a partire, un segnale di vita di pochi byte (ogni 30 s) dice al cloud che
 *    la registrazione continua e quanto audio è in attesa: il cloud non la chiude.
 *  - Browser senza codificatore Opus (WebCodecs): registratore integrato del browser (m4a o webm).
 *  - "Segmento" = un file nel cloud. Diventano due alla fine della lezione se ne comincia subito
 *    un'altra, o se il cloud ha chiuso la registrazione mentre il telefono era senza rete (il resto
 *    va in un secondo file della stessa lezione: nulla va perso).
 *  - Audio rimasto sul telefono dalla versione precedente (WAV a pezzi numerati): viene inviato come prima.
 */
(function () {
  'use strict';

  var ENDPOINT = 'https:\/\/script.google.com/macros/s/AKfycbwOD_JmvrcildRkTfVQ6FKFkxIieSZOLPqISfoeN7pkRKOgSQZ53n1NiOjm8snDlu4mVQ/exec'; // ingresso del registratore (Apps Script)
  var LEGACY_RATE = 22050; // WAV della versione precedente (audio rimasto sui telefoni)
  var KEYS = { token: 'registratore.token', name: 'registratore.nome', device: 'registratore.telefono', wake: 'registratore.schermo' };
  // Byte di audio per richiesta: quanti la rete porta in circa 15 s alla velocità misurata (mai più di 256 KB);
  // dopo un errore di rete la prima richiesta è piccola (8 KB), poi crescono solo se la rete regge. 15 s perché
  // ogni richiesta al cloud vero costa circa 3 s fissi (misurati il 9 ottobre 2026): con richieste più brevi, su
  // una rete lenta, si invierebbe meno audio di quanto se ne registra.
  var UP = { min: 8 * 1024, max: 256 * 1024, targetMs: 15000, startRate: 8 * 1024 };
  var SEND_EVERY_MS = 10000; // invio circa ogni 10 s di audio
  var BEAT_MS = 30000; // segnale di vita se l'audio non riesce a partire da 30 s
  var KEEP = { copies: 6, days: 7 }; // copie sul telefono delle registrazioni già nel cloud
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isAndroid = /Android/i.test(navigator.userAgent);
  var $ = function (id) { return document.getElementById(id); };

  // ─── Memoria del telefono ─────────────────────────────────────────────────

  var ls = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* modalità privata */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* modalità privata */ } },
  };

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return (b + 256).toString(16).slice(1); }).join('');
  }

  var deviceId = ls.get(KEYS.device);
  if (!deviceId) { deviceId = uid(); ls.set(KEYS.device, deviceId); }

  /**
   * Audio e segmenti su IndexedDB (in memoria se il browser non lo consente).
   * Audio compresso: un record per pagina Ogg o blocco del registratore, chiave "<segmento>:o<posizione>".
   * WAV della versione precedente: un record per pezzo numerato, chiave "<segmento>:<numero>".
   */
  var Store = (function () {
    var mem = { pieces: new Map(), meta: new Map() };
    var opening = null;
    var failed = false;
    function open() {
      if (opening) return opening;
      opening = new Promise(function (resolve) {
        try {
          var req = indexedDB.open('registratore', 1);
          req.onupgradeneeded = function () {
            req.result.createObjectStore('pieces', { keyPath: 'k' });
            req.result.createObjectStore('meta');
          };
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { resolve(null); };
          req.onblocked = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
      return opening;
    }
    function run(store, mode, action) {
      return open().then(function (db) {
        if (!db) return action(null);
        return new Promise(function (resolve, reject) {
          var t = db.transaction(store, mode);
          var r = action(t.objectStore(store));
          var result;
          if (r) r.onsuccess = function () { result = r.result; };
          t.oncomplete = function () { resolve(result); };
          t.onerror = function () { reject(t.error); };
          t.onabort = function () { reject(t.error || new Error('transazione annullata')); };
        });
      });
    }
    function memFallback(err) {
      if (!failed) { failed = true; report('errore', 'memoria del telefono', 'IndexedDB non disponibile: ' + ((err && (err.name || err.message)) || 'motivo sconosciuto')); }
    }
    function key(local, seq) { return local + ':' + ('00000' + seq).slice(-6); }
    function chunkKey(local, off) { return local + ':o' + ('000000000000' + off).slice(-12); }
    function memChunks(local) {
      return Array.from(mem.pieces.values()).filter(function (p) { return p.local === local && p.off !== undefined; });
    }
    return {
      // ── WAV della versione precedente ──
      put: function (local, seq, data) {
        var rec = { k: key(local, seq), local: local, seq: seq, data: data };
        return run('pieces', 'readwrite', function (s) { if (!s) { mem.pieces.set(rec.k, rec); return null; } return s.put(rec); })
          .catch(function (err) { memFallback(err); mem.pieces.set(rec.k, rec); });
      },
      get: function (local, seq) {
        var k = key(local, seq);
        if (mem.pieces.has(k)) return Promise.resolve(mem.pieces.get(k));
        return run('pieces', 'readonly', function (s) { return s ? s.get(k) : null; }).catch(function () { return null; });
      },
      del: function (local, seq) {
        var k = key(local, seq);
        mem.pieces.delete(k);
        return run('pieces', 'readwrite', function (s) { return s ? s.delete(k) : null; }).catch(function () {});
      },
      list: function (local) {
        var from = local + ':0';
        var inMem = Array.from(mem.pieces.values()).filter(function (p) { return p.local === local && p.off === undefined; });
        return run('pieces', 'readonly', function (s) { return s ? s.getAll(IDBKeyRange.bound(from, local + ':9\uffff')) : null; })
          .then(function (rows) { return (rows || []).concat(inMem).sort(function (a, b) { return a.seq - b.seq; }); })
          .catch(function () { return inMem; });
      },
      // ── Audio compresso ──
      putChunk: function (local, off, data, info) {
        var rec = { k: chunkKey(local, off), local: local, off: off, len: data.byteLength, data: data, sec: info.sec, gran: info.gran, pseq: info.pseq, flags: info.flags };
        return run('pieces', 'readwrite', function (s) { if (!s) { mem.pieces.set(rec.k, rec); return null; } return s.put(rec); })
          .catch(function (err) { memFallback(err); mem.pieces.set(rec.k, rec); });
      },
      /** Blocchi contigui dalla posizione `from` (al massimo maxBytes, almeno uno; tutti se maxBytes manca). */
      chunks: function (local, from, maxBytes) {
        var lo = chunkKey(local, from);
        var hi = local + ':o\uffff';
        return run('pieces', 'readonly', function (s) {
          if (!s) return null;
          var range = IDBKeyRange.bound(lo, hi);
          return maxBytes ? s.getAll(range, Math.max(8, Math.ceil(maxBytes / 1024))) : s.getAll(range);
        }).catch(function () { return []; }).then(function (rows) {
          var all = (rows || []).concat(memChunks(local).filter(function (p) { return p.off >= from; }))
            .sort(function (a, b) { return a.off - b.off; });
          var out = [];
          var pos = from;
          var total = 0;
          for (var i = 0; i < all.length; i += 1) {
            var c = all[i];
            if (c.off !== pos) { if (c.off < pos) continue; break; }
            if (maxBytes && total && total + c.len > maxBytes) break;
            out.push(c);
            pos += c.len;
            total += c.len;
          }
          return out;
        });
      },
      /** Primo blocco che inizia dopo `pos` (per un buco nella memoria del telefono). */
      nextChunk: function (local, pos) {
        return run('pieces', 'readonly', function (s) { return s ? s.get(IDBKeyRange.bound(chunkKey(local, pos + 1), local + ':o\uffff')) : null; })
          .catch(function () { return null; })
          .then(function (row) {
            var inMem = memChunks(local).filter(function (p) { return p.off > pos; }).sort(function (a, b) { return a.off - b.off; })[0];
            return row && (!inMem || row.off < inMem.off) ? row : inMem || null;
          });
      },
      lastChunk: function (local) {
        return open().then(function (db) {
          if (!db) return null;
          return new Promise(function (resolve) {
            var req = db.transaction('pieces', 'readonly').objectStore('pieces').openCursor(IDBKeyRange.bound(local + ':o', local + ':o\uffff'), 'prev');
            req.onsuccess = function () { resolve(req.result ? req.result.value : null); };
            req.onerror = function () { resolve(null); };
          });
        }).catch(function () { return null; }).then(function (row) {
          var inMem = memChunks(local).sort(function (a, b) { return b.off - a.off; })[0];
          return row && (!inMem || row.off > inMem.off) ? row : inMem || null;
        });
      },
      dropChunks: function (local) {
        memChunks(local).forEach(function (p) { mem.pieces.delete(p.k); });
        return run('pieces', 'readwrite', function (s) { return s ? s.delete(IDBKeyRange.bound(local + ':o', local + ':o\uffff')) : null; }).catch(function () {});
      },
      getMeta: function (k) {
        if (mem.meta.has(k)) return Promise.resolve(mem.meta.get(k));
        return run('meta', 'readonly', function (s) { return s ? s.get(k) : null; }).catch(function () { return null; });
      },
      setMeta: function (k, v) {
        mem.meta.set(k, v);
        return run('meta', 'readwrite', function (s) { return s ? s.put(v, k) : null; }).then(function () { mem.meta.delete(k); }).catch(function () {});
      },
    };
  })();

  // ─── Stato ────────────────────────────────────────────────────────────────

  var S = {
    token: ls.get(KEYS.token),
    name: ls.get(KEYS.name) || '',
    screen: 'loading',
    settings: { pieceSeconds: 10, sampleRate: LEGACY_RATE, lockMs: 120000 },
    serverOffset: 0,
    status: null,
    audio: null,
    engineChoice: null, // { kind: 'opus' | 'mr', format: 'ogg' | 'm4a' | 'webm', label, cfg | mr }
    engine: null, // { kind, seg, obj }: il codificatore del segmento che riceve l'audio
    engineErrors: 0,
    writing: Promise.resolve(), // scritture sul telefono, in ordine
    pausing: Promise.resolve(), // pausa del codificatore dopo un'interruzione: ripresa e chiusura la aspettano
    segments: [], // coda: il primo è quello che si sta inviando
    current: null, // segmento che riceve l'audio
    archive: [], // copie sul telefono delle registrazioni già nel cloud
    copySel: new Set(), // copie selezionate nella schermata "Registrazioni sul telefono"
    lastPcmAt: 0,
    recording: false,
    interrupted: null, // { at, why }
    // rate: byte di audio al secondo portati dalla rete (misurati, invio + risposta del cloud); probe: prossima richiesta piccola
    up: { running: false, again: false, failures: 0, waiting: null, rate: UP.startRate, probe: true, chunk: UP.min, lastSendAt: 0, timer: null },
    lastAckAt: 0,
    lastBeatAt: 0,
    wakeWanted: ls.get(KEYS.wake) !== '0',
    wakeLock: null,
    levels: [],
    cutting: false,
    stopping: null, // segmento in chiusura (arresto premuto)
    net: { requests: 0, totalMs: 0, maxMs: 0, maxBacklog: 0, failures: 0, beats: 0, mismatch: 0 },
    // Audio arrivato dal microfono rispetto al tempo in cui il microfono è stato aperto (diagnostica: un telefono
    // che perde audio prima della pagina si vede qui, nel registro del cloud a fine registrazione).
    mic: { seconds: 0, openMs: 0, openedAt: 0 },
  };

  var SEGMENT_FIELDS = ['local', 'mode', 'format', 'rec', 'next', 'sent', 'bytes', 'seconds', 'live', 'samples', 'serial', 'pseq', 'granule',
    'headBytes', 'finishedLocal', 'cont', 'stopping', 'reason', 'lesson', 'stopAt', 'then', 'startedAt', 'localStart', 'endedAt', 'lessonId', 'lessonHint', 'serverSeconds'];

  function pieceSamples() { return Math.round((S.settings.pieceSeconds || 10) * LEGACY_RATE); }
  function serverNow() { return Date.now() + S.serverOffset; }
  function isStream(seg) { return seg && seg.mode === 'stream'; }
  function saveSegments() {
    clearTimeout(S.saveTimer);
    S.saveTimer = null;
    var plain = S.segments.map(function (s) {
      var o = {};
      SEGMENT_FIELDS.forEach(function (k) { if (s[k] !== undefined) o[k] = s[k]; });
      return o;
    });
    return Store.setMeta('segments', plain);
  }
  function saveSegmentsSoon() {
    if (!S.saveTimer) S.saveTimer = setTimeout(saveSegments, 2000);
  }
  function saveArchive() { return Store.setMeta('archive', S.archive); }

  // ─── Formattazione ────────────────────────────────────────────────────────

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clock(seconds) {
    var s = Math.max(0, Math.floor(seconds));
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor((s % 3600) / 60)) + ':' + pad(s % 60);
  }
  function duration(seconds) {
    var s = Math.max(0, Math.round(seconds));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (h) return h + ' h ' + m + ' min';
    if (m) return m + ' min ' + (s % 60) + ' s';
    return (s % 60) + ' s';
  }
  function mb(bytes) {
    if (bytes < 1e6) return Math.max(1, Math.round(bytes / 1e3)) + ' KB';
    return (bytes / 1e6).toFixed(1).replace('.', ',') + ' MB';
  }
  function hhmm(ms) {
    return new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
  }
  function dayTime(ms) {
    return new Date(ms).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
  }

  // ─── Rete ─────────────────────────────────────────────────────────────────

  /** Richiesta non riuscita. google = risposta sbagliata o non valida del cloud (non un problema della rete del telefono). */
  function NetError(message, timeout, google) { this.message = message; this.network = true; this.timeout = Boolean(timeout); this.google = Boolean(google); }

  function api(body, timeoutMs) {
    var controller = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, timeoutMs || 45000);
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      cache: 'no-store',
      redirect: 'follow',
      signal: controller ? controller.signal : undefined,
    }).then(function (res) {
      return res.text().then(function (text) {
        var r;
        try { r = JSON.parse(text); } catch (e) { throw new NetError('risposta non valida (HTTP ' + res.status + ')', false, true); }
        // Solo la risposta a QUESTA richiesta: a volte Google serve una POST con la funzione delle GET, che
        // risponde "ok" senza aver fatto nulla (misurato nel cloud vero). In quel caso si ripete la richiesta.
        if (!r || typeof r !== 'object' || r.a !== body.a) {
          S.net.mismatch = (S.net.mismatch || 0) + 1;
          throw new NetError('risposta del cloud non pertinente alla richiesta', false, true);
        }
        return r;
      });
    }, function (err) {
      var aborted = err && err.name === 'AbortError';
      throw new NetError(aborted ? 'tempo scaduto' : 'rete non raggiungibile', aborted);
    }).finally(function () { clearTimeout(timer); });
  }

  /** Byte di audio per la prossima richiesta. */
  function chunkSize() {
    S.up.chunk = S.up.probe ? UP.min : Math.max(UP.min, Math.min(UP.max, Math.round((S.up.rate * UP.targetMs) / 1000)));
    return S.up.chunk;
  }

  /**
   * Tempo massimo di una richiesta con `bytes` byte di audio: 20 s più 3 volte il tempo previsto, da 60 s a 3 minuti.
   * Generoso di proposito: l'audio è al sicuro sul telefono, aspettare non costa nulla, mentre interrompere una
   * richiesta che stava per riuscire blocca tutto. Misurato il 9 ottobre 2026 in produzione: risposte di solito in
   * 1-2 s, ma con picchi di 15 e 29 s.
   */
  function timeoutFor(bytes) {
    var expected = (bytes / Math.max(S.up.rate, 1024)) * 1000;
    return Math.max(60000, Math.min(180000, Math.round(20000 + 3 * expected)));
  }

  /** "Android 10 · Chrome 154 · audio 48 kHz running · Opus 24 kHz 24 kbit/s": per capire a distanza su che telefono succede cosa. */
  function deviceInfo() {
    var ua = navigator.userAgent;
    var m;
    var os = 'altro';
    if (isIOS) os = 'iOS ' + ((m = /OS (\d+)[_.](\d+)/.exec(ua)) ? m[1] + '.' + m[2] : '?');
    else if ((m = /Android (\d+(?:\.\d+)?)/.exec(ua))) os = 'Android ' + m[1];
    else if (/Windows/.test(ua)) os = 'Windows';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    var browser = 'browser sconosciuto';
    if (/FBAN|FBAV/.test(ua)) browser = 'app Facebook';
    else if (/Instagram/.test(ua)) browser = 'app Instagram';
    else if (/WhatsApp/i.test(ua)) browser = 'app WhatsApp';
    else if ((m = /SamsungBrowser\/(\d+)/.exec(ua))) browser = 'Samsung Internet ' + m[1];
    else if ((m = /EdgA?\/(\d+)/.exec(ua)) || (m = /EdgiOS\/(\d+)/.exec(ua))) browser = 'Edge ' + m[1];
    else if ((m = /CriOS\/(\d+)/.exec(ua))) browser = 'Chrome (iOS) ' + m[1];
    else if ((m = /FxiOS\/(\d+)/.exec(ua)) || (m = /Firefox\/(\d+)/.exec(ua))) browser = 'Firefox ' + m[1];
    else if ((m = /Chrome\/(\d+)/.exec(ua))) browser = 'Chrome ' + m[1];
    else if ((m = /Version\/(\d+(?:\.\d+)?).*Safari/.exec(ua))) browser = 'Safari ' + m[1];
    var standalone = window.navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    var audio = S.audio ? ' · audio ' + Math.round(S.audio.ctx.sampleRate / 100) / 10 + ' kHz ' + S.audio.ctx.state : '';
    var engine = S.engineChoice ? ' · ' + S.engineChoice.label : '';
    return os + ' · ' + browser + (standalone ? ' · dalla schermata Home' : '') + audio + engine + ('wakeLock' in navigator ? '' : ' · schermo acceso non disponibile');
  }

  /** Segnalazione al registro del cloud (al massimo 20 per pagina aperta, senza mai disturbare la registrazione). */
  var reportsLeft = 20;
  function report(kind, where, message) {
    if (reportsLeft <= 0) return;
    reportsLeft -= 1;
    try {
      api({ a: 'report', token: S.token, kind: kind, where: where, message: String(message || '').slice(0, 300), device: deviceInfo() }, 60000).catch(function () {});
    } catch (e) { /* mai bloccare la pagina per una segnalazione */ }
  }

  window.addEventListener('error', function (e) {
    report('errore', 'pagina', (e.message || 'errore') + (e.filename ? ' (' + e.filename.split('/').pop() + ':' + e.lineno + ')' : ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason;
    if (reason && reason.network) return; // rete assente: già gestita dalla coda di invio
    report('errore', 'pagina', 'operazione non riuscita: ' + (reason && (reason.message || reason)));
  });

  function toBase64(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var parts = [];
    for (var i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
    return btoa(parts.join(''));
  }

  function concat(list) {
    var total = 0;
    list.forEach(function (c) { total += c.len; });
    var out = new Uint8Array(total);
    var off = 0;
    list.forEach(function (c) { out.set(new Uint8Array(c.data), off); off += c.len; });
    return out;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ─── Schermate ────────────────────────────────────────────────────────────

  var SCREENS = ['loading', 'login', 'ready', 'recording', 'busy', 'interrupted', 'done', 'message', 'copies'];
  var WITH_HEADER = { ready: 1, recording: 1, busy: 1, interrupted: 1 };

  function show(name) {
    S.screen = name;
    document.body.dataset.screen = name;
    SCREENS.forEach(function (s) { $('screen-' + s).hidden = s !== name; });
    $('top').hidden = !WITH_HEADER[name];
    applyWake();
  }

  function pill(kind, text) {
    $('pill').className = 'pill pill--' + kind;
    $('pill-text').textContent = text;
  }

  function top(title, sub) {
    $('top-title').textContent = title;
    $('top-sub').textContent = sub;
  }

  function banner(text) {
    $('banner').hidden = !text;
    $('banner-text').textContent = text || '';
  }

  function message(title, text, action, onAction) {
    $('msg-title').textContent = title;
    $('msg-text').textContent = text;
    $('msg-action').textContent = action || 'Riprova';
    $('msg-action').onclick = onAction || function () { location.reload(); };
    show('message');
  }

  function lessonLine(lesson) {
    return hhmm(lesson.start) + ' – ' + hhmm(lesson.end);
  }

  function renderReady(st) {
    top('Registratore', 'Lezioni UniPA');
    pill('free', 'Libero');
    var lesson = st.lesson;
    var now = serverNow();
    if (lesson) {
      $('lesson-label').textContent = lesson.start > now ? 'Tra poco in calendario' : 'Ora in calendario';
      $('lesson-title').textContent = lesson.title;
      var mins = Math.round((now - lesson.start) / 60000);
      $('lesson-time').textContent = lessonLine(lesson) + (mins > 0 ? ' · iniziata da ' + mins + ' min' : mins < 0 ? ' · inizia tra ' + -mins + ' min' : '');
      $('lesson-folder-chip').className = lesson.folder ? 'chip' : 'chip chip--warn';
      $('lesson-folder').textContent = lesson.folder ? 'Andrà nella cartella ' + lesson.folder : 'Nessuna cartella: il file resterà su Dropbox';
    } else {
      $('lesson-label').textContent = 'Calendario';
      $('lesson-title').textContent = 'Nessuna lezione adesso';
      $('lesson-time').textContent = st.upcoming ? 'Prossima: ' + st.upcoming.title + ' alle ' + hhmm(st.upcoming.start) : 'Nessun\'altra lezione nelle prossime ore';
      $('lesson-folder-chip').className = 'chip chip--warn';
      $('lesson-folder').textContent = 'Si abbina appena la lezione è nel calendario';
    }
    $('me-name').textContent = S.name;
    // Audio di una registrazione precedente ancora sul telefono: prima va inviato.
    var leftover = S.segments.length > 0;
    $('start-label').textContent = leftover ? 'Invio dell\'audio rimasto…' : 'Tocca per registrare';
    $('start-btn').disabled = leftover;
    $('start-hint').textContent = leftover
      ? 'Sul telefono c\'è ancora ' + duration(pendingSeconds()) + ' di audio di una registrazione precedente: lascia la pagina aperta finché parte.'
      : 'Registra un solo telefono alla volta: gli altri vedranno che la lezione è già coperta.';
    show('ready');
    updateMicRow();
    renderCopies();
  }

  function renderBusy(st) {
    var a = st.active;
    top('Registratore', 'Lezioni UniPA');
    pill('warn', 'Occupato');
    $('busy-initial').textContent = (a.name || '?').charAt(0).toUpperCase();
    $('busy-title').textContent = a.name + ' sta registrando';
    $('busy-lesson').textContent = (a.lesson ? a.lesson.title + ' · ' : '') + 'dalle ' + hhmm(a.startedAt);
    S.busyBase = { startedAt: a.startedAt };
    $('busy-timer').textContent = clock((serverNow() - a.startedAt) / 1000);
    if (a.free) {
      $('busy-hint').textContent = 'Il telefono di ' + a.name + ' non dà segnali da ' + duration(a.silentMs / 1000);
      $('busy-text').textContent = 'Puoi registrare tu: la registrazione di ' + a.name + ' viene salvata così com\'è.';
      $('takeover-btn').hidden = false;
    } else if (a.paused) {
      $('busy-hint').textContent = a.name + ' ha messo in pausa la registrazione';
      $('busy-text').textContent = 'È la pausa della lezione: il registratore resta di ' + a.name + ' finché riprende (fino a 45 minuti). La registrazione arriverà su Drive dopo la fine.';
      $('takeover-btn').hidden = true;
    } else {
      $('busy-hint').textContent = 'Il pulsante si sblocca quando ' + a.name + ' termina';
      $('busy-text').textContent = 'La registrazione di ' + a.name + ' arriverà su Drive dopo la fine. Se il suo telefono si spegne, il registratore si libera da solo entro 2 minuti.';
      $('takeover-btn').hidden = true;
    }
    show('busy');
  }

  function renderRecordingInfo() {
    var seg = S.current || S.segments[S.segments.length - 1];
    var lesson = seg && seg.lesson;
    var pending = seg && !seg.rec;
    if (lesson) top(lesson.title, lessonLine(lesson) + (lesson.folder ? ' · cartella ' + lesson.folder : ''));
    else if (pending) top('Registrazione', 'Collegamento al cloud…');
    else top('Registrazione', 'Nessuna lezione in calendario adesso');
    pill('rec', 'REC');
    var since = seg && (seg.startedAt || seg.localStart);
    $('rec-since').textContent = since ? 'Iniziata alle ' + hhmm(since) + ' da ' + S.name : '';
  }

  // ─── Indicatore del livello ──────────────────────────────────────────────

  var BARS = 46;
  function buildMeter() {
    var meter = $('meter');
    for (var i = 0; i < BARS; i += 1) {
      var bar = document.createElement('span');
      var t = i / (BARS - 1);
      bar.style.background = 'rgb(' + Math.round(244 + (167 - 244) * t) + ',' + Math.round(63 + (139 - 63) * t) + ',' + Math.round(94 + (250 - 94) * t) + ')';
      meter.appendChild(bar);
      S.levels.push(0);
    }
  }
  function pushLevel(rms) {
    S.levels.push(rms);
    S.levels.shift();
    if (S.screen !== 'recording' || document.hidden) return;
    var bars = $('meter').children;
    for (var i = 0; i < BARS; i += 1) {
      var v = Math.min(1, Math.pow(S.levels[i] * 5, 0.6));
      bars[i].style.height = Math.round(4 + v * 76) + 'px';
    }
  }

  // ─── Audio ────────────────────────────────────────────────────────────────

  function audioError(code) { var e = new Error(code); e.code = code; return e; }

  /** Codificatore da usare su questo telefono (scelto una volta): Opus via WebCodecs, altrimenti il registratore del browser. */
  function chooseEngine() {
    if (S.engineChoice) return Promise.resolve(S.engineChoice);
    if (!window.MotoreAudio) return Promise.resolve(null);
    return MotoreAudio.chooseOpus().catch(function () { return null; }).then(function (cfg) {
      if (cfg) return { kind: 'opus', format: 'ogg', cfg: cfg, rate: cfg.sampleRate, label: 'Opus ' + cfg.sampleRate / 1000 + ' kHz ' + cfg.bitrate / 1000 + ' kbit/s' };
      var mr = MotoreAudio.chooseRecorder();
      if (mr) return { kind: 'mr', format: mr.format, mr: mr, rate: 24000, label: 'registratore del browser ' + mr.mimeType };
      return null;
    }).then(function (choice) {
      S.engineChoice = choice;
      return choice;
    });
  }

  function openAudio(rate) {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.AudioWorkletNode) {
      return Promise.reject(audioError('unsupported'));
    }
    var stream;
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    }).then(function (s) {
      stream = s;
      // Dopo il permesso del microfono: così il browser usa la frequenza reale del microfono.
      // L'avvio del contesto audio non può mai bloccare la pagina: al massimo 1,5 s di attesa.
      var ctx = new Ctx({ latencyHint: 'playback' });
      return Promise.race([ctx.resume().catch(function () {}), sleep(1500)])
        .then(function () { return withTimeout(ctx.audioWorklet.addModule('worklet.js?v=20261010q'), 15000, 'caricamento del modulo audio'); })
        .then(function () { return ctx; });
    }).then(function (ctx) {
      var source = ctx.createMediaStreamSource(stream);
      var node = new AudioWorkletNode(ctx, 'registratore', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { float: true, targetRate: rate },
      });
      var mute = ctx.createGain();
      mute.gain.value = 0; // il worklet va collegato all'uscita perché venga eseguito, ma senza suono
      source.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
      node.port.onmessage = onWorklet;
      var track = stream.getAudioTracks()[0];
      track.onended = function () { if (S.recording && !S.audioPaused) interrupt('microfono chiuso dal telefono'); };
      S.audio = { ctx: ctx, stream: stream, source: source, node: node, mute: mute, track: track, rate: rate, flushWaiters: [] };
      S.lastPcmAt = performance.now();
      S.mic.openedAt = performance.now();
      if (ctx.state === 'running') return null;
      return Promise.race([ctx.resume().catch(function () {}), sleep(1500)]).then(function () {
        if (ctx.state === 'running') return;
        // Alcuni telefoni avviano l'audio solo dopo un altro tocco: il primo tocco sullo schermo lo riattiva.
        document.addEventListener('pointerdown', function () { ctx.resume().catch(function () {}); }, { once: true });
        toast('Tocca lo schermo per avviare il microfono.');
        report('evento', 'audio sospeso', 'contesto audio "' + ctx.state + '" dopo l\'avvio');
      });
    }).catch(function (err) {
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      throw err.code ? err : audioError(err && err.name === 'NotAllowedError' ? 'denied' : err && err.name === 'NotFoundError' ? 'nomic' : 'failed');
    });
  }

  function closeAudio() {
    var a = S.audio;
    S.audio = null;
    if (!a) return;
    if (S.mic.openedAt) { S.mic.openMs += performance.now() - S.mic.openedAt; S.mic.openedAt = 0; }
    try { a.node.port.onmessage = null; a.node.disconnect(); } catch (e) { /* già chiuso */ }
    try { a.source.disconnect(); } catch (e) { /* già chiuso */ }
    a.stream.getTracks().forEach(function (t) { t.onended = null; t.stop(); });
    try { a.ctx.close(); } catch (e) { /* già chiuso */ }
  }

  /** Chiede al worklet i campioni ancora in memoria (meno di mezzo secondo) e li passa al codificatore. */
  function flushAudio() {
    var a = S.audio;
    if (!a) return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () { if (!done) { done = true; resolve(); } };
      a.flushWaiters.push(finish);
      try { a.node.port.postMessage('flush'); } catch (e) { finish(); }
      setTimeout(finish, 800);
    });
  }

  function onWorklet(event) {
    var msg = event.data;
    if (msg.type === 'level') { pushLevel(msg.rms); return; }
    if (msg.type !== 'f32') return;
    S.lastPcmAt = performance.now();
    var samples = new Float32Array(msg.pcm);
    if (S.audio) S.mic.seconds += samples.length / S.audio.rate;
    var e = S.engine;
    if (samples.length && S.recording && !S.audioPaused && e) {
      e.seg.live = (e.seg.live || 0) + samples.length / (S.audio ? S.audio.rate : 24000);
      if (e.kind === 'opus') {
        try { e.obj.encode(samples); } catch (err) { engineError(err); }
      }
    }
    if (msg.flushed && S.audio) {
      var waiters = S.audio.flushWaiters.splice(0);
      waiters.forEach(function (w) { w(); });
    }
  }

  // ─── Codificatore e memoria del telefono ──────────────────────────────────

  function newStreamSegment(format) {
    return {
      local: uid(), mode: 'stream', format: format, rec: null, bytes: 0, stored: 0, sent: 0, seconds: 0, live: 0,
      headBytes: 0, finishedLocal: false, stopping: false, reason: null, lesson: null, stopAt: null, then: null, startedAt: null,
    };
  }

  /** Il codificatore del segmento `seg` (che riceve l'audio da adesso). */
  function startEngine(seg) {
    var c = S.engineChoice;
    if (c.kind === 'opus') {
      var options = { onPage: function (p) { onPage(seg, p); }, onError: function (err) { engineError(err); } };
      // Stesso file dopo un'interruzione o una pagina ricaricata: il flusso Ogg continua (intestazione già scritta).
      if (seg.serial !== undefined && seg.headBytes > 0 && !seg.finishedLocal) {
        options.resume = { serial: seg.serial, seq: seg.pseq + 1, granule: seg.granule || 0 };
      }
      S.engine = { kind: 'opus', seg: seg, obj: new MotoreAudio.MotoreOpus(c.cfg, options) };
    } else {
      S.engine = { kind: 'mr', seg: seg, obj: new MotoreAudio.MotoreMediaRecorder(S.audio.stream, c.mr, { onChunk: function (bytes) { onBlob(seg, bytes); } }) };
    }
  }

  /**
   * Avvia il codificatore del segmento senza mai lasciare la registrazione senza codifica: se Opus non parte
   * (raro: il browser lo dichiara disponibile ma lo rifiuta) e il segmento è ancora vuoto, passa al registratore
   * del browser. → true se il codificatore è partito.
   */
  function startEngineSafe(seg) {
    for (var attempt = 0; attempt < 2; attempt += 1) {
      try {
        startEngine(seg);
        return true;
      } catch (err) {
        report('errore', 'avvio del codificatore', ((err && (err.name || '') + ' ' + (err.message || '')) || 'errore') + ' · ' + S.engineChoice.label);
        var mr = window.MotoreAudio && MotoreAudio.chooseRecorder();
        if (attempt > 0 || S.engineChoice.kind !== 'opus' || !mr || seg.bytes > 0) return false;
        S.engineChoice = { kind: 'mr', format: mr.format, mr: mr, rate: S.engineChoice.rate, label: 'registratore del browser ' + mr.mimeType };
        seg.format = mr.format;
      }
    }
    return false;
  }

  /** Quando la pausa del codificatore (interruzione) e le scritture sul telefono sono finite. */
  function settled() {
    return S.pausing.then(function () { return S.writing; });
  }

  /** Chiude il codificatore: 'finish' = fine del file; 'pause' = il file resta aperto (solo Opus). */
  function endEngine(e, how) {
    if (!e) return Promise.resolve();
    var p;
    if (e.kind === 'opus') p = how === 'pause' ? e.obj.pause() : e.obj.finish();
    else p = e.obj.stop().then(function () { e.seg.finishedLocal = true; });
    return withTimeout(p, 5000, 'chiusura del codificatore').catch(function (err) {
      report('errore', 'chiusura del codificatore', err && err.message);
    }).then(function () { return S.writing; });
  }

  function engineError(err) {
    S.engineErrors += 1;
    report('errore', 'codificatore audio', (err && (err.name || '') + ' ' + (err.message || '')) + ' (errore n. ' + S.engineErrors + ')');
    if (!S.current || S.rotating) return;
    // Il codificatore si è fermato: l'audio già codificato è salvato; si continua con un codificatore nuovo
    // in un nuovo file (dopo 3 errori con il registratore del browser, se disponibile).
    if (S.engineErrors >= 3 && S.engineChoice.kind === 'opus' && window.MotoreAudio && MotoreAudio.chooseRecorder()) {
      var mr = MotoreAudio.chooseRecorder();
      S.engineChoice = { kind: 'mr', format: mr.format, mr: mr, rate: S.engineChoice.rate, label: 'registratore del browser ' + mr.mimeType };
    }
    rotate(S.current, 'manual', true);
  }

  function writeChunk(seg, off, data, info) {
    S.writing = S.writing.then(function () { return Store.putChunk(seg.local, off, data, info); }).then(function () {
      seg.stored = Math.max(seg.stored || 0, off + data.byteLength);
      saveSegmentsSoon();
      kick();
    });
    return S.writing;
  }

  function onPage(seg, p) {
    var off = seg.bytes;
    var data = p.bytes.buffer.byteLength === p.bytes.length ? p.bytes.buffer : p.bytes.slice().buffer;
    seg.bytes += p.bytes.length;
    seg.serial = p.serial;
    seg.pseq = p.seq;
    var flags = p.bytes[5];
    if (p.header) seg.headBytes = seg.bytes;
    else {
      seg.granule = p.granule;
      seg.seconds = p.granule / 48000;
    }
    if (flags & 4) seg.finishedLocal = true;
    writeChunk(seg, off, data, { sec: seg.seconds, gran: p.header ? 0 : p.granule, pseq: p.seq, flags: flags });
  }

  function onBlob(seg, bytes) {
    var off = seg.bytes;
    seg.bytes += bytes.length;
    seg.seconds = seg.live || 0;
    if (!off) seg.headBytes = bytes.length;
    writeChunk(seg, off, bytes.buffer.byteLength === bytes.length ? bytes.buffer : bytes.slice().buffer, { sec: seg.seconds, gran: -1, pseq: -1, flags: 0 });
  }

  /**
   * Chiude sul telefono un file Ogg rimasto aperto (pagina ricaricata, "Termina qui", codificatore fermo):
   * una pagina di fine flusso. Per gli altri formati il file è già completo.
   */
  function sealSegment(seg) {
    if (!isStream(seg) || seg.finishedLocal) return S.writing;
    seg.finishedLocal = true;
    if (seg.format !== 'ogg' || seg.serial === undefined || seg.bytes <= seg.headBytes) return S.writing;
    var page = MotoreAudio.eosPage(seg.serial, seg.pseq + 1, seg.granule || 0);
    var off = seg.bytes;
    seg.bytes += page.length;
    seg.pseq += 1;
    seg.granule = (seg.granule || 0) + 960;
    seg.seconds = seg.granule / 48000;
    return writeChunk(seg, off, page.buffer, { sec: seg.seconds, gran: seg.granule, pseq: seg.pseq, flags: 4 });
  }

  /** Il segmento ha solo l'intestazione (nessun audio). */
  function emptySegment(seg) {
    return isStream(seg) ? seg.bytes <= seg.headBytes : seg.next === 0 && !seg.samples;
  }

  // ─── Registrazione ────────────────────────────────────────────────────────

  function applyRec(seg, rec) {
    seg.rec = rec.id;
    seg.lesson = rec.lesson || null;
    if (rec.lesson && rec.lesson.id) seg.lessonId = rec.lesson.id;
    seg.stopAt = rec.stopAt || null;
    seg.then = rec.then || null;
    seg.startedAt = rec.startedAt;
    if (isStream(seg)) {
      if (typeof rec.offset === 'number') seg.sent = Math.min(rec.offset, seg.bytes);
    } else if (rec.next > seg.sent) {
      seg.sent = rec.next;
      seg.next = Math.max(seg.next, rec.next);
    }
  }

  /** Pulsante del microfono durante l'avvio: animazione evidente e testo che dice cosa sta succedendo. */
  function startButtonBusy(on, label) {
    $('start-btn').disabled = on;
    $('start-btn').classList.toggle('mic--starting', on);
    $('start-btn').parentElement.classList.toggle('starting', on);
    $('start-btn').setAttribute('aria-busy', String(on));
    $('start-label').textContent = on ? (label || 'Attivazione del microfono…') : 'Tocca per registrare';
  }

  /**
   * Avvio: appena il microfono è acceso la registrazione parte SUBITO sul telefono (schermata con il
   * cronometro); il cloud viene avvisato in parallelo dalla coda di invio, che riprova da sola se la rete
   * è lenta. Se nel frattempo un altro telefono ha preso il registratore, la pagina lo dice.
   */
  function onStart() {
    if (S.starting) return;
    S.starting = true;
    S.mic = { seconds: 0, openMs: 0, openedAt: 0 };
    startButtonBusy(true, 'Attivazione del microfono…');
    var hint = setTimeout(function () {
      if (S.starting) startButtonBusy(true, 'Consenti l\'uso del microfono nella richiesta del telefono');
    }, 2500);
    chooseEngine().then(function (choice) {
      if (!choice) throw audioError('unsupported');
      return openAudio(choice.rate);
    }).then(function () {
      var seg = newStreamSegment(S.engineChoice.format);
      seg.localStart = Date.now();
      S.engineErrors = 0;
      if (!startEngineSafe(seg)) throw audioError('failed'); // nessun codificatore: niente registrazione a metà
      S.segments.push(seg);
      S.current = seg;
      S.recording = true;
      S.audioPaused = false;
      saveSegments();
      keepStorage();
      startButtonBusy(false);
      startRecordingScreen();
      kick();
    }).catch(function (err) {
      // Microfono negato o assente, browser non adatto, codificatore che non parte: niente registrazione a metà.
      S.engine = null;
      stopCapture();
      startButtonBusy(false);
      report('errore', 'avvio del microfono', (err && (err.code || err.name)) + (err && err.message && err.message !== err.code ? ': ' + err.message : ''));
      micError(err);
    }).finally(function () {
      clearTimeout(hint);
      S.starting = false;
    });
  }

  /** Chiede al browser di non cancellare mai da solo la memoria di questa pagina (copie delle registrazioni). */
  function keepStorage() {
    try {
      if (navigator.storage && navigator.storage.persist && !S.persistAsked) {
        S.persistAsked = true;
        navigator.storage.persist().catch(function () {});
      }
    } catch (e) { /* non disponibile */ }
  }

  function withTimeout(promise, ms, what) {
    return Promise.race([promise, sleep(ms).then(function () { throw new Error('tempo scaduto: ' + what); })]);
  }

  function stopCapture() {
    S.recording = false;
    closeAudio();
  }

  function startRecordingScreen() {
    S.interrupted = null;
    renderRecordingInfo();
    $('ios-warning').hidden = !isIOS;
    $('android-note').hidden = !isAndroid;
    $('stop-btn').disabled = false;
    $('stop-text').textContent = 'Tieni premuto per terminare';
    $('stop-panel').hidden = true;
    $('pause-btn').disabled = false;
    $('pause-btn').hidden = false;
    $('pause-help').hidden = false;
    show('recording');
    updateSaved();
  }

  /**
   * Arresto: gli ultimi campioni passano al codificatore, il file si chiude sul telefono (copia completa,
   * scaricabile), poi gli ultimi secondi partono insieme alla richiesta di chiusura del file nel cloud.
   */
  function stopRecording(reason) {
    var seg = S.current;
    if (!seg || S.stopping) return Promise.resolve();
    $('stop-btn').disabled = true;
    $('pause-btn').hidden = true; // dopo "termina" non c'è più niente da mettere in pausa
    $('pause-help').hidden = true;
    $('stop-text').textContent = 'Salvataggio…';
    S.stopping = seg;
    S.stopPressedAt = Date.now();
    $('stop-help').hidden = true;
    return flushAudio().then(function () {
      var e = S.engine;
      S.engine = null;
      stopCapture();
      return endEngine(e, 'finish');
    }).then(function () { return sealSegment(seg); }).then(function () {
      S.current = null;
      seg.stopping = true;
      seg.reason = reason;
      seg.endedAt = Date.now();
      seg.onStopped = showDone;
      saveSegments();
      kick();
    });
  }

  /**
   * Il segmento `old` (che riceve l'audio) si chiude e l'audio continua in un nuovo file: fine della
   * lezione con un'altra subito dopo, codificatore fermato da un errore, cloud che ha chiuso la registrazione.
   */
  function rotate(old, reason, broken) {
    if (S.rotating || old !== S.current) return S.rotating || Promise.resolve();
    var oldEngine = S.engine && S.engine.seg === old ? S.engine : null;
    var seg = newStreamSegment(S.engineChoice.format);
    seg.localStart = Date.now();
    S.segments.push(seg);
    S.current = seg;
    S.engine = null;
    if (S.audio && !S.audioPaused && !startEngineSafe(seg)) {
      // Nessun codificatore disponibile: l'audio registrato finora è salvo; chi registra viene avvisato.
      showError('Il codificatore audio del telefono si è fermato: tocca «termina» e avvia una nuova registrazione.');
    }
    if (broken && oldEngine && oldEngine.obj.encoder) { try { oldEngine.obj.encoder.close(); } catch (e) { /* già chiuso */ } }
    // Prima la pausa in corso (interruzione) e la chiusura del vecchio codificatore, poi la fine del vecchio file.
    S.rotating = S.pausing.then(function () { return broken ? S.writing : endEngine(oldEngine, 'finish'); }).then(function () { return sealSegment(old); }).then(function () {
      old.stopping = true;
      old.reason = reason;
      old.endedAt = Date.now();
      saveSegments();
      kick();
    }).finally(function () { S.rotating = null; });
    return S.rotating;
  }

  /** Fine lezione: 'next' = passa a un nuovo file per la lezione successiva; 'end' = arresto. */
  function cut(kind) {
    if (S.cutting || !S.current || S.current.stopping || S.stopping) return;
    if (kind === 'end') { stopRecording('auto'); return; }
    S.cutting = true;
    var old = S.current;
    var then = old.then;
    if (isStream(old)) {
      rotate(old, 'next').finally(function () { S.cutting = false; });
    } else {
      S.cutting = false;
      return;
    }
    toast(then ? 'Comincia ' + then.title + ': la registrazione continua in un nuovo file.' : 'La registrazione continua in un nuovo file.');
  }

  // ─── Coda di invio ────────────────────────────────────────────────────────

  function kick() {
    if (S.up.waiting) { S.up.waiting(); return; } // in attesa dopo un errore: si riprova subito
    if (S.up.running) { S.up.again = true; return; }
    S.up.running = true;
    runQueue().catch(function (err) {
      if (!(err && err.network)) report('errore', 'coda di invio', err && (err.message || err));
    }).then(function () {
      S.up.running = false;
      if (S.up.again) { S.up.again = false; kick(); }
    });
  }

  function runQueue() {
    S.up.again = false;
    var seg = S.segments[0];
    if (!seg) {
      updateSaved();
      if (S.screen === 'ready' && S.status) renderReady(S.status); // pulsante di nuovo disponibile
      return Promise.resolve();
    }
    var step;
    if (isStream(seg) && seg.stopping && !seg.rec && emptySegment(seg)) step = dropSegment(seg);
    else if (!seg.rec) step = openSegment(seg);
    else if (isStream(seg)) step = sendStream(seg);
    else {
      step = Store.get(seg.local, seg.sent).then(function (piece) {
        if (piece) return sendPiece(seg, piece);
        if (seg.stopping && seg.sent >= seg.next) return finishLegacy(seg);
        return 'idle';
      });
    }
    return step.then(function (result) {
      if (result !== 'idle') S.up.failures = 0;
      updateSaved();
      if (result === 'idle' || result === 'blocked') return null;
      return runQueue();
    }, function (err) {
      // Rete assente o cloud occupato: si riprova con attese crescenti (al massimo 10 s, 3 s in chiusura),
      // l'audio resta sul telefono. La richiesta successiva è piccola (prova della rete); dopo un tempo scaduto
      // anche la velocità stimata scende a un quarto. L'attesa finisce subito se torna la rete o se si termina.
      S.up.failures += 1;
      S.net.failures += 1;
      if (!(err && err.google)) S.up.probe = true; // risposta sbagliata del cloud: la rete del telefono va bene
      if (err && err.timeout) S.up.rate = Math.max(1024, S.up.rate / 4);
      updateSaved();
      var wait = Math.min(10000, 1000 * Math.pow(2, Math.min(S.up.failures - 1, 4)));
      if (S.stopping) wait = Math.min(wait, 3000);
      return new Promise(function (resolve) {
        var timer = setTimeout(resolve, wait);
        S.up.waiting = function () { clearTimeout(timer); resolve(); };
      }).then(function () { S.up.waiting = null; return runQueue(); });
    });
  }

  /** Segmento senza audio (avviato e fermato subito, o già coperto da un altro telefono): niente da inviare. */
  function removeSegment(seg) {
    var i = S.segments.indexOf(seg);
    if (i >= 0) S.segments.splice(i, 1);
  }

  function dropSegment(seg) {
    removeSegment(seg);
    saveSegments();
    Store.dropChunks(seg.local);
    if (seg.onStopped) seg.onStopped({ seconds: 0, bytes: 0, file: null }, seg);
    return Promise.resolve(null);
  }

  /** Invio dell'audio compresso: circa ogni 10 s (subito se c'è arretrato o in chiusura), richieste adattive. */
  function sendStream(seg) {
    var avail = (seg.stored || 0) - seg.sent;
    var finishing = seg.stopping && seg.finishedLocal;
    if (avail <= 0) {
      if (finishing && seg.sent >= seg.bytes && (seg.stored || 0) >= seg.bytes) return finishStream(seg, null, null);
      return Promise.resolve('idle');
    }
    var since = Date.now() - S.up.lastSendAt;
    var size = chunkSize();
    if (!finishing && since < SEND_EVERY_MS && avail < size) {
      clearTimeout(S.up.timer);
      S.up.timer = setTimeout(kick, SEND_EVERY_MS - since);
      return Promise.resolve('idle');
    }
    return Store.chunks(seg.local, seg.sent, size).then(function (list) {
      if (!list.length) return memoryGap(seg);
      var data = concat(list);
      var end = seg.sent + data.length;
      if (finishing && end >= seg.bytes) return finishStream(seg, data, list);
      return appendStream(seg, data, list);
    });
  }

  function recordNet(ms) {
    S.net.requests += 1;
    S.net.totalMs += ms;
    S.net.maxMs = Math.max(S.net.maxMs, ms);
  }

  /** Velocità misurata su una richiesta riuscita (media con le precedenti; dopo una prova vale la misura). */
  function adapt(bytes, ms) {
    var measured = (bytes * 1000) / Math.max(ms, 50);
    S.up.rate = S.up.probe ? measured : (S.up.rate + measured) / 2;
    S.up.probe = false;
  }

  function acked(seg, r) {
    if (typeof r.next === 'number' && r.next <= seg.bytes) seg.sent = r.next;
    if (r.seconds !== undefined) seg.serverSeconds = r.seconds;
    if (r.lesson !== undefined) { seg.lesson = r.lesson; if (r.lesson && r.lesson.id) seg.lessonId = r.lesson.id; }
    if (r.stopAt) seg.stopAt = r.stopAt;
    if (r.then !== undefined) seg.then = r.then;
    if (r.server) S.serverOffset = r.server - Date.now();
    S.lastAckAt = Date.now();
    saveSegmentsSoon();
    if (seg === S.current && S.screen === 'recording') renderRecordingInfo();
    if (r.stop && seg === S.current) cut(r.stop);
  }

  function appendStream(seg, data, list) {
    var b64 = toBase64(data);
    var timeout = timeoutFor(data.length);
    var t0 = Date.now();
    S.up.lastSendAt = t0;
    var end = seg.sent + data.length;
    return api({
      a: 'append', token: S.token, rec: seg.rec, offset: seg.sent, data: b64, seconds: list[list.length - 1].sec,
      pending: Math.max(0, seg.bytes - end) + otherPendingBytes(seg), recorded: seg.live || seg.seconds,
      paused: pausedByUser(), // l'audio registrato prima della pausa non deve cancellarla nel cloud
    }, timeout).then(function (r) {
      if (!r.ok) return handleRefusal(seg, r);
      var ms = Date.now() - t0;
      recordNet(ms);
      adapt(data.length, ms);
      acked(seg, r);
      return null;
    });
  }

  /** Ultima richiesta: gli ultimi byte e la chiusura del file nel cloud, insieme. */
  function finishStream(seg, data, list) {
    var b64 = data ? toBase64(data) : '';
    var t0 = Date.now();
    S.up.lastSendAt = t0;
    return api({
      a: 'stop', token: S.token, rec: seg.rec, offset: seg.sent, data: b64, end: seg.bytes,
      seconds: list ? list[list.length - 1].sec : seg.seconds, reason: seg.reason, net: netSummary(),
    }, timeoutFor(data ? data.length : 0) + 30000).then(function (r) {
      if (!r.ok && r.error === 'gap') { seg.sent = r.next; saveSegments(); return null; }
      if (!r.ok) return handleRefusal(seg, r);
      var summary = r.summary || {};
      if (summary.id !== seg.rec) throw new NetError('riepilogo di un\'altra registrazione'); // mai "salvata" senza conferma vera
      recordNet(Date.now() - t0);
      if (data && data.length) adapt(data.length, Date.now() - t0);
      // Il cloud aveva già chiuso il file prima di ricevere tutto (risposta "già salvata" ma più corta).
      if (r.already && summary.format === seg.format && typeof summary.bytes === 'number' && summary.bytes < seg.bytes) {
        return reopenStream(seg, { saved: summary });
      }
      seg.sent = seg.bytes;
      completeSegment(seg, summary);
      return null;
    });
  }

  /** Il file è nel cloud: il segmento esce dalla coda, la copia resta sul telefono. */
  function completeSegment(seg, summary) {
    removeSegment(seg);
    saveSegments();
    if (seg.cont) Store.dropChunks(seg.local); // copia parziale: quella completa è già tra le copie
    else archiveSegment(seg, summary, true);
    if (S.screen === 'copies') renderCopiesManager(); // appena arrivata nel cloud diventa eliminabile
    if (seg.onStopped) seg.onStopped(summary, seg);
  }

  function archiveSegment(seg, summary, complete) {
    if (!isStream(seg) || emptySegment(seg)) { if (isStream(seg)) Store.dropChunks(seg.local); return; }
    var s = summary || {};
    S.archive = S.archive.filter(function (a) { return a.local !== seg.local; });
    S.archive.unshift({
      local: seg.local, format: seg.format, bytes: seg.bytes, seconds: seg.seconds || seg.live || 0,
      at: seg.startedAt || seg.localStart || Date.now(), lesson: s.lesson || (seg.lesson && seg.lesson.title) || null,
      file: s.file || null, cloud: complete ? 'completa' : 'in due file', savedAt: Date.now(),
    });
    pruneArchive();
  }

  function pruneArchive() {
    var limit = Date.now() - KEEP.days * 86400000;
    var keep = [];
    S.archive.forEach(function (a, i) {
      if (i < KEEP.copies && a.savedAt >= limit) keep.push(a);
      else Store.dropChunks(a.local);
    });
    S.archive = keep;
    saveArchive();
  }

  function otherPendingBytes(seg) {
    var n = 0;
    S.segments.forEach(function (s) {
      if (s === seg) return;
      n += isStream(s) ? Math.max(0, s.bytes - s.sent) : Math.max(0, s.next - s.sent) * pieceSamples() * 2;
    });
    return n;
  }

  function pendingBytes() { return otherPendingBytes(null); }

  /** Manca un blocco sul telefono alla posizione da inviare (memoria del browser danneggiata): il resto va in un nuovo file. */
  function memoryGap(seg) {
    return Store.nextChunk(seg.local, seg.sent).then(function (next) {
      if (!next) return 'idle'; // scrittura ancora in corso
      report('errore', 'memoria del telefono', 'blocco mancante alla posizione ' + seg.sent + ' (il successivo inizia a ' + next.off + ')');
      return api({ a: 'stop', token: S.token, rec: seg.rec, offset: seg.sent, data: '', end: seg.sent, seconds: seg.serverSeconds || 0, reason: 'manual' }, 120000)
        .then(function (r) {
          if (!r.ok && r.error !== 'closed') return handleRefusal(seg, r);
          return reopenStream(seg, { saved: { format: seg.format, bytes: next.off } });
        });
    });
  }

  function handleRefusal(seg, r) {
    if (r.error === 'gap') {
      if (isStream(seg)) { if (r.next <= seg.bytes) seg.sent = r.next; } else seg.sent = r.next;
      saveSegments();
      return null;
    }
    if (r.error === 'closed') return isStream(seg) ? reopenStream(seg, r) : reopen(seg, r);
    if (r.error === 'auth') {
      // Codice cambiato: il microfono si spegne; l'audio già registrato resta e parte dopo il nuovo accesso.
      closeCurrentLocally('manual');
      logout('Accesso scaduto: inserisci di nuovo il codice. L\'audio registrato resta sul telefono e verrà inviato.');
      return 'blocked';
    }
    if (r.error === 'not_owner' || r.error === 'busy') return blocked(r);
    if (r.error !== 'retry') report('errore', 'risposta del cloud', r.error + ': ' + (r.message || ''));
    throw new NetError(r.message || r.error, false, true);
  }

  /** Spegne il microfono e chiude sul telefono il file che riceveva l'audio (resta in coda per l'invio). */
  function closeCurrentLocally(reason) {
    var seg = S.current;
    var e = S.engine;
    S.engine = null;
    if (S.recording) stopCapture();
    S.audioPaused = false;
    if (!seg) return Promise.resolve();
    S.current = null;
    seg.stopping = true;
    seg.reason = reason;
    return S.pausing.then(function () { return endEngine(e, 'finish'); }).then(function () { return sealSegment(seg); }).then(saveSegments);
  }

  /**
   * Il cloud ha chiuso la registrazione prima di ricevere tutto (telefono senza rete per molto tempo dopo la
   * lezione, subentro di un altro telefono, chiusura dalla dashboard): l'audio mancante va in un secondo file
   * della stessa lezione. Se il telefono sta ancora registrando, la registrazione continua in un file nuovo.
   */
  function reopenStream(old, reply) {
    var saved = reply && reply.saved;
    var savedBytes = saved && saved.format === old.format && typeof saved.bytes === 'number' ? saved.bytes : old.sent;
    var before = old === S.current ? rotate(old, old.reason || 'manual') : settled().then(function () { return sealSegment(old); });
    return Promise.resolve(before).then(settled).then(function () {
      if (savedBytes >= old.bytes) {
        // Il cloud ha già tutto l'audio di questo segmento.
        completeSegment(old, saved || {});
        return null;
      }
      return buildContinuation(old, savedBytes).then(function (cont) {
        if (!cont) { completeSegment(old, saved || {}); return null; } // mancava solo la chiusura del file
        var index = S.segments.indexOf(old);
        if (index >= 0) S.segments.splice(index, 1, cont);
        archiveSegment(old, saved, false);
        saveSegments();
        report('evento', 'secondo file', 'il cloud aveva ' + mb(savedBytes) + ' di ' + mb(old.bytes) + ': il resto (' + mb(old.bytes - savedBytes) + ') va in un secondo file della stessa lezione');
        toast('Il cloud aveva già chiuso la registrazione: l\'audio mancante va in un secondo file della stessa lezione.');
        return null;
      });
    });
  }

  /** Nuovo file con l'audio dalla posizione `from`: intestazione + pagine rinumerate (Ogg) o blocco iniziale + resto. */
  function buildContinuation(old, from) {
    var cont = newStreamSegment(old.format);
    cont.cont = true;
    cont.stopping = true;
    cont.reason = old.reason || 'manual';
    cont.onStopped = old.onStopped;
    cont.lessonHint = old.lessonId || old.lessonHint || null;
    cont.localStart = old.localStart;
    return Store.chunks(old.local, 0).then(function (all) {
      var head = all.filter(function (c) { return c.off < old.headBytes; });
      var start = Math.max(from, old.headBytes);
      var rest = all.filter(function (c) { return c.off >= start; });
      var out = head.map(function (c) { return { data: c.data, info: c }; });
      var base = 0; // posizione (campioni a 48 kHz) alla fine dell'audio già nel cloud
      all.forEach(function (c) { if (c.off + c.len <= start && c.off >= old.headBytes && c.gran > 0) base = c.gran; });
      // Niente audio dopo quello già nel cloud (al più i 20 ms della pagina di chiusura aggiunta qui): nessun secondo file.
      var last = rest[rest.length - 1];
      if (!rest.length || (old.format === 'ogg' && last.gran - base <= 960)) return null;
      if (old.format === 'ogg') {
        var seq = head.length;
        rest.forEach(function (c) {
          var page = MotoreAudio.rewritePage(new Uint8Array(c.data), seq, base);
          out.push({ data: page.buffer, info: { sec: (c.gran - base) / 48000, gran: c.gran - base, pseq: seq, flags: c.flags } });
          seq += 1;
        });
        cont.serial = old.serial;
      } else {
        rest.forEach(function (c) { out.push({ data: c.data, info: c }); });
      }
      var chain = Promise.resolve();
      out.forEach(function (o) {
        var off = cont.bytes;
        cont.bytes += o.data.byteLength;
        if (o.info.off !== undefined && o.info.off < old.headBytes) cont.headBytes = cont.bytes;
        cont.pseq = o.info.pseq;
        if (o.info.gran > 0) { cont.granule = o.info.gran; cont.seconds = o.info.gran / 48000; }
        chain = chain.then(function () { return writeChunk(cont, off, o.data, o.info); });
      });
      cont.seconds = cont.seconds || Math.max(0, (old.seconds || 0) - (rest[0] ? rest[0].sec || 0 : 0));
      // Il file è già chiuso se l'ultima pagina copiata ha la fine del flusso (il registratore l'aveva scritta);
      // altrimenti sealSegment la aggiunge. Mai due pagine di fine flusso.
      cont.finishedLocal = old.format !== 'ogg' || Boolean(out[out.length - 1].info.flags & 4);
      return chain.then(function () { return sealSegment(cont); }).then(function () { return cont; });
    });
  }

  function openSegment(seg) {
    var body = { a: 'start', token: S.token, client: deviceInfo(), lesson: seg.lessonHint || undefined, format: isStream(seg) ? seg.format : 'wav' };
    if (seg.localStart && !seg.lessonHint) body.at = seg.localStart + S.serverOffset; // lezione di quando si è iniziato a registrare
    return api(body, 90000).then(function (r) {
      if (!r.ok) return handleRefusal(seg, r);
      if (r.resumed) {
        var same = isStream(seg) ? r.rec.format === seg.format && r.rec.offset === seg.sent && seg.sent === 0 : r.rec.next === seg.sent;
        if (!same) {
          // Una registrazione di questo telefono era rimasta aperta: si chiude con quello che ha, poi se ne apre una nuova.
          var stop = r.rec.format && r.rec.format !== 'wav'
            ? { a: 'stop', token: S.token, rec: r.rec.id, offset: r.rec.offset, data: '', end: r.rec.offset, reason: 'manual' }
            : { a: 'stop', token: S.token, rec: r.rec.id, seq: r.rec.next, reason: 'manual' };
          return api(stop, 120000).then(function () { return null; });
        }
      }
      applyRec(seg, r.rec);
      S.lastAckAt = Date.now();
      saveSegments();
      if (seg === S.current && S.screen === 'recording') renderRecordingInfo();
      return null;
    });
  }

  /** "48 richieste · media 1,2 s · più lenta 6,3 s · arretrato massimo 40 s · 2 errori di rete · 3 segnali" */
  function netSummary() {
    var n = S.net;
    if (!n.requests) return '';
    var s = function (ms) { return (ms / 1000).toFixed(1).replace('.', ','); };
    var openMs = S.mic.openMs + (S.mic.openedAt ? performance.now() - S.mic.openedAt : 0);
    return n.requests + ' richieste · media ' + s(n.totalMs / n.requests) + ' s · più lenta ' + s(n.maxMs) +
      ' s · arretrato massimo ' + duration(n.maxBacklog) + ' · ' + n.failures + ' errori di rete · ' + n.beats + ' segnali di vita' +
      (n.mismatch ? ' · ' + n.mismatch + ' risposte non pertinenti scartate' : '') +
      (openMs > 5000 ? ' · microfono: ' + s(S.mic.seconds * 1000) + ' s di audio in ' + s(openMs) + ' s' : '') +
      (S.engineChoice ? ' · ' + S.engineChoice.label : '');
  }

  /** Un altro telefono ha il registratore: niente più audio da qui. */
  function blocked(r) {
    var who = r.active ? r.active.name : '';
    var seg = S.segments[0];
    if (seg && !seg.rec && seg === S.current) {
      // Appena avviata, ma un altro telefono ha preso il registratore un attimo prima: la lezione è coperta,
      // questi secondi non servono.
      var e = S.engine;
      S.engine = null;
      stopCapture();
      S.current = null;
      S.segments.shift();
      endEngine(e, 'finish').then(function () { Store.dropChunks(seg.local); });
      saveSegments();
      showError((who ? who + ' ha iniziato a registrare un attimo prima di te' : 'Il registratore è occupato') + ': la lezione è già coperta.');
    } else if (S.recording || S.current) {
      closeCurrentLocally('manual');
      toast((who ? who + ' ha preso il registratore' : 'Il registratore è occupato') + ': l\'audio già registrato resta sul telefono e verrà inviato appena si libera.');
    }
    if (S.screen === 'recording' || S.screen === 'interrupted') show('loading');
    refreshStatus();
    return 'blocked';
  }

  // ─── Versione precedente: WAV a pezzi numerati (audio rimasto sui telefoni) ──

  function newSegment(rec) {
    var seg = { local: uid(), rec: null, next: 0, sent: 0, stopping: false, reason: null, samples: 0, lesson: null, stopAt: null, then: null, startedAt: null };
    if (rec) applyRec(seg, rec);
    return seg;
  }

  function sendPiece(seg, piece) {
    var t0 = Date.now();
    var b64 = toBase64(piece.data);
    return api({ a: 'piece', token: S.token, rec: seg.rec, seq: piece.seq, data: b64 }, Math.max(60000, timeoutFor(piece.data.byteLength))).then(function (r) {
      if (r.ok) {
        recordNet(Date.now() - t0);
        var ackedSeq = r.next;
        var drop = [];
        for (var s = seg.sent; s < ackedSeq; s += 1) drop.push(Store.del(seg.local, s));
        seg.sent = Math.max(seg.sent, ackedSeq);
        seg.serverSeconds = r.seconds;
        S.lastAckAt = Date.now();
        saveSegments();
        return Promise.all(drop);
      }
      return handleRefusal(seg, r);
    });
  }

  /** Il cloud ha chiuso la registrazione WAV: l'audio rimasto va in un file nuovo della stessa lezione. */
  function reopen(old, reply) {
    return Store.list(old.local).then(function (rows) {
      var rest = rows.filter(function (p) { return p.seq >= old.sent; });
      var index = S.segments.indexOf(old);
      if (!rest.length) {
        // Il cloud ha già salvato tutto l'audio di questo segmento.
        removeSegment(old);
        saveSegments();
        if (old.onStopped) old.onStopped(reply && reply.saved, old);
        return null;
      }
      var seg = newSegment(null);
      seg.stopping = true;
      seg.reason = old.reason;
      seg.onStopped = old.onStopped;
      seg.lessonHint = old.lessonId || old.lessonHint || null; // resta abbinato alla lezione in cui è stato registrato
      var chain = Promise.resolve();
      rest.forEach(function (p, i) {
        chain = chain.then(function () { return Store.put(seg.local, i, p.data); }).then(function () { return Store.del(old.local, p.seq); });
      });
      return chain.then(function () {
        seg.next = rest.length;
        S.segments.splice(index, 1, seg);
        saveSegments();
        toast('Invio dell\'audio rimasto sul telefono in un nuovo file della stessa lezione.');
        return null;
      });
    });
  }

  function finishLegacy(seg) {
    return api({ a: 'stop', token: S.token, rec: seg.rec, seq: seg.next, reason: seg.reason, net: netSummary() }, 120000).then(function (r) {
      if (!r.ok && r.error === 'gap') { seg.sent = r.next; return null; }
      if (!r.ok && r.error === 'closed') r = { ok: true, summary: r.saved };
      if (!r.ok) return handleRefusal(seg, r);
      removeSegment(seg);
      saveSegments();
      if (seg.onStopped) seg.onStopped(r.summary, seg);
      return null;
    });
  }

  // ─── Stato dell'invio ─────────────────────────────────────────────────────

  /** Secondi di audio registrati e non ancora nel cloud (tutti i segmenti). */
  function pendingSeconds() {
    var total = 0;
    S.segments.forEach(function (s) {
      if (isStream(s)) {
        var rate = s.bytes && s.seconds ? s.bytes / s.seconds : 3000; // byte per secondo di questo file
        total += Math.max(0, s.bytes - s.sent) / rate;
      } else {
        total += (Math.max(0, s.next - s.sent) * pieceSamples()) / LEGACY_RATE;
      }
    });
    return total;
  }

  function updateSaved() {
    if (S.screen !== 'recording') return;
    var waiting = pendingSeconds();
    var seg = S.current;
    if (S.stopping) { updateStopPanel(waiting); return; }
    if (S.up.failures > 0) {
      $('saved-icon').className = 'row-icon row-icon--amber';
      $('saved-title').textContent = 'In attesa di rete';
      $('saved-sub').textContent = duration(waiting) + ' al sicuro sul telefono: partono appena la rete regge';
      return;
    }
    if (seg && !seg.rec) {
      $('saved-icon').className = 'row-icon row-icon--amber';
      $('saved-title').textContent = 'Collegamento al cloud…';
      $('saved-sub').textContent = 'l\'audio è già al sicuro sul telefono';
      return;
    }
    if (waiting > 30) {
      $('saved-icon').className = 'row-icon row-icon--amber';
      $('saved-title').textContent = 'Rete lenta: invio in corso';
      $('saved-sub').textContent = duration(waiting) + ' da inviare, al sicuro sul telefono';
      return;
    }
    $('saved-icon').className = 'row-icon row-icon--green';
    $('saved-title').textContent = 'Salvato nel cloud';
    if (!S.lastAckAt) { $('saved-sub').textContent = 'il primo invio parte entro 10 s'; return; }
    var ago = Math.round((Date.now() - S.lastAckAt) / 1000);
    $('saved-sub').textContent = 'fino a ' + ago + ' s fa' + (seg && seg.sent ? ' · ' + mb(seg.sent) : '');
  }

  /** Dopo "termina": copia sul telefono (subito) e invio al cloud (di solito pochi secondi). */
  function updateStopPanel(waiting) {
    var seg = S.stopping;
    var local = seg && seg.finishedLocal;
    var elapsed = Date.now() - (S.stopPressedAt || Date.now());
    $('stop-text').textContent = !local ? 'Salvataggio sul telefono…' : waiting >= 1 ? 'Invio di ' + duration(waiting) + ' di audio al cloud…' : 'Chiusura del file nel cloud…';
    if (elapsed < 2500 && S.up.failures === 0) return; // rete buona: compare direttamente "Salvata nel cloud"
    $('stop-panel').hidden = false;
    $('stop-phone-sub').textContent = local ? 'Copia completa: ' + clock(seg.seconds || seg.live || 0) + ' · ' + mb(seg.bytes) : 'chiusura del file…';
    $('stop-download').disabled = !local;
    $('stop-cloud-icon').className = 'row-icon ' + (S.up.failures ? 'row-icon--red' : 'row-icon--amber');
    $('stop-cloud-title').textContent = S.up.failures ? 'Cloud: in attesa di rete' : 'Cloud: invio in corso';
    $('stop-cloud-sub').textContent = (waiting >= 1 ? duration(waiting) + ' di audio da inviare' : 'chiusura del file') +
      (S.up.failures ? ' · nuovo tentativo tra pochi secondi. Lascia la pagina aperta: parte da solo appena c\'è rete.' : '');
  }

  // ─── Segnale di vita ──────────────────────────────────────────────────────

  /** La registrazione è in pausa per scelta (pulsante "Metti in pausa"), non per un'interruzione. */
  function pausedByUser() {
    return Boolean(S.audioPaused && S.interrupted && S.interrupted.manual);
  }

  /**
   * Se l'audio non riesce a partire da 30 s, un segnale di pochi byte: il cloud sa che si registra ancora.
   * In pausa il segnale lo dichiara (force: subito, appena messa in pausa).
   */
  function beat(force) {
    var seg = S.segments[0];
    if (!seg || !seg.rec || S.beating || !S.token) return;
    var now = Date.now();
    if (!force && now - Math.max(S.lastAckAt, S.lastBeatAt) < BEAT_MS) return;
    S.beating = true;
    S.lastBeatAt = now;
    var recorded = S.current ? S.current.live || S.current.seconds : seg.seconds || 0;
    api({ a: 'beat', token: S.token, rec: seg.rec, pending: pendingBytes(), recorded: recorded, paused: pausedByUser() }, 60000).then(function (r) {
      if (r.ok) {
        S.net.beats += 1;
        if (r.server) S.serverOffset = r.server - Date.now();
        if (r.stopAt) seg.stopAt = r.stopAt;
        if (r.then !== undefined) seg.then = r.then;
        if (r.stop && seg === S.current) cut(r.stop);
      } else if (r.error === 'closed' || r.error === 'not_owner' || r.error === 'auth') {
        kick(); // la coda di invio gestisce il caso alla prossima richiesta
      }
    }, function () { /* rete assente: riprova al prossimo giro */ }).finally(function () { S.beating = false; });
  }

  // ─── Interruzioni (telefonata, schermo bloccato su iPhone, app in primo piano) ──

  /** manual = pausa voluta (pulsante "Metti in pausa"): stessa sospensione, ma dichiarata al cloud e senza schermo acceso. */
  function interrupt(why, manual) {
    if (!S.recording || S.interrupted) return;
    S.interrupted = { at: manual ? Date.now() : Date.now() - Math.max(0, performance.now() - S.lastPcmAt), why: why, manual: Boolean(manual) };
    var a = S.audio;
    var seg = S.current;
    report('evento', manual ? 'pausa' : 'interruzione', why + (a ? ' · audio "' + a.ctx.state + '", microfono "' + (a.track ? a.track.readyState + (a.track.muted ? ', muto' : '') : '?') + '"' : '') +
      ' · ' + clock(seg ? seg.live || seg.seconds || 0 : 0) + ' registrati');
    var e = S.engine;
    S.engine = null;
    // Tutto l'audio ricevuto finisce sul telefono; il file resta aperto. Ripresa e chiusura aspettano questa pausa.
    S.pausing = endEngine(e, 'pause').then(saveSegments);
    stopCapture();
    S.recording = true; // la registrazione nel cloud resta aperta: si riprende nello stesso file
    S.audioPaused = true;
    renderInterrupted();
  }

  function renderInterrupted() {
    var seg = S.current;
    var gap = (Date.now() - S.interrupted.at) / 1000;
    var manual = S.interrupted.manual;
    top(seg && seg.lesson ? seg.lesson.title : 'Registrazione', seg && seg.lesson ? lessonLine(seg.lesson) : '');
    pill('warn', 'In pausa');
    $('int-title').textContent = manual ? 'Registrazione in pausa' : 'La registrazione si è fermata';
    $('int-missing-label').textContent = manual ? 'In pausa da' : 'Tratto non registrato';
    $('int-text').textContent = manual
      ? 'Il microfono è spento e puoi bloccare il telefono. Tutto quello registrato è al sicuro. Quando la lezione ricomincia, torna qui e tocca «Riprendi»: l\'audio continua nello stesso file.'
      : S.interrupted.why === 'pagina riaperta'
        ? 'La pagina è stata chiusa o ricaricata, ma la registrazione di questo telefono è ancora aperta: puoi riprenderla o chiuderla.'
        : 'Il microfono si è fermato: una chiamata, il blocco dello schermo o un\'altra app. Tutto quello registrato prima è al sicuro.';
    $('int-saved').textContent = clock(seg ? seg.live || seg.seconds || 0 : 0);
    $('int-missing').textContent = duration(gap);
    show('interrupted');
  }

  /**
   * Pausa della lezione: gli ultimi istanti passano al codificatore, il microfono si spegne, il file resta aperto
   * (stesso meccanismo collaudato delle interruzioni) e il cloud viene avvisato: il registratore resta di questo
   * telefono durante la pausa. "Riprendi" continua lo stesso file; "Termina qui" lo chiude.
   */
  function onPause() {
    if (S.pausingClick || !S.recording || S.audioPaused || S.stopping || !S.current || S.screen !== 'recording') return;
    S.pausingClick = true;
    $('pause-btn').disabled = true;
    flushAudio().then(function () {
      interrupt('pausa', true);
      beat(true);
    }).finally(function () {
      S.pausingClick = false;
      $('pause-btn').disabled = false;
    });
  }

  function onResume() {
    $('resume-btn').disabled = true;
    var gap = S.interrupted ? (Date.now() - S.interrupted.at) / 1000 : 0;
    chooseEngine().then(function (choice) {
      if (!choice) throw audioError('unsupported');
      // Prima la pausa del codificatore (ultima pagina scritta), poi la ripresa dallo stesso punto del file.
      return settled().then(function () { return openAudio(choice.rate); });
    }).then(function () {
      var seg = S.current;
      S.audioPaused = false;
      S.interrupted = null;
      S.recording = true;
      if (seg && (!isStream(seg) || seg.finishedLocal || S.engineChoice.kind !== 'opus' || seg.format !== S.engineChoice.format)) {
        // Non si può continuare lo stesso file (registratore del browser o versione precedente): file nuovo.
        if (isStream(seg)) rotate(seg, 'manual');
        else {
          seg.stopping = true;
          var fresh = newStreamSegment(S.engineChoice.format);
          fresh.localStart = Date.now();
          S.segments.push(fresh);
          S.current = fresh;
          if (!startEngineSafe(fresh)) showError('Il codificatore audio del telefono non parte: ricarica la pagina.');
        }
      } else if (seg && !startEngineSafe(seg)) {
        rotate(seg, 'manual'); // lo stesso file non riparte: si continua in un file nuovo
      }
      saveSegments();
      report('evento', 'ripresa', 'registrazione ripresa dopo ' + duration(gap));
      startRecordingScreen();
      kick();
    }, function (err) {
      report('errore', 'ripresa', (err && (err.code || err.name)) || 'errore');
      micError(err);
    }).finally(function () { $('resume-btn').disabled = false; });
  }

  function onEndHere() {
    S.audioPaused = false;
    S.interrupted = null;
    var seg = S.current;
    if (!seg) return;
    S.current = null;
    S.recording = false;
    seg.stopping = true;
    seg.reason = 'manual';
    seg.onStopped = showDone;
    S.stopping = seg;
    $('end-here-btn').disabled = true;
    $('end-here-btn').textContent = 'Chiusura…';
    settled().then(function () { return isStream(seg) ? sealSegment(seg) : null; }).then(function () {
      saveSegments();
      kick();
    });
  }

  function watchdog() {
    if (S.recording && !S.audioPaused && S.audio && document.visibilityState === 'visible') {
      var silentFor = performance.now() - S.lastPcmAt;
      if (silentFor > 3000) interrupt('audio fermo');
    }
    beat();
    if (S.screen === 'recording') {
      var seg = S.current;
      if (seg) $('timer').textContent = clock(seg.live || seg.seconds || 0);
      updateSaved();
      if (seg && seg.stopAt && serverNow() >= seg.stopAt) cut(seg.then ? 'next' : 'end');
      S.net.maxBacklog = Math.max(S.net.maxBacklog, pendingSeconds());
    }
    if (S.screen === 'interrupted' && S.interrupted) {
      var gap = (Date.now() - S.interrupted.at) / 1000;
      $('int-missing').textContent = duration(gap);
    }
    if (S.screen === 'busy' && S.busyBase) {
      $('busy-timer').textContent = clock((serverNow() - S.busyBase.startedAt) / 1000);
    }
  }

  // ─── Copie sul telefono ───────────────────────────────────────────────────

  var MIME = { ogg: 'audio/ogg', m4a: 'audio/mp4', webm: 'audio/webm', wav: 'audio/wav' };

  function copyName(entry) {
    var when = new Date(entry.at || Date.now());
    var stamp = when.getFullYear() + '-' + pad(when.getMonth() + 1) + '-' + pad(when.getDate()) + '_' + pad(when.getHours()) + pad(when.getMinutes());
    var title = String(entry.lesson || 'Registrazione').replace(/[^A-Za-z0-9À-ÿ_-]+/g, '_').slice(0, 60);
    return title + '_' + stamp + '.' + entry.format;
  }

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  /** Scarica la copia sul telefono di un segmento (audio compresso) o di audio WAV rimasto. */
  function downloadCopy(local) {
    var seg = S.segments.filter(function (s) { return s.local === local; })[0];
    var entry = S.archive.filter(function (a) { return a.local === local; })[0];
    if (seg && !isStream(seg)) return downloadLegacy(seg);
    var info = entry || (seg && { format: seg.format, at: seg.startedAt || seg.localStart, lesson: seg.lesson && seg.lesson.title });
    if (!info) return Promise.resolve();
    return S.writing.then(function () { return Store.chunks(local, 0); }).then(function (list) {
      if (!list.length) { showError('La copia sul telefono non c\'è più.'); return; }
      saveBlob(new Blob(list.map(function (c) { return c.data; }), { type: MIME[info.format] || 'application/octet-stream' }), copyName(info));
    });
  }

  /** Audio WAV della versione precedente ancora sul telefono: file WAV completo (intestazione con le dimensioni). */
  function downloadLegacy(seg) {
    return Store.list(seg.local).then(function (rows) {
      var size = 0;
      rows.forEach(function (p) { size += p.data.byteLength; });
      var h = new DataView(new ArrayBuffer(44));
      var text = function (o, s) { for (var i = 0; i < s.length; i += 1) h.setUint8(o + i, s.charCodeAt(i)); };
      text(0, 'RIFF'); h.setUint32(4, 36 + size, true); text(8, 'WAVEfmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true);
      h.setUint16(22, 1, true); h.setUint32(24, LEGACY_RATE, true); h.setUint32(28, LEGACY_RATE * 2, true); h.setUint16(32, 2, true);
      h.setUint16(34, 16, true); text(36, 'data'); h.setUint32(40, size, true);
      saveBlob(new Blob([h.buffer].concat(rows.map(function (p) { return p.data; })), { type: 'audio/wav' }),
        copyName({ format: 'wav', at: seg.startedAt || Date.now(), lesson: (seg.lesson && seg.lesson.title) || 'Audio_rimasto' }));
    });
  }

  /**
   * Registrazioni sul telefono: prima quelle in attesa di invio (mai eliminabili: l'audio non è ancora nel
   * cloud), poi le copie di quelle già nel cloud (eliminabili). Ognuna: { local, title, when, seconds, bytes, state, warn, deletable }.
   */
  function copyItems() {
    var items = [];
    S.segments.forEach(function (s) {
      if (s === S.current) return;
      // Versione precedente: sul telefono restano solo i pezzi non ancora inviati (quelli scaricabili).
      items.push({ local: s.local, title: (s.lesson && s.lesson.title) || 'Registrazione', when: s.startedAt || s.localStart, seconds: isStream(s) ? s.seconds || s.live : (Math.max(0, s.next - s.sent) * pieceSamples()) / LEGACY_RATE, bytes: isStream(s) ? s.bytes : 0, state: 'in attesa di invio', warn: true, deletable: false });
    });
    S.archive.forEach(function (a) {
      var pending = S.segments.some(function (s) { return s.local === a.local; });
      items.push({ local: a.local, title: a.lesson || 'Registrazione', when: a.at, seconds: a.seconds, bytes: a.bytes, state: a.cloud === 'completa' ? 'nel cloud ✓' : 'nel cloud (in due file)', deletable: !pending });
    });
    return items;
  }

  /** Riga di una registrazione: casella (se eliminabile e richiesta), titolo, dettagli, "Scarica". */
  function copyRow(it, withCheck) {
    var row = document.createElement('div');
    row.className = 'copy';
    if (withCheck) {
      if (it.deletable) {
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'copy-check';
        box.checked = S.copySel.has(it.local);
        box.setAttribute('aria-label', 'Seleziona ' + it.title);
        box.dataset.local = it.local;
        box.addEventListener('change', function () {
          if (box.checked) S.copySel.add(it.local);
          else S.copySel.delete(it.local);
          updateCopiesActions();
        });
        row.appendChild(box);
      } else {
        var slot = document.createElement('span');
        slot.className = 'copy-check-slot';
        row.appendChild(slot);
      }
    }
    var text = document.createElement('div');
    text.className = 'copy-text';
    var title = document.createElement('div');
    title.className = 'copy-title';
    title.textContent = it.title;
    var sub = document.createElement('div');
    sub.className = 'copy-sub' + (it.warn ? ' copy-sub--warn' : '');
    sub.textContent = (it.when ? dayTime(it.when) + ' · ' : '') + duration(it.seconds || 0) + (it.bytes ? ' · ' + mb(it.bytes) : '') + ' · ' + it.state;
    text.appendChild(title);
    text.appendChild(sub);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.textContent = 'Scarica';
    btn.setAttribute('aria-label', 'Scarica la copia di ' + it.title);
    btn.addEventListener('click', function () { downloadCopy(it.local); });
    row.appendChild(text);
    row.appendChild(btn);
    return row;
  }

  /** Elenco delle copie sul telefono (schermata iniziale: le ultime 8; "Gestisci" apre l'elenco completo). */
  function renderCopies() {
    var items = copyItems();
    $('copies-card').hidden = !items.length;
    $('copies-manage').textContent = 'Gestisci (' + items.length + ')';
    var list = $('copies-list');
    list.textContent = '';
    items.slice(0, 8).forEach(function (it) { list.appendChild(copyRow(it, false)); });
  }

  // ─── Registrazioni sul telefono: elenco completo, selezione, eliminazione ───

  function openCopies() {
    S.copySel = new Set();
    renderCopiesManager();
    show('copies');
  }

  function renderCopiesManager() {
    var items = copyItems();
    var deletable = items.filter(function (it) { return it.deletable; });
    // Selezione valida solo per copie ancora presenti ed eliminabili.
    var still = new Set(deletable.map(function (it) { return it.local; }));
    Array.from(S.copySel).forEach(function (l) { if (!still.has(l)) S.copySel.delete(l); });
    var list = $('copies-all');
    list.textContent = '';
    if (!items.length) {
      var empty = document.createElement('p');
      empty.className = 'small muted';
      empty.textContent = 'Nessuna registrazione sul telefono.';
      list.appendChild(empty);
    }
    items.forEach(function (it) { list.appendChild(copyRow(it, true)); });
    var total = items.reduce(function (n, it) { return n + (it.bytes || 0); }, 0);
    $('copies-space').textContent = items.length + (items.length === 1 ? ' registrazione' : ' registrazioni') + ' sul telefono · ' + mb(total) +
      ' · ' + deletable.length + ' già nel cloud' + (items.length - deletable.length ? ', ' + (items.length - deletable.length) + ' in attesa di invio' : '');
    $('copies-all-check').disabled = !deletable.length;
    updateCopiesActions();
  }

  function updateCopiesActions() {
    var n = S.copySel.size;
    var deletable = copyItems().filter(function (it) { return it.deletable; }).length;
    $('copies-delete').disabled = n === 0;
    $('copies-delete').textContent = n ? 'Elimina selezionate (' + n + ')' : 'Elimina selezionate';
    $('copies-all-check').checked = deletable > 0 && n === deletable;
  }

  function toggleAllCopies() {
    var check = $('copies-all-check').checked;
    S.copySel = new Set(check ? copyItems().filter(function (it) { return it.deletable; }).map(function (it) { return it.local; }) : []);
    Array.prototype.forEach.call(document.querySelectorAll('#copies-all .copy-check'), function (box) { box.checked = S.copySel.has(box.dataset.local); });
    updateCopiesActions();
  }

  /** Elimina dal telefono le copie selezionate: solo quelle già nel cloud (mai l'audio in attesa di invio). */
  function deleteSelectedCopies() {
    var ok = copyItems().filter(function (it) { return it.deletable && S.copySel.has(it.local); }).map(function (it) { return it.local; });
    if (!ok.length) return Promise.resolve();
    var question = 'Eliminare ' + (ok.length === 1 ? 'questa registrazione' : 'queste ' + ok.length + ' registrazioni') + ' dal telefono?\n' +
      'Sono già nel cloud: restano su Dropbox e Drive. Sul telefono non si potranno più scaricare.';
    if (!window.confirm(question)) return Promise.resolve();
    $('copies-delete').disabled = true;
    var drop = new Set(ok);
    return Promise.all(ok.map(function (l) { return Store.dropChunks(l); })).then(function () {
      S.archive = S.archive.filter(function (a) { return !drop.has(a.local); });
      S.copySel = new Set();
      return saveArchive();
    }).then(function () {
      renderCopiesManager();
      toast(ok.length === 1 ? 'Registrazione eliminata dal telefono.' : ok.length + ' registrazioni eliminate dal telefono.');
    });
  }

  function closeCopies() {
    if (S.status) { renderReady(S.status); refreshStatus(); } // subito la schermata, poi lo stato aggiornato
    else { show('loading'); refreshStatus(true); }
  }

  // ─── Schermo sempre acceso ────────────────────────────────────────────────

  function applyWake() {
    var supported = 'wakeLock' in navigator;
    var switches = document.querySelectorAll('[data-wake]');
    Array.prototype.forEach.call(switches, function (b) {
      b.setAttribute('aria-checked', String(S.wakeWanted && supported));
      b.disabled = !supported;
    });
    var sub = supported ? (S.wakeWanted ? 'Il telefono non si blocca durante la lezione' : 'Disattivato: lo schermo si spegne come sempre')
      : 'Non disponibile su questo telefono: allunga il blocco automatico nelle impostazioni';
    $('wake-sub').textContent = sub;
    Array.prototype.forEach.call(document.querySelectorAll('[data-wake-sub]'), function (el) {
      el.textContent = !supported ? 'non disponibile qui' : S.wakeWanted ? 'non si blocca da solo' : 'disattivato';
    });
    if (!supported) return;
    // In pausa voluta lo schermo può spegnersi (il microfono è già spento).
    var inPause = S.screen === 'interrupted' && pausedByUser();
    var want = S.wakeWanted && document.visibilityState === 'visible' && !inPause && (S.screen === 'ready' || S.screen === 'recording' || S.screen === 'interrupted');
    if (want && !S.wakeLock && !S.wakeRequesting) {
      S.wakeRequesting = true;
      navigator.wakeLock.request('screen').then(function (lock) {
        S.wakeLock = lock;
        lock.addEventListener('release', function () { if (S.wakeLock === lock) S.wakeLock = null; });
      }, function (err) {
        // Negato (per esempio risparmio energetico): si riprova al prossimo cambio; segnalato una volta sola.
        if (!S.wakeReported) { S.wakeReported = true; report('evento', 'schermo sempre acceso', 'non concesso: ' + ((err && (err.name || err.message)) || 'motivo sconosciuto')); }
      }).finally(function () { S.wakeRequesting = false; });
    } else if (!want && S.wakeLock) {
      var lock = S.wakeLock;
      S.wakeLock = null;
      lock.release().catch(function () {});
    }
  }

  function toggleWake() {
    S.wakeWanted = !S.wakeWanted;
    ls.set(KEYS.wake, S.wakeWanted ? '1' : '0');
    applyWake();
  }

  // ─── Microfono: stato e problemi ──────────────────────────────────────────

  function updateMicRow() {
    var set = function (kind, title, sub) {
      $('mic-icon').className = 'row-icon row-icon--' + kind;
      $('mic-title').textContent = title;
      $('mic-sub').textContent = sub;
    };
    var format = 'Audio compresso sul telefono: un\'ora ≈ 11 MB';
    if (!navigator.permissions || !navigator.permissions.query) { set('green', 'Microfono', 'Il permesso viene chiesto al primo avvio'); return; }
    navigator.permissions.query({ name: 'microphone' }).then(function (p) {
      var apply = function () {
        if (p.state === 'granted') set('green', 'Microfono consentito', format);
        else if (p.state === 'denied') set('red', 'Microfono bloccato', 'Consentilo nelle impostazioni del browser per questo sito');
        else set('green', 'Microfono', 'Il permesso viene chiesto al primo avvio');
      };
      apply();
      p.onchange = apply;
    }, function () { set('green', 'Microfono', 'Il permesso viene chiesto al primo avvio'); });
  }

  function micError(err) {
    var code = err && err.code;
    if (code === 'denied') {
      message('Microfono non consentito', isIOS
        ? 'Su iPhone: tocca "aA" nella barra dell\'indirizzo › Impostazioni sito web › Microfono › Consenti (oppure Impostazioni › Safari › Microfono). Poi torna qui e riprova.'
        : 'Tocca il lucchetto accanto all\'indirizzo › Autorizzazioni › Microfono › Consenti. Poi torna qui e riprova.', 'Riprova', function () { location.reload(); });
    } else if (code === 'unsupported') {
      message('Browser non adatto', 'Questo browser non permette di registrare. Su iPhone usa Safari (iOS 14.5 o successivo), su Android usa Chrome.', 'Riprova');
    } else if (code === 'nomic') {
      message('Nessun microfono', 'Il telefono non ha reso disponibile nessun microfono. Riavvia il browser e riprova.', 'Riprova');
    } else {
      showError('Non è stato possibile avviare il microfono. Riprova.');
    }
  }

  var toastTimer = null;
  function toast(text) {
    banner(text);
    $('banner').querySelector('.notice').className = 'notice notice--info';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { banner(''); }, 7000);
  }
  function showError(text) {
    banner(text);
    $('banner').querySelector('.notice').className = 'notice notice--red';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { banner(''); }, 9000);
  }

  // ─── Completata ───────────────────────────────────────────────────────────

  function showDone(summary, seg) {
    S.recording = false;
    S.stopping = null;
    S.net = { requests: 0, totalMs: 0, maxMs: 0, maxBacklog: 0, failures: 0, beats: 0, mismatch: 0 };
    S.mic = { seconds: 0, openMs: 0, openedAt: 0 };
    $('stop-help').hidden = true;
    $('stop-help').textContent = 'Tieni premuto il pulsante per circa un secondo.';
    $('stop-panel').hidden = true;
    var s = summary || {};
    var auto = s.reason && /automatic/.test(s.reason);
    $('done-title').textContent = s.file ? 'Salvata nel cloud' : 'Registrazione chiusa';
    $('done-text').textContent = s.file
      ? (auto ? 'Si è fermata da sola 15 minuti dopo la fine della lezione. ' : '') + 'Il file è nel cloud da questo momento: puoi chiudere la pagina.'
      : 'Non c\'era audio da salvare.';
    $('done-lesson').textContent = s.lesson || 'nessuna in calendario';
    $('done-duration').textContent = duration(s.seconds || 0);
    var verified = seg && isStream(seg) && s.bytes === seg.bytes;
    $('done-size').textContent = mb(s.bytes || 0) + (verified ? ' · identica al telefono ✓' : '');
    $('done-folder').textContent = s.folder || '—';
    $('done-cloud-sub').textContent = verified ? 'Verificato: nel cloud ' + mb(s.bytes) + ', come sul telefono' : 'Ogni secondo di audio è arrivato';
    var copy = seg && isStream(seg) && S.archive.some(function (a) { return a.local === seg.local; });
    $('done-download').hidden = !copy;
    $('done-download').onclick = copy ? function () { downloadCopy(seg.local); } : null;
    show('done');
  }

  // ─── Stato dal cloud ──────────────────────────────────────────────────────

  function refreshStatus(first) {
    if (!S.token) { showLogin(); return Promise.resolve(null); }
    return api({ a: 'status', token: S.token }, 60000).then(function (st) {
      if (!first && S.screen === 'message') return st;
      S.status = st;
      if (st.server) S.serverOffset = st.server - Date.now();
      if (st.settings) S.settings = st.settings;
      if (!st.configured) {
        message('Registratore non ancora attivo', 'Il codice di accesso non è stato ancora impostato. Riprova più tardi.', 'Riprova');
        return st;
      }
      if (!st.auth) { logout(first ? '' : 'Accesso scaduto: inserisci di nuovo il codice.'); return st; }
      S.name = st.name;
      ls.set(KEYS.name, st.name);
      if ($('banner').querySelector('.notice').className.indexOf('red') >= 0 && /connessione/i.test($('banner-text').textContent)) banner('');
      decide(st);
      return st;
    }, function () {
      if (first) {
        // Senza rete la pagina resta utilizzabile per le copie sul telefono.
        message('Nessuna connessione', 'Non riesco a raggiungere il registratore. Controlla la connessione e riprova.' +
          (S.segments.length ? ' L\'audio rimasto sul telefono è al sicuro e partirà appena c\'è rete.' : ''), 'Riprova');
      } else if (S.screen === 'ready' || S.screen === 'busy') showError('Connessione assente: nuovo tentativo tra pochi secondi.');
      return null;
    });
  }

  function decide(st) {
    if (S.screen === 'recording' || S.screen === 'done' || S.screen === 'interrupted') return;
    var active = st.active;
    // Segmenti rimasti sul telefono che non sono la registrazione aperta da riprendere: vanno solo chiusi e inviati
    // (anche quella aperta, se il suo file sul telefono è già chiuso: "termina" premuto prima della ricarica).
    S.segments.forEach(function (s) {
      if (active && active.mine && s.rec === active.id && isStream(s) && !s.finishedLocal) return;
      if (!s.stopping) { s.stopping = true; s.reason = s.reason || 'manual'; }
      if (isStream(s)) sealSegment(s);
    });
    if (active && active.mine) {
      // Questo telefono ha una registrazione aperta (pagina ricaricata, scheda chiusa per sbaglio).
      var seg = S.segments.filter(function (s) { return s.rec === active.id; })[0];
      if (seg && isStream(seg) && !seg.finishedLocal) {
        applyRec(seg, active);
        seg.stopping = false;
        S.current = seg;
        S.recording = true;
        S.audioPaused = true;
        S.interrupted = { at: Date.now() - (active.silentMs || 0), why: 'pagina riaperta' };
        saveSegments();
        kick();
        renderInterrupted();
        return;
      }
      if (!seg) {
        // La registrazione aperta non ha più una copia su questo telefono (dati del browser cancellati, o
        // versione precedente della pagina): si chiude nel cloud con l'audio già ricevuto.
        var stop = active.format && active.format !== 'wav'
          ? { a: 'stop', token: S.token, rec: active.id, offset: active.offset, data: '', end: active.offset, reason: 'manual' }
          : { a: 'stop', token: S.token, rec: active.id, seq: active.next, reason: 'manual' };
        api(stop, 120000).then(function () { refreshStatus(); }, function () {});
        report('evento', 'registrazione aperta senza copia', 'chiusa nel cloud con l\'audio già ricevuto');
      }
      saveSegments();
      kick();
      renderReady(st);
      return;
    }
    if (active && !active.mine) {
      renderBusy(st);
      if (active.free) kick();
      return;
    }
    saveSegments();
    if (S.segments.length) kick(); // audio rimasto sul telefono da una registrazione precedente
    renderReady(st);
  }

  function poll() {
    if (document.visibilityState !== 'visible') return;
    if (S.screen === 'ready' || S.screen === 'busy' || S.screen === 'interrupted') refreshStatus();
  }

  // ─── Accesso ──────────────────────────────────────────────────────────────

  function showLogin(error) {
    $('login-name').value = S.name || '';
    $('login-error').textContent = error || '';
    show('login');
  }

  function logout(error) {
    S.token = null;
    ls.del(KEYS.token);
    showLogin(error);
  }

  function onLogin(event) {
    event.preventDefault();
    var name = $('login-name').value.trim();
    var code = $('login-code').value.trim();
    if (!name) { $('login-error').textContent = 'Scrivi il tuo nome.'; $('login-name').focus(); return; }
    if (!code) { $('login-error').textContent = 'Inserisci il codice di accesso.'; $('login-code').focus(); return; }
    $('login-submit').disabled = true;
    $('login-error').textContent = '';
    api({ a: 'login', name: name, code: code, device: deviceId }, 60000).then(function (r) {
      if (!r.ok) { $('login-error').textContent = r.message || 'Accesso non riuscito.'; return null; }
      S.token = r.token;
      S.name = r.name;
      ls.set(KEYS.token, r.token);
      ls.set(KEYS.name, r.name);
      $('login-code').value = '';
      return refreshStatus(true);
    }, function () {
      $('login-error').textContent = 'Nessuna connessione: controlla la rete e riprova.';
    }).finally(function () { $('login-submit').disabled = false; });
  }

  // ─── Pulsante "tieni premuto per terminare" ───────────────────────────────

  function bindStopButton() {
    var btn = $('stop-btn');
    var fill = $('stop-fill');
    var start = 0;
    var raf = 0;
    var timer = 0;
    var HOLD = 1000;
    function reset() { start = 0; cancelAnimationFrame(raf); clearTimeout(timer); fill.style.width = '0'; }
    // Il riempimento è solo grafico; l'arresto lo decide il timer (funziona anche se le animazioni sono sospese).
    function frame() {
      if (!start) return;
      fill.style.width = Math.min(100, ((performance.now() - start) / HOLD) * 100) + '%';
      raf = requestAnimationFrame(frame);
    }
    function complete() {
      if (!start) return;
      reset();
      stopRecording('manual');
    }
    function down(e) {
      if (btn.disabled) return;
      if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
      if (e.type === 'keydown' && e.repeat) return;
      e.preventDefault();
      start = performance.now();
      $('stop-help').hidden = true;
      raf = requestAnimationFrame(frame);
      timer = setTimeout(complete, HOLD);
    }
    function up() {
      if (start && performance.now() - start < HOLD) $('stop-help').hidden = false;
      reset();
    }
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointerleave', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('keydown', down);
    btn.addEventListener('keyup', up);
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  // ─── Avvio della pagina ───────────────────────────────────────────────────

  function bind() {
    $('login-form').addEventListener('submit', onLogin);
    $('start-btn').addEventListener('click', onStart);
    $('takeover-btn').addEventListener('click', onStart);
    $('resume-btn').addEventListener('click', onResume);
    $('end-here-btn').addEventListener('click', onEndHere);
    $('pause-btn').addEventListener('click', onPause);
    $('copies-manage').addEventListener('click', openCopies);
    $('copies-back').addEventListener('click', closeCopies);
    $('copies-all-check').addEventListener('change', toggleAllCopies);
    $('copies-delete').addEventListener('click', deleteSelectedCopies);
    $('stop-download').addEventListener('click', function () { if (S.stopping) downloadCopy(S.stopping.local); });
    $('done-back').addEventListener('click', function () { $('end-here-btn').disabled = false; $('end-here-btn').textContent = 'Termina qui'; show('loading'); refreshStatus(true); });
    $('change-name').addEventListener('click', function () { logout(''); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-wake]'), function (b) { b.addEventListener('click', toggleWake); });
    bindStopButton();
    document.addEventListener('visibilitychange', function () {
      applyWake();
      if (document.visibilityState === 'hidden') { S.hiddenAt = Date.now(); saveSegments(); return; }
      if (document.visibilityState === 'visible') {
        var hiddenFor = S.hiddenAt ? (Date.now() - S.hiddenAt) / 1000 : 0;
        S.hiddenAt = 0;
        if (S.recording && !S.audioPaused && hiddenFor > 5) {
          var flowing = performance.now() - S.lastPcmAt < 3000;
          report('evento', 'pagina nascosta', 'per ' + duration(hiddenFor) + ' durante la registrazione; audio ' + (flowing ? 'continuato' : 'fermo') +
            (S.audio ? ' ("' + S.audio.ctx.state + '")' : ''));
        }
        if (isIOS && S.screen === 'recording' && hiddenFor > 2 && performance.now() - S.lastPcmAt >= 3000) {
          showError('Mentre la pagina era nascosta, iPhone ha messo in pausa il microfono: circa ' + duration(hiddenFor) + ' non registrati.');
        }
        if (S.audio && S.audio.ctx.state !== 'running') S.audio.ctx.resume().catch(function () {});
        S.lastPcmAt = Math.max(S.lastPcmAt, performance.now() - 1500); // un attimo per riprendere
        poll();
        kick();
      }
    });
    window.addEventListener('online', function () { kick(); poll(); });
    window.addEventListener('pagehide', function () { saveSegments(); });
    window.addEventListener('beforeunload', function (e) {
      if (S.recording || pendingBytes() > 0) { e.preventDefault(); e.returnValue = ''; }
    });
    setInterval(watchdog, 1000);
    setInterval(poll, 5000);
  }

  /**
   * Dopo una chiusura improvvisa: dimensione, numero di pagina e posizione reali dall'ultimo blocco salvato;
   * intestazione Ogg e numero di serie dalle prime pagine (le informazioni salvate a parte possono essere
   * indietro di qualche secondo, le pagine no).
   */
  function reconcile(seg) {
    if (!isStream(seg)) return Promise.resolve();
    return Store.lastChunk(seg.local).then(function (c) {
      if (!c) { seg.bytes = seg.stored = 0; seg.sent = 0; seg.headBytes = 0; return null; }
      seg.bytes = seg.stored = c.off + c.len;
      if (seg.sent > seg.bytes) seg.sent = seg.bytes;
      if (seg.format === 'ogg') {
        seg.pseq = c.pseq;
        if (c.gran > 0) seg.granule = c.gran;
        if (c.flags & 4) seg.finishedLocal = true;
      }
      if (c.sec) seg.seconds = Math.max(seg.seconds || 0, c.sec);
      seg.live = Math.max(seg.live || 0, seg.seconds || 0);
      if (seg.format !== 'ogg') return null;
      return Store.chunks(seg.local, 0, 16 * 1024).then(function (first) {
        // Pagina 0 = OpusHead (inizio del flusso), pagina 1 = OpusTags: insieme sono l'intestazione.
        var head = first.filter(function (p) { return p.pseq === 0 || p.pseq === 1; });
        if (head.length && head[0].off === 0) {
          seg.serial = new DataView(head[0].data).getUint32(14, true);
          seg.headBytes = head.length === 2 ? head[0].len + head[1].len : 0;
        }
      });
    });
  }

  function boot() {
    buildMeter();
    bind();
    Promise.all([Store.getMeta('segments'), Store.getMeta('archive')]).then(function (meta) {
      (meta[0] || []).forEach(function (s) {
        var seg = s.mode === 'stream' ? newStreamSegment(s.format) : newSegment(null);
        Object.keys(s).forEach(function (k) { seg[k] = s[k]; });
        S.segments.push(seg);
      });
      S.archive = Array.isArray(meta[1]) ? meta[1] : [];
      return Promise.all(S.segments.map(reconcile));
    }).catch(function (err) {
      report('errore', 'avvio', 'lettura della memoria del telefono: ' + (err && err.message));
    }).finally(function () {
      if (!S.token) { showLogin(); return; }
      refreshStatus(true);
    });
  }

  // Per i test automatici: stato interno, simulazione della perdita del microfono, audio di prova.
  window.__registratore = {
    state: S,
    interrupt: function () { if (S.audio && S.audio.track) { S.audio.track.stop(); interrupt('test'); } },
    // Prove di durata: il microfono resta acceso ma i suoi campioni vengono ignorati, e l'audio di prova entra
    // dallo stesso punto del microfono (stesso percorso: codificatore, memoria del telefono, coda di invio).
    detachMic: function () { if (S.audio) S.audio.node.port.onmessage = function (e) { if (e.data.type === 'level') pushLevel(e.data.rms); }; },
    feed: function (f32) { onWorklet({ data: { type: 'f32', pcm: f32.buffer } }); },
    pending: function () { return pendingSeconds(); },
    copy: function (local) { return S.writing.then(function () { return Store.chunks(local, 0); }).then(function (list) { return toBase64(concat(list)); }); },
  };

  boot();
})();
