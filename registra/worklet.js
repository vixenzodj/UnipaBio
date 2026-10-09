/*
 * worklet.js — elaborazione audio del registratore (AudioWorklet, fuori dal thread della pagina).
 *
 * Microfono (di solito 44.100 o 48.000 Hz) → frequenza di destinazione, mono. Prima del ricampionamento
 * un filtro passa-basso di 6° ordine (Butterworth, al 44% della frequenza di destinazione) toglie le
 * frequenze che diventerebbero distorsione; poi l'interpolazione lineare calcola i campioni ai nuovi istanti.
 *
 *  - modalità "float" (registratore attuale): 24.000 Hz in virgola mobile, a blocchi da 0,5 s, per il
 *    codificatore Opus del telefono (WebCodecs);
 *  - modalità predefinita (versione precedente): 22.050 Hz, 16 bit, a blocchi da 1 s.
 * Ogni 100 ms arriva anche il livello del segnale per l'indicatore.
 */

function lowpass(fs, f0, q) {
  const w0 = (2 * Math.PI * f0) / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const b2 = (1 - cos) / 2 / a0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let z1 = 0;
  let z2 = 0;
  return (x) => {
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    return y;
  };
}

class Registratore extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.float = Boolean(o.float);
    this.target = o.targetRate || 22050;
    this.ratio = sampleRate / this.target; // campioni in ingresso per ogni campione in uscita
    this.pos = 0; // posizione (in campioni d'ingresso, rispetto al blocco attuale) del prossimo campione in uscita
    this.prev = 0;
    // Butterworth di 6° ordine (tre biquad in cascata) al 44% della frequenza di destinazione.
    const cutoff = this.target * 0.444;
    this.filters = sampleRate > this.target * 1.02
      ? [lowpass(sampleRate, cutoff, 0.5176), lowpass(sampleRate, cutoff, 0.7071), lowpass(sampleRate, cutoff, 1.9319)]
      : [];
    this.tmp = new Float32Array(128);
    this.blockLength = this.float ? Math.round(this.target / 2) : this.target;
    this.out = this.float ? new Float32Array(this.blockLength) : new Int16Array(this.blockLength);
    this.n = 0;
    this.sq = 0;
    this.sqCount = 0;
    this.levelEvery = Math.round(this.target / 10);
    this.running = true;
    this.port.onmessage = (event) => {
      if (event.data === 'flush' || event.data === 'stop') {
        this.flush(true);
        if (event.data === 'stop') this.running = false;
      }
    };
    this.port.postMessage({ type: 'ready', inputRate: sampleRate, targetRate: this.target, float: this.float });
  }

  flush(requested) {
    const part = this.out.slice(0, this.n);
    this.port.postMessage({ type: this.float ? 'f32' : 'pcm', pcm: part.buffer, flushed: Boolean(requested) }, [part.buffer]);
    this.n = 0;
  }

  push(value) {
    const v = value > 1 ? 1 : value < -1 ? -1 : value;
    if (this.float) this.out[this.n] = v;
    else this.out[this.n] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
    this.n += 1;
    this.sq += v * v;
    this.sqCount += 1;
    if (this.sqCount >= this.levelEvery) {
      this.port.postMessage({ type: 'level', rms: Math.sqrt(this.sq / this.sqCount) });
      this.sq = 0;
      this.sqCount = 0;
    }
    if (this.n === this.out.length) {
      const full = this.out;
      this.port.postMessage({ type: this.float ? 'f32' : 'pcm', pcm: full.buffer }, [full.buffer]);
      this.out = this.float ? new Float32Array(this.blockLength) : new Int16Array(this.blockLength);
      this.n = 0;
    }
  }

  process(inputs) {
    if (!this.running) return false;
    const input = inputs[0];
    if (!input || !input.length || !input[0] || !input[0].length) return true;
    const len = input[0].length;
    if (this.tmp.length !== len) this.tmp = new Float32Array(len);
    const x = this.tmp;
    for (let i = 0; i < len; i += 1) {
      let v = input[0][i];
      if (input.length > 1) {
        for (let c = 1; c < input.length; c += 1) v += input[c][i];
        v /= input.length;
      }
      for (let f = 0; f < this.filters.length; f += 1) v = this.filters[f](v);
      x[i] = v;
    }
    // Interpolazione lineare: x[-1] è l'ultimo campione del blocco precedente.
    while (Math.floor(this.pos) + 1 < len) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const s0 = i < 0 ? this.prev : x[i];
      const s1 = x[i + 1];
      this.push(s0 + (s1 - s0) * frac);
      this.pos += this.ratio;
    }
    this.pos -= len;
    this.prev = x[len - 1];
    return true;
  }
}

registerProcessor('registratore', Registratore);
