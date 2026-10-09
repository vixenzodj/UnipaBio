/*
 * motore.js — codifica dell'audio sul telefono (registratore delle lezioni).
 *
 * L'audio non viaggia più come WAV non compresso (circa 470 kbit/s da inviare, che una rete d'aula non
 * regge), ma compresso in Opus a 24 kbit/s: il codec delle chiamate web, di WhatsApp e di Zoom, ottimo per
 * la voce. Un'ora di lezione pesa circa 11 MB invece di 159 MB. Il file è Ogg Opus (RFC 7845), uno dei
 * formati accettati da NotebookLM ("ogg", "opus").
 *
 *  - MotoreOpus: codificatore WebCodecs AudioEncoder (Chrome per Android, iPhone con iOS 26, Samsung
 *    Internet, Firefox 130+) e contenitore Ogg costruito qui, pagina per pagina (RFC 3533 e 7845):
 *    il flusso continua anche dopo un'interruzione (stesso file).
 *  - MotoreMediaRecorder: ripiego per i browser senza WebCodecs (iPhone con iOS precedenti): registratore
 *    integrato del browser in AAC (m4a) o Ogg; dopo un'interruzione si riparte con un file nuovo.
 * Ogni pezzo prodotto (una pagina Ogg, circa 1 s di audio, o un blocco del registratore) passa alla pagina,
 * che lo salva sul telefono prima di inviarlo.
 */
