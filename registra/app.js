/*
 * app.js — registratore delle lezioni (pagina del link in bio).
 *
 * Percorso dell'audio: microfono → worklet.js (22.050 Hz, 16 bit, mono) → pezzi da 10 secondi
 * salvati PRIMA sul telefono (IndexedDB) → coda di invio al cloud (Apps Script), un pezzo alla volta
 * e in ordine. Un pezzo viene tolto dal telefono solo quando il cloud conferma di averlo scritto: se la
 * rete cade, se la pagina viene ricaricata o il telefono si spegne, i pezzi restano e partono dopo.
 *
 * "Segmento" = una registrazione nel cloud (un file). Di solito ce n'è uno; diventano due quando alla
 * fine della lezione ne comincia subito un'altra (passaggio automatico a un nuovo file) o quando il
 * cloud ha chiuso la registrazione mentre il telefono era senza rete (l'audio successivo va in un
 * file nuovo, niente va perso).
 */
(function () {
  'use strict';

  var ENDPOINT = 'https:\/\/script.google.com/macros/s/AKfycbwOD_JmvrcildRkTfVQ6FKFkxIieSZOLPqISfoeN7pkRKOgSQZ53n1NiOjm8snDlu4mVQ/exec'; // ingresso del registratore (Apps Script)
  var RATE = 22050;
  var KEYS = { token: 'registratore.token', name: 'registratore.nome', device: 'registratore.telefono', wake: 'registratore.schermo' };
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

  /** Pezzi audio e segmenti su IndexedDB (in memoria se il browser non lo consente). */
  var Store = (function () {
    var mem = { pieces: new Map(), meta: new Map() };
    var opening = null;
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
    function key(local, seq) { return local + ':' + ('00000' + seq).slice(-6); }
    return {
      put: function (local, seq, data) {
        var rec = { k: key(local, seq), local: local, seq: seq, data: data };
        return run('pieces', 'readwrite', function (s) { if (!s) { mem.pieces.set(rec.k, rec); return null; } return s.put(rec); })
          .catch(function () { mem.pieces.set(rec.k, rec); });
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
        var from = local + ':';
        var inMem = Array.from(mem.pieces.values()).filter(function (p) { return p.local === local; });
        return run('pieces', 'readonly', function (s) { return s ? s.getAll(IDBKeyRange.bound(from, from + '￿')) : null; })
          .then(function (rows) { return (rows || []).concat(inMem).sort(function (a, b) { return a.seq - b.seq; }); })
          .catch(function () { return inMem; });
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
    settings: { pieceSeconds: 10, sampleRate: RATE, lockMs: 120000 },
    serverOffset: 0,
    status: null,
    audio: null,
    segments: [], // coda: il primo è quello che si sta inviando
    current: null, // segmento che riceve l'audio
    pre: [], // audio arrivato prima della conferma del cloud
    buffer: null,
    fill: 0,
    lastPcmAt: 0,
    recording: false,
    interrupted: null, // { at, savedSeconds }
    up: { running: false, again: false, failures: 0, waiting: null },
    lastAckAt: 0,
    wakeWanted: ls.get(KEYS.wake) !== '0',
    wakeLock: null,
    levels: [],
    cutting: false,
    stopping: null, // segmento in chiusura (arresto premuto): la pagina mostra quanto audio resta da inviare
    net: { pieces: 0, totalMs: 0, maxMs: 0, maxBacklog: 0 },
  };

  function pieceSamples() { return Math.round((S.settings.pieceSeconds || 10) * RATE); }
  function serverNow() { return Date.now() + S.serverOffset; }
  function saveSegments() {
    var plain = S.segments.map(function (s) {
      return {
        local: s.local, rec: s.rec, next: s.next, sent: s.sent, stopping: s.stopping, reason: s.reason, samples: s.samples, lesson: s.lesson,
        stopAt: s.stopAt, then: s.then, startedAt: s.startedAt, lessonId: s.lessonId || null, lessonHint: s.lessonHint || null,
      };
    });
    return Store.setMeta('segments', plain);
  }

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
  function mb(bytes) { return (bytes / 1e6).toFixed(1).replace('.', ',') + ' MB'; }
  function hhmm(ms) {
    return new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
  }

  // ─── Rete ─────────────────────────────────────────────────────────────────

  function NetError(message) { this.message = message; this.network = true; }

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
        try { return JSON.parse(text); } catch (e) { throw new NetError('risposta non valida (HTTP ' + res.status + ')'); }
      });
    }, function (err) {
      throw new NetError(err && err.name === 'AbortError' ? 'tempo scaduto' : 'rete non raggiungibile');
    }).finally(function () { clearTimeout(timer); });
  }

  /** "iOS 17.6 · Safari 17.6 · audio 48 kHz running": per capire a distanza su che telefono succede cosa. */
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
    return os + ' · ' + browser + (standalone ? ' · dalla schermata Home' : '') + audio + ('wakeLock' in navigator ? '' : ' · schermo acceso non disponibile');
  }

  /** Segnalazione al registro del cloud (al massimo 20 per pagina aperta, senza mai disturbare la registrazione). */
  var reportsLeft = 20;
  function report(kind, where, message) {
    if (reportsLeft <= 0) return;
    reportsLeft -= 1;
    try {
      api({ a: 'report', token: S.token, kind: kind, where: where, message: String(message || '').slice(0, 300), device: deviceInfo() }, 20000).catch(function () {});
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
    var bytes = new Uint8Array(buffer);
    var parts = [];
    for (var i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
    return btoa(parts.join(''));
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ─── Schermate ────────────────────────────────────────────────────────────

  var SCREENS = ['loading', 'login', 'ready', 'recording', 'busy', 'interrupted', 'done', 'message'];
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
    show('ready');
    updateMicRow();
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

  function openAudio() {
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
        .then(function () { return withTimeout(ctx.audioWorklet.addModule('worklet.js'), 15000, 'caricamento del modulo audio'); })
        .then(function () { return ctx; });
    }).then(function (ctx) {
      var source = ctx.createMediaStreamSource(stream);
      var node = new AudioWorkletNode(ctx, 'registratore', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      var mute = ctx.createGain();
      mute.gain.value = 0; // il worklet va collegato all'uscita perché venga eseguito, ma senza suono
      source.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
      node.port.onmessage = onWorklet;
      var track = stream.getAudioTracks()[0];
      track.onended = function () { if (S.recording) interrupt('microfono chiuso dal telefono'); };
      S.audio = { ctx: ctx, stream: stream, source: source, node: node, mute: mute, track: track, flushWaiters: [] };
      S.lastPcmAt = performance.now();
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
    try { a.node.port.onmessage = null; a.node.disconnect(); } catch (e) { /* già chiuso */ }
    try { a.source.disconnect(); } catch (e) { /* già chiuso */ }
    a.stream.getTracks().forEach(function (t) { t.onended = null; t.stop(); });
    try { a.ctx.close(); } catch (e) { /* già chiuso */ }
  }

  /** Chiede al worklet i campioni ancora in memoria (meno di un secondo) e li aggiunge. */
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
    if (msg.type !== 'pcm') return;
    S.lastPcmAt = performance.now();
    var samples = new Int16Array(msg.pcm);
    if (samples.length && S.recording) {
      if (S.current) addSamples(samples);
      else S.pre.push(samples);
    }
    if (msg.flushed && S.audio) {
      var waiters = S.audio.flushWaiters.splice(0);
      waiters.forEach(function (w) { w(); });
    }
  }

  function addSamples(samples) {
    var size = pieceSamples();
    if (!S.buffer || S.buffer.length !== size) { S.buffer = new Int16Array(size); S.fill = 0; }
    var off = 0;
    while (off < samples.length) {
      var take = Math.min(samples.length - off, size - S.fill);
      S.buffer.set(samples.subarray(off, off + take), S.fill);
      S.fill += take;
      off += take;
      S.current.samples += take;
      if (S.fill === size) closePiece();
    }
  }

  /** Il pezzo in costruzione diventa un pezzo numerato, salvato sul telefono e messo in coda. */
  function closePiece() {
    if (!S.fill || !S.current) return Promise.resolve();
    var seg = S.current;
    var seq = seg.next;
    seg.next += 1;
    var data = S.buffer.slice(0, S.fill).buffer;
    S.fill = 0;
    var saved = Store.put(seg.local, seq, data).then(function () { kick(); });
    saveSegments();
    return saved;
  }

  // ─── Registrazione ────────────────────────────────────────────────────────

  function newSegment(rec) {
    var seg = { local: uid(), rec: null, next: 0, sent: 0, stopping: false, reason: null, samples: 0, lesson: null, stopAt: null, then: null, startedAt: null };
    if (rec) applyRec(seg, rec);
    return seg;
  }

  function applyRec(seg, rec) {
    seg.rec = rec.id;
    seg.lesson = rec.lesson || null;
    if (rec.lesson && rec.lesson.id) seg.lessonId = rec.lesson.id;
    seg.stopAt = rec.stopAt || null;
    seg.then = rec.then || null;
    seg.startedAt = rec.startedAt;
    if (rec.next > seg.sent) { seg.sent = rec.next; seg.next = Math.max(seg.next, rec.next); }
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
    startButtonBusy(true, 'Attivazione del microfono…');
    var hint = setTimeout(function () {
      if (S.starting) startButtonBusy(true, 'Consenti l\'uso del microfono nella richiesta del telefono');
    }, 2500);
    openAudio().then(function () {
      var seg = newSegment(null);
      seg.localStart = Date.now();
      S.segments.push(seg);
      S.current = seg;
      S.recording = true;
      S.pre.splice(0).forEach(addSamples);
      saveSegments();
      startButtonBusy(false);
      startRecordingScreen();
      kick();
    }, function (err) {
      stopCapture();
      startButtonBusy(false);
      report('errore', 'avvio del microfono', (err && (err.code || err.name)) + (err && err.message && err.message !== err.code ? ': ' + err.message : ''));
      micError(err);
    }).finally(function () {
      clearTimeout(hint);
      S.starting = false;
    });
  }

  function withTimeout(promise, ms, what) {
    return Promise.race([promise, sleep(ms).then(function () { throw new Error('tempo scaduto: ' + what); })]);
  }

  function stopCapture() {
    S.recording = false;
    S.pre = [];
    closeAudio();
  }

  function startRecordingScreen() {
    S.interrupted = null;
    renderRecordingInfo();
    $('ios-warning').hidden = !isIOS;
    $('android-note').hidden = !isAndroid;
    $('stop-btn').disabled = false;
    $('stop-text').textContent = 'Tieni premuto per terminare';
    show('recording');
    updateSaved();
  }

  /** Arresto: gli ultimi campioni diventano l'ultimo pezzo; il cloud chiude il file quando li ha tutti. */
  function stopRecording(reason) {
    if (!S.current) return Promise.resolve();
    var seg = S.current;
    $('stop-btn').disabled = true;
    $('stop-text').textContent = 'Invio degli ultimi secondi…';
    S.stopping = seg;
    $('stop-help').textContent = 'Non chiudere la pagina finché non compare «Registrazione inviata».';
    $('stop-help').hidden = false;
    return flushAudio().then(function () {
      stopCapture();
      return closePiece();
    }).then(function () {
      S.current = null;
      seg.stopping = true;
      seg.reason = reason;
      seg.onStopped = showDone;
      saveSegments();
      kick();
    });
  }

  /** Fine lezione: 'next' = passa a un nuovo file per la lezione successiva; 'end' = arresto. */
  function cut(kind) {
    if (S.cutting || !S.current || S.current.stopping) return;
    if (kind === 'end') { stopRecording('auto'); return; }
    S.cutting = true;
    closePiece().then(function () {
      var old = S.current;
      old.stopping = true;
      old.reason = 'next';
      var seg = newSegment(null);
      S.segments.push(seg);
      S.current = seg;
      saveSegments();
      kick();
      toast(old.then ? 'Comincia ' + old.then.title + ': la registrazione continua in un nuovo file.' : 'La registrazione continua in un nuovo file.');
    }).finally(function () { S.cutting = false; });
  }

  // ─── Coda di invio ────────────────────────────────────────────────────────

  function kick() {
    if (S.up.waiting) { S.up.waiting(); return; } // in attesa dopo un errore: si riprova subito
    if (S.up.running) { S.up.again = true; return; }
    S.up.running = true;
    runQueue().catch(function () {}).then(function () {
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
    if (!seg.rec) step = openSegment(seg);
    else {
      step = Store.get(seg.local, seg.sent).then(function (piece) {
        if (piece) return sendPiece(seg, piece);
        if (seg.stopping && seg.sent >= seg.next) return finishSegment(seg);
        return 'idle';
      });
    }
    return step.then(function (result) {
      S.up.failures = 0;
      updateSaved();
      if (result === 'idle' || result === 'blocked') return null;
      return runQueue();
    }, function () {
      // Rete assente o cloud occupato: si riprova con attese crescenti (al massimo 15 s), l'audio resta
      // sul telefono. L'attesa finisce subito se torna la rete o se si termina la registrazione.
      S.up.failures += 1;
      updateSaved();
      var wait = Math.min(15000, 2000 * Math.pow(2, Math.min(S.up.failures - 1, 3)));
      if (S.stopping) wait = Math.min(wait, 4000); // in chiusura si riprova più spesso: chi registra sta aspettando
      return new Promise(function (resolve) {
        var timer = setTimeout(resolve, wait);
        S.up.waiting = function () { clearTimeout(timer); resolve(); };
      }).then(function () { S.up.waiting = null; return runQueue(); });
    });
  }

  function sendPiece(seg, piece) {
    var t0 = Date.now();
    return api({ a: 'piece', token: S.token, rec: seg.rec, seq: piece.seq, data: toBase64(piece.data) }, 60000).then(function (r) {
      if (r.ok) {
        // Statistiche della rete (inviate al cloud a fine registrazione, per la diagnostica).
        var ms = Date.now() - t0;
        S.net.pieces += 1;
        S.net.totalMs += ms;
        S.net.maxMs = Math.max(S.net.maxMs, ms);
        var acked = r.next;
        var drop = [];
        for (var s = seg.sent; s < acked; s += 1) drop.push(Store.del(seg.local, s));
        seg.sent = Math.max(seg.sent, acked);
        seg.serverSeconds = r.seconds;
        if (r.lesson !== undefined) seg.lesson = r.lesson;
        if (r.stopAt) seg.stopAt = r.stopAt;
        if (r.then !== undefined) seg.then = r.then;
        S.lastAckAt = Date.now();
        saveSegments();
        if (seg === S.current && S.screen === 'recording') renderRecordingInfo();
        if (r.stop && seg === S.current) cut(r.stop);
        return Promise.all(drop);
      }
      return handleRefusal(seg, r);
    });
  }

  function handleRefusal(seg, r) {
    if (r.error === 'gap') {
      seg.sent = r.next;
      saveSegments();
      return null;
    }
    if (r.error === 'closed') return reopen(seg, r);
    if (r.error === 'auth') {
      // Codice cambiato: il microfono si spegne; l'audio già registrato resta e parte dopo il nuovo accesso.
      if (S.recording) stopCapture();
      if (S.current) { closePiece(); S.current.stopping = true; S.current.reason = 'manual'; S.current = null; }
      saveSegments();
      logout('Accesso scaduto: inserisci di nuovo il codice. L\'audio registrato resta sul telefono e verrà inviato.');
      return 'blocked';
    }
    if (r.error === 'not_owner' || r.error === 'busy') return blocked(r);
    if (r.error !== 'retry') report('errore', 'risposta del cloud', r.error + ': ' + (r.message || ''));
    throw new NetError(r.message || r.error);
  }

  /** Il cloud ha chiuso la registrazione (silenzio lungo, subentro, dashboard): l'audio rimasto va in un file nuovo. */
  function reopen(old, reply) {
    return Store.list(old.local).then(function (rows) {
      var rest = rows.filter(function (p) { return p.seq >= old.sent; });
      var isCurrent = old === S.current;
      var index = S.segments.indexOf(old);
      if (!rest.length && !isCurrent) {
        // Il cloud ha già salvato tutto l'audio di questo segmento.
        S.segments.splice(index, 1);
        saveSegments();
        if (old.stopping && old.onStopped) old.onStopped(reply && reply.saved, old);
        return null;
      }
      var seg = newSegment(null);
      seg.stopping = old.stopping;
      seg.reason = old.reason;
      seg.onStopped = old.onStopped;
      // Audio già registrato (non quello che sta arrivando adesso): resta abbinato alla sua lezione.
      if (!isCurrent) seg.lessonHint = old.lessonId || old.lessonHint || null;
      var chain = Promise.resolve();
      rest.forEach(function (p, i) {
        chain = chain.then(function () { return Store.put(seg.local, i, p.data); }).then(function () { return Store.del(old.local, p.seq); });
      });
      return chain.then(function () {
        seg.next = rest.length;
        S.segments.splice(index, 1, seg);
        if (isCurrent) S.current = seg;
        saveSegments();
        toast('La registrazione precedente è stata chiusa e salvata: continuo in un nuovo file.');
        return null;
      });
    });
  }

  function openSegment(seg) {
    return api({ a: 'start', token: S.token, client: deviceInfo(), lesson: seg.lessonHint || undefined }, 30000).then(function (r) {
      if (!r.ok) return handleRefusal(seg, r);
      if (r.resumed && r.rec.next !== seg.sent) {
        // Una registrazione di questo telefono era rimasta aperta: si chiude, poi se ne apre una nuova.
        return api({ a: 'stop', token: S.token, rec: r.rec.id, seq: r.rec.next, reason: 'manual' }, 60000).then(function () { return null; });
      }
      applyRec(seg, r.rec);
      saveSegments();
      if (seg === S.current && S.screen === 'recording') renderRecordingInfo();
      return null;
    });
  }

  /** "720 pezzi · invio medio 3,1 s per 10 s di audio · più lento 12,4 s · ritardo massimo 40 s" */
  function netSummary() {
    var n = S.net;
    if (!n.pieces) return '';
    var s = function (ms) { return (ms / 1000).toFixed(1).replace('.', ','); };
    return n.pieces + ' pezzi · invio medio ' + s(n.totalMs / n.pieces) + ' s per 10 s di audio · più lento ' + s(n.maxMs) +
      ' s · ritardo massimo accumulato ' + duration(n.maxBacklog);
  }

  function finishSegment(seg) {
    return api({ a: 'stop', token: S.token, rec: seg.rec, seq: seg.next, reason: seg.reason, net: netSummary() }, 60000).then(function (r) {
      if (!r.ok && r.error === 'gap') { seg.sent = r.next; return null; }
      if (!r.ok && r.error === 'closed') r = { ok: true, summary: r.saved };
      if (!r.ok) return handleRefusal(seg, r);
      S.segments.splice(S.segments.indexOf(seg), 1);
      saveSegments();
      if (seg.onStopped) seg.onStopped(r.summary, seg);
      return null;
    });
  }

  /** Un altro telefono ha il registratore: niente più audio da qui. */
  function blocked(r) {
    var who = r.active ? r.active.name : '';
    var seg = S.segments[0];
    if (seg && !seg.rec && seg === S.current) {
      // Appena avviata, ma un altro telefono ha preso il registratore un attimo prima: la lezione è coperta,
      // questi secondi non servono.
      stopCapture();
      S.current = null;
      S.segments.shift();
      Store.list(seg.local).then(function (rows) { rows.forEach(function (p) { Store.del(seg.local, p.seq); }); });
      saveSegments();
      showError((who ? who + ' ha iniziato a registrare un attimo prima di te' : 'Il registratore è occupato') + ': la lezione è già coperta.');
    } else if (S.recording || S.current) {
      if (S.recording) stopCapture();
      if (S.current) { closePiece(); S.current.stopping = true; S.current.reason = 'manual'; S.current = null; }
      saveSegments();
      toast((who ? who + ' ha preso il registratore' : 'Il registratore è occupato') + ': l\'audio già registrato resta sul telefono e verrà inviato appena si libera.');
    }
    if (S.screen === 'recording' || S.screen === 'interrupted') show('loading');
    refreshStatus();
    return 'blocked';
  }

  function pendingSeconds() {
    var samples = 0;
    S.segments.forEach(function (s) { samples += Math.max(0, s.next - s.sent) * pieceSamples(); });
    return samples / RATE + S.fill / RATE;
  }

  function updateSaved() {
    if (S.screen !== 'recording') return;
    var waiting = pendingSeconds();
    if (S.up.failures > 0) {
      $('saved-icon').className = 'row-icon row-icon--amber';
      $('saved-title').textContent = 'In attesa di rete';
      $('saved-sub').textContent = Math.round(waiting) + ' s al sicuro sul telefono';
      return;
    }
    var current = S.current;
    if (current && !current.rec) {
      $('saved-icon').className = 'row-icon row-icon--amber';
      $('saved-title').textContent = 'Collegamento al cloud…';
      $('saved-sub').textContent = 'l\'audio è già al sicuro sul telefono';
      return;
    }
    $('saved-icon').className = 'row-icon row-icon--green';
    $('saved-title').textContent = 'Salvato nel cloud';
    if (!S.lastAckAt) { $('saved-sub').textContent = 'il primo pezzo parte dopo 10 s'; return; }
    var ago = Math.round((Date.now() - S.lastAckAt) / 1000);
    var seg = S.current;
    var bytes = seg && seg.serverSeconds ? seg.serverSeconds * 44100 + 44 : 0;
    $('saved-sub').textContent = 'fino a ' + ago + ' s fa' + (bytes ? ' · ' + mb(bytes) : '');
  }

  // ─── Interruzioni (telefonata, schermo bloccato su iPhone, app in primo piano) ──

  function interrupt(why) {
    if (!S.recording || S.interrupted) return;
    S.interrupted = { at: Date.now() - Math.max(0, performance.now() - S.lastPcmAt), why: why };
    var a = S.audio;
    report('evento', 'interruzione', why + (a ? ' · audio "' + a.ctx.state + '", microfono "' + (a.track ? a.track.readyState + (a.track.muted ? ', muto' : '') : '?') + '"' : '') +
      ' · ' + clock(S.current ? S.current.samples / RATE : 0) + ' registrati');
    closePiece();
    stopCapture();
    S.recording = true; // la registrazione nel cloud resta aperta: si riprende nello stesso file
    S.audioPaused = true;
    renderInterrupted();
  }

  function renderInterrupted() {
    var seg = S.current;
    var gap = (Date.now() - S.interrupted.at) / 1000;
    top(seg && seg.lesson ? seg.lesson.title : 'Registrazione', seg && seg.lesson ? lessonLine(seg.lesson) : '');
    pill('warn', 'In pausa');
    $('int-text').textContent = S.interrupted.why === 'pagina riaperta'
      ? 'La pagina è stata chiusa o ricaricata, ma la registrazione di questo telefono è ancora aperta: puoi riprenderla o chiuderla.'
      : 'Il microfono si è fermato: una chiamata, il blocco dello schermo o un\'altra app. Tutto quello registrato prima è al sicuro.';
    $('int-saved').textContent = clock(seg ? seg.samples / RATE : 0);
    $('int-missing').textContent = duration(gap);
    show('interrupted');
  }

  function onResume() {
    $('resume-btn').disabled = true;
    var gap = S.interrupted ? (Date.now() - S.interrupted.at) / 1000 : 0;
    openAudio().then(function () {
      S.audioPaused = false;
      S.interrupted = null;
      S.recording = true;
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
    saveSegments();
    kick();
    $('end-here-btn').disabled = true;
    $('end-here-btn').textContent = 'Chiusura…';
  }

  function watchdog() {
    if (S.recording && !S.audioPaused && S.audio && document.visibilityState === 'visible') {
      var silentFor = performance.now() - S.lastPcmAt;
      if (silentFor > 3000) interrupt('audio fermo');
    }
    if (S.screen === 'recording') {
      var seg = S.current;
      if (seg) $('timer').textContent = clock(seg.samples / RATE);
      updateSaved();
      if (seg && seg.stopAt && serverNow() >= seg.stopAt) cut(seg.then ? 'next' : 'end');
      if (seg) S.net.maxBacklog = Math.max(S.net.maxBacklog, Math.max(0, seg.next - seg.sent) * (S.settings.pieceSeconds || 10));
      if (S.stopping) {
        // Arresto: quanto audio resta da inviare (di solito pochi secondi; di più solo se la rete era lenta).
        var left = pendingSeconds();
        $('stop-text').textContent = left >= 1 ? 'Invio di ' + duration(left) + ' di audio…' : 'Chiusura del file nel cloud…';
      }
    }
    if (S.screen === 'interrupted' && S.interrupted) {
      var gap = (Date.now() - S.interrupted.at) / 1000;
      $('int-missing').textContent = duration(gap);
    }
    if (S.screen === 'busy' && S.busyBase) {
      $('busy-timer').textContent = clock((serverNow() - S.busyBase.startedAt) / 1000);
    }
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
    var want = S.wakeWanted && document.visibilityState === 'visible' && (S.screen === 'ready' || S.screen === 'recording' || S.screen === 'interrupted');
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
    if (!navigator.permissions || !navigator.permissions.query) { set('green', 'Microfono', 'Il permesso viene chiesto al primo avvio'); return; }
    navigator.permissions.query({ name: 'microphone' }).then(function (p) {
      var apply = function () {
        if (p.state === 'granted') set('green', 'Microfono consentito', 'Audio WAV come il registratore di sempre');
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

  function showDone(summary) {
    S.recording = false;
    S.stopping = null;
    S.net = { pieces: 0, totalMs: 0, maxMs: 0, maxBacklog: 0 };
    $('stop-help').hidden = true;
    $('stop-help').textContent = 'Tieni premuto il pulsante per circa un secondo.';
    var s = summary || {};
    var auto = s.reason && /automatic/.test(s.reason);
    $('done-title').textContent = s.file ? 'Registrazione inviata' : 'Registrazione chiusa';
    $('done-text').textContent = s.file
      ? (auto ? 'Si è fermata da sola 15 minuti dopo la fine della lezione. ' : '') + 'Puoi chiudere la pagina: al resto pensa il sistema.'
      : 'Non c\'era audio da salvare.';
    $('done-lesson').textContent = s.lesson || 'nessuna in calendario';
    $('done-duration').textContent = duration(s.seconds || 0);
    $('done-size').textContent = mb(s.bytes || 0);
    $('done-folder').textContent = s.folder || '—';
    $('done-split').textContent = (s.bytes || 0) > 200e6 ? 'Oltre 200 MB: viene divisa in _1, _2… per NotebookLM' : 'Sotto i 200 MB: resta un file unico';
    show('done');
  }

  // ─── Stato dal cloud ──────────────────────────────────────────────────────

  function refreshStatus(first) {
    if (!S.token) { showLogin(); return Promise.resolve(null); }
    return api({ a: 'status', token: S.token }, 20000).then(function (st) {
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
      if (first) message('Nessuna connessione', 'Non riesco a raggiungere il registratore. Controlla la connessione e riprova.', 'Riprova');
      else if (S.screen === 'ready' || S.screen === 'busy') showError('Connessione assente: nuovo tentativo tra pochi secondi.');
      return null;
    });
  }

  function decide(st) {
    if (S.screen === 'recording' || S.screen === 'done' || S.screen === 'interrupted') return;
    var active = st.active;
    // Segmenti rimasti sul telefono che non sono la registrazione aperta: vanno solo inviati e chiusi.
    S.segments.forEach(function (s) {
      if (!(active && active.mine && s.rec === active.id)) s.stopping = true;
    });
    if (active && active.mine) {
      // Questo telefono ha una registrazione aperta (pagina ricaricata, scheda chiusa per sbaglio).
      var seg = S.segments.filter(function (s) { return s.rec === active.id; })[0];
      if (!seg) { seg = newSegment(active); seg.samples = Math.round(active.seconds * RATE); S.segments.push(seg); }
      else applyRec(seg, active);
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
    if (active && !active.mine) {
      renderBusy(st);
      if (active.free) kick();
      return;
    }
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
    api({ a: 'login', name: name, code: code, device: deviceId }, 30000).then(function (r) {
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
    $('done-back').addEventListener('click', function () { $('end-here-btn').disabled = false; $('end-here-btn').textContent = 'Termina qui'; show('loading'); refreshStatus(true); });
    $('change-name').addEventListener('click', function () { logout(''); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-wake]'), function (b) { b.addEventListener('click', toggleWake); });
    bindStopButton();
    document.addEventListener('visibilitychange', function () {
      applyWake();
      if (document.visibilityState === 'hidden') { S.hiddenAt = Date.now(); return; }
      if (document.visibilityState === 'visible') {
        var hiddenFor = S.hiddenAt ? (Date.now() - S.hiddenAt) / 1000 : 0;
        S.hiddenAt = 0;
        if (S.recording && hiddenFor > 5) {
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
    window.addEventListener('beforeunload', function (e) {
      if (S.recording || pendingSeconds() > 0) { e.preventDefault(); e.returnValue = ''; }
    });
    setInterval(watchdog, 1000);
    setInterval(poll, 5000);
  }

  function boot() {
    buildMeter();
    bind();
    Store.getMeta('segments').then(function (list) {
      (list || []).forEach(function (s) {
        var seg = newSegment(null);
        Object.keys(s).forEach(function (k) { seg[k] = s[k]; });
        S.segments.push(seg);
      });
    }).finally(function () {
      if (!S.token) { showLogin(); return; }
      refreshStatus(true);
    });
  }

  // Per i test automatici: stato interno e simulazione della perdita del microfono.
  window.__registratore = {
    state: S,
    interrupt: function () { if (S.audio && S.audio.track) { S.audio.track.stop(); interrupt('test'); } },
    // Prove di durata: il microfono resta acceso ma i suoi campioni vengono ignorati, e l'audio di prova entra
    // dallo stesso punto del microfono (stesso percorso: pezzi, memoria del telefono, coda di invio).
    detachMic: function () { if (S.audio) S.audio.node.port.onmessage = function (e) { if (e.data.type === 'level') pushLevel(e.data.rms); }; },
    feed: function (int16) { onWorklet({ data: { type: 'pcm', pcm: int16.buffer } }); },
  };

  boot();
})();
