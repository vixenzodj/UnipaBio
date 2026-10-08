/*
 * worklet.js — elaborazione audio del registratore (AudioWorklet, fuori dal thread della pagina).
 *
 * Microfono (di solito 44.100 o 48.000 Hz) → 22.050 Hz, mono, 16 bit: lo stesso formato del
 * registratore di sempre. Prima del ricampionamento un filtro passa-basso di 6° ordine (Butterworth,
 * 9,8 kHz) toglie le frequenze che a 22.050 Hz diventerebbero distorsione; poi l'interpolazione
 * lineare calcola i campioni ai nuovi istanti. Alla pagina arrivano blocchi da 1 secondo e, ogni
 * 100 ms, il livello del segnale per l'indicatore.
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
  constructor() {
    super();
    this.target = 22050;
    this.ratio = sampleRate / this.target; // campioni in ingresso per ogni campione in uscita
    this.pos = 0; // posizione (in campioni d'ingresso, rispetto al blocco attuale) del prossimo campione in uscita
    this.prev = 0;
    // Butterworth di 6° ordine a 9,8 kHz (tre biquad in cascata): la voce passa intatta, sopra gli
    // 11 kHz (limite dei 22.050 Hz) quasi niente arriva al ricampionamento.
    this.filters = sampleRate > this.target * 1.02
      ? [lowpass(sampleRate, 9800, 0.5176), lowpass(sampleRate, 9800, 0.7071), lowpass(sampleRate, 9800, 1.9319)]
      : [];
    this.tmp = new Float32Array(128);
    this.out = new Int16Array(this.target);
    this.n = 0;
    this.sq = 0;
    this.sqCount = 0;
    this.running = true;
    this.port.onmessage = (event) => {
      if (event.data === 'flush' || event.data === 'stop') {
        this.flush(true);
        if (event.data === 'stop') this.running = false;
      }
    };
    this.port.postMessage({ type: 'ready', inputRate: sampleRate });
  }

  flush(requested) {
    const pcm = this.out.slice(0, this.n);
    this.port.postMessage({ type: 'pcm', pcm: pcm.buffer, flushed: Boolean(requested) }, [pcm.buffer]);
    this.n = 0;
  }

  push(value) {
    const v = value > 1 ? 1 : value < -1 ? -1 : value;
    const s = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
    this.out[this.n] = s;
    this.n += 1;
    this.sq += v * v;
    this.sqCount += 1;
    if (this.sqCount >= 2205) {
      this.port.postMessage({ type: 'level', rms: Math.sqrt(this.sq / this.sqCount) });
      this.sq = 0;
      this.sqCount = 0;
    }
    if (this.n === this.out.length) {
      const full = this.out;
      this.port.postMessage({ type: 'pcm', pcm: full.buffer }, [full.buffer]);
      this.out = new Int16Array(this.target);
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