(function () {
  'use strict';

  // ─── Ogg (RFC 3533) ────────────────────────────────────────────────────────

  // CRC-32 di Ogg: polinomio 0x04c11db7, valore iniziale 0, nessuna riflessione, nessuna inversione finale.
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var i = 0; i < 256; i += 1) {
      var r = i << 24;
      for (var j = 0; j < 8; j += 1) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
      t[i] = r >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0;
    for (var i = 0; i < bytes.length; i += 1) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
    return c >>> 0;
  }

  function setGranule(dv, granule) {
    if (granule < 0) {
      dv.setUint32(6, 0xffffffff, true);
      dv.setUint32(10, 0xffffffff, true);
    } else {
      dv.setUint32(6, granule % 4294967296, true);
      dv.setUint32(10, Math.floor(granule / 4294967296), true);
    }
  }

  /**
   * Pagina Ogg. flags: 1 = pacchetto continuato, 2 = inizio del flusso, 4 = fine del flusso.
   * granule: posizione (campioni a 48 kHz) a fine pagina, -1 se nessun pacchetto termina qui.
   */
  function oggPage(flags, granule, serial, seq, packets) {
    var lacing = [];
    var dataLength = 0;
    packets.forEach(function (p) {
      var l = p.length;
      while (l >= 255) { lacing.push(255); l -= 255; }
      lacing.push(l);
      dataLength += p.length;
    });
    if (lacing.length > 255) throw new Error('pagina Ogg con troppi segmenti');
    var page = new Uint8Array(27 + lacing.length + dataLength);
    var dv = new DataView(page.buffer);
    page[0] = 0x4f; page[1] = 0x67; page[2] = 0x67; page[3] = 0x53; // "OggS"
    page[4] = 0; // versione
    page[5] = flags;
    setGranule(dv, granule);
    dv.setUint32(14, serial, true);
    dv.setUint32(18, seq, true);
    dv.setUint32(22, 0, true);
    page[26] = lacing.length;
    page.set(lacing, 27);
    var off = 27 + lacing.length;
    packets.forEach(function (p) { page.set(p, off); off += p.length; });
    dv.setUint32(22, crc32(page), true);
    return page;
  }

  /**
   * Copia di una pagina con numero di sequenza e posizione nuovi (file di continuazione): CRC ricalcolato.
   * granuleBase viene sottratto alla posizione (che resta -1 se era -1).
   */
  function rewritePage(page, seq, granuleBase, flags) {
    var p = new Uint8Array(page);
    var dv = new DataView(p.buffer);
    var lo = dv.getUint32(6, true);
    var hi = dv.getUint32(10, true);
    if (!(lo === 0xffffffff && hi === 0xffffffff)) setGranule(dv, hi * 4294967296 + lo - granuleBase);
    if (flags !== undefined) p[5] = flags;
    dv.setUint32(18, seq, true);
    dv.setUint32(22, 0, true);
    dv.setUint32(22, crc32(p), true);
    return p;
  }

  function ascii(text) {
    var out = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0x7f;
    return out;
  }

  /** OpusHead (RFC 7845 §5.1), mono, famiglia di canali 0. */
  function opusHead(preSkip, inputRate) {
    var h = new Uint8Array(19);
    var dv = new DataView(h.buffer);
    h.set(ascii('OpusHead'), 0);
    h[8] = 1;
    h[9] = 1;
    dv.setUint16(10, preSkip, true);
    dv.setUint32(12, inputRate, true);
    dv.setInt16(16, 0, true);
    h[18] = 0;
    return h;
  }

  /** OpusTags (RFC 7845 §5.2): nome del programma, nessun commento. */
  function opusTags() {
    var vendor = ascii('Registratore Lezioni UniPA (WebCodecs)');
    var t = new Uint8Array(8 + 4 + vendor.length + 4);
    var dv = new DataView(t.buffer);
    t.set(ascii('OpusTags'), 0);
    dv.setUint32(8, vendor.length, true);
    t.set(vendor, 12);
    dv.setUint32(12 + vendor.length, 0, true);
    return t;
  }

  // ─── Codificatore Opus (WebCodecs) ─────────────────────────────────────────

  // 24 kbit/s: voce ad alta qualità (i messaggi vocali usano 16-24 kbit/s) e margine sulle reti lente: misurato il
  // 9 ottobre 2026 nel cloud vero, a 64 kbit/s in invio i 32 kbit/s stavano al limite (ogni richiesta costa ~3 s fissi).
  var OPUS_CONFIGS = [
    { sampleRate: 24000, bitrate: 24000 },
    { sampleRate: 48000, bitrate: 24000 },
    { sampleRate: 16000, bitrate: 20000 },
  ];

  function opusConfig(c) {
    return { codec: 'opus', sampleRate: c.sampleRate, numberOfChannels: 1, bitrate: c.bitrate, opus: { format: 'opus', signal: 'voice', frameDuration: 20000 } };
  }

  /** Prima configurazione Opus supportata da questo browser, oppure null. */
  function chooseOpus() {
    if (typeof window.AudioEncoder !== 'function' || typeof window.AudioData !== 'function') return Promise.resolve(null);
    var i = 0;
    function next() {
      if (i >= OPUS_CONFIGS.length) return Promise.resolve(null);
      var c = OPUS_CONFIGS[i];
      i += 1;
      return AudioEncoder.isConfigSupported(opusConfig(c)).then(function (r) { return r && r.supported ? c : next(); }, next);
    }
    return next();
  }

  /**
   * Codificatore di una registrazione. options.onPage({ bytes, granule, seq, serial, header }) riceve ogni
   * pagina Ogg pronta (prima le due pagine d'intestazione); options.onError(errore).
   * options.resume = { serial, seq, granule }: continua un flusso già iniziato (dopo un'interruzione o una
   * pagina ricaricata) senza nuove intestazioni: lo stesso file prosegue.
   * encode(Float32Array) con campioni alla frequenza scelta; finish() → promessa (pagina di fine flusso);
   * pause() → promessa: tutto l'audio ricevuto finisce in pagine, il flusso resta aperto.
   */
  function MotoreOpus(config, options) {
    this.config = config;
    this.options = options;
    var r = options.resume;
    this.serial = r ? r.serial >>> 0 : (Math.random() * 4294967295) >>> 0;
    this.seq = r ? r.seq : 0;
    this.granule = r ? r.granule : 0; // campioni a 48 kHz dei pacchetti già prodotti
    this.pending = [];
    this.pendingSamples = 0;
    this.headerSent = Boolean(r);
    this.samplesFed = 0;
    this.closed = false;
    var self = this;
    this.encoder = new AudioEncoder({
      output: function (chunk, meta) { self._packet(chunk, meta); },
      error: function (e) { if (options.onError) options.onError(e); },
    });
    this.encoder.configure(opusConfig(config));
  }

  MotoreOpus.prototype._emit = function (bytes, header) {
    var page = { bytes: bytes, granule: this.granule, seq: this.seq - 1, serial: this.serial, header: header };
    this.options.onPage(page);
  };

  MotoreOpus.prototype._header = function (meta) {
    var desc = meta && meta.decoderConfig && meta.decoderConfig.description;
    var head = null;
    if (desc) {
      var d = desc instanceof ArrayBuffer ? new Uint8Array(desc) : new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
      if (d.length >= 19 && String.fromCharCode.apply(null, d.subarray(0, 8)) === 'OpusHead') head = new Uint8Array(d);
    }
    if (!head) head = opusHead(312, this.config.sampleRate); // 312 = ritardo standard del codificatore a 48 kHz
    this.seq += 1;
    this._emit(oggPage(2, 0, this.serial, this.seq - 1, [head]), true);
    this.seq += 1;
    this._emit(oggPage(0, 0, this.serial, this.seq - 1, [opusTags()]), true);
    this.headerSent = true;
  };

  MotoreOpus.prototype._packet = function (chunk, meta) {
    if (!this.headerSent) this._header(meta);
    var bytes = new Uint8Array(chunk.byteLength);
    chunk.copyTo(bytes);
    this.pending.push(bytes);
    var samples = Math.round((chunk.duration || 20000) * 0.048); // µs → campioni a 48 kHz
    this.granule += samples;
    this.pendingSamples += samples;
    // Una pagina ogni secondo di audio (50 pacchetti da 20 ms): pagine piccole, invio continuo.
    if (this.pendingSamples >= 48000 || this.pending.length >= 200) this._flushPage(0);
  };

  MotoreOpus.prototype._flushPage = function (flags) {
    if (!this.pending.length && !(flags & 4)) return;
    if (!this.headerSent) this._header(null);
    this.seq += 1;
    var page = oggPage(flags, this.granule, this.serial, this.seq - 1, this.pending);
    this.pending = [];
    this.pendingSamples = 0;
    this._emit(page, false);
  };

  MotoreOpus.prototype.encode = function (samples) {
    if (this.closed || !samples.length) return;
    var data = new AudioData({
      format: 'f32', sampleRate: this.config.sampleRate, numberOfFrames: samples.length, numberOfChannels: 1,
      timestamp: Math.round((this.samplesFed / this.config.sampleRate) * 1e6), data: samples,
    });
    this.encoder.encode(data);
    data.close();
    this.samplesFed += samples.length;
  };

  /** Fine della registrazione: tutti i pacchetti in sospeso, poi la pagina di fine flusso. */
  MotoreOpus.prototype.finish = function () {
    var self = this;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return this.encoder.flush().catch(function () {}).then(function () {
      self._flushPage(4);
      try { self.encoder.close(); } catch (e) { /* già chiuso */ }
    });
  };

  /**
   * Pausa (microfono interrotto, pagina in chiusura): i pacchetti in sospeso finiscono in una pagina, il
   * flusso resta aperto e può continuare con un nuovo MotoreOpus({ resume }).
   */
  MotoreOpus.prototype.pause = function () {
    var self = this;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return this.encoder.flush().catch(function () {}).then(function () {
      self._flushPage(0);
      try { self.encoder.close(); } catch (e) { /* già chiuso */ }
    });
  };

  MotoreOpus.prototype.seconds = function () {
    return this.samplesFed / this.config.sampleRate;
  };

  // ─── Ripiego: registratore integrato del browser ───────────────────────────

  var RECORDER_TYPES = [
    ['audio/mp4;codecs=mp4a.40.2', 'm4a'],
    ['audio/mp4', 'm4a'],
    ['audio/ogg;codecs=opus', 'ogg'],
    ['audio/webm;codecs=opus', 'webm'],
  ];

  function chooseRecorder() {
    if (typeof window.MediaRecorder !== 'function') return null;
    for (var i = 0; i < RECORDER_TYPES.length; i += 1) {
      if (MediaRecorder.isTypeSupported(RECORDER_TYPES[i][0])) return { mimeType: RECORDER_TYPES[i][0], format: RECORDER_TYPES[i][1] };
    }
    return null;
  }

  /** options.onChunk(Uint8Array) riceve i blocchi (ogni 2 s); stop() → promessa dopo l'ultimo blocco. */
  function MotoreMediaRecorder(stream, choice, options) {
    var self = this;
    this.choice = choice;
    this.startedAt = Date.now();
    this.queue = Promise.resolve();
    this.recorder = new MediaRecorder(stream, { mimeType: choice.mimeType, audioBitsPerSecond: 48000 });
    this.recorder.ondataavailable = function (e) {
      if (!e.data || !e.data.size) return;
      self.queue = self.queue.then(function () { return e.data.arrayBuffer(); }).then(function (buf) { options.onChunk(new Uint8Array(buf)); });
    };
    this.stopped = new Promise(function (resolve) { self.recorder.onstop = function () { self.queue.then(resolve); }; });
    this.recorder.start(2000);
  }

  MotoreMediaRecorder.prototype.stop = function () {
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    return this.stopped;
  };

  /**
   * Pagina di fine flusso per un file rimasto aperto (pagina ricaricata, "Termina qui", codificatore
   * fermato da un errore): contiene 20 ms di silenzio Opus (pacchetto CELT a banda piena, 3 byte), così
   * il file termina in modo regolare.
   */
  function eosPage(serial, seq, granule) {
    return oggPage(4, granule + 960, serial, seq, [new Uint8Array([0xf8, 0xff, 0xfe])]);
  }

  window.MotoreAudio = {
    chooseOpus: chooseOpus,
    chooseRecorder: chooseRecorder,
    MotoreOpus: MotoreOpus,
    MotoreMediaRecorder: MotoreMediaRecorder,
    oggPage: oggPage,
    rewritePage: rewritePage,
    eosPage: eosPage,
    crc32: crc32,
  };
})();
