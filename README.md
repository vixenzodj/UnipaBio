# Lezioni UniPA · link in bio

Pagina del gruppo con i link ai materiali delle lezioni:

- **Cartella delle lezioni (Google Drive):** registrazioni per materia, dispense, riassunti e libri.
- **Orario delle lezioni:** il pulsante apre il Google Calendar delle lezioni incorporato (in italiano, ora di Roma;
  elenco giorno per giorno sul telefono, settimana sul computer). Vale per matricole pari e Storia O-Z.
- **Notebook NotebookLM:** Matematica Generale, Microeconomia (matricole pari), Storia Economica (cognomi O-Z).

Pagina pubblicata: <https://vixenzodj.github.io/UnipaBio/>

## Registratore delle lezioni

Il microfono in cima alla pagina apre <https://vixenzodj.github.io/UnipaBio/registra/>, il registratore per chi
registra la lezione dal telefono (serve il codice di accesso impostato nella dashboard di Unipa-bot). L'audio è
compresso sul telefono in Opus a 24 kbit/s (file Ogg, un'ora ≈ 11 MB; sui browser senza WebCodecs il
registratore integrato in m4a), salvato prima sul telefono e inviato circa ogni 10 secondi all'ingresso del
registratore di Unipa-bot (Google Apps Script), con richieste che si adattano alla rete. Quando la pagina
mostra "Salvata nel cloud" il file è su Dropbox, con la stessa dimensione della copia sul telefono, che resta
scaricabile; la sincronizzazione lo porta su Drive, nella cartella della lezione del calendario, entro circa un
minuto. Registra un solo telefono alla volta.

Durante la registrazione "Metti in pausa" spegne il microfono per la pausa della lezione (il registratore resta di
chi registra fino a 45 minuti) e "Riprendi" continua lo stesso file. "Gestisci", nella scheda delle copie, apre
l'elenco delle registrazioni sul telefono: quelle già nel cloud si possono selezionare ed eliminare dal telefono.

Toccando una registrazione dell'elenco (il titolo o ▶) si apre il riproduttore: titolo della lezione, data e durata,
avvio e pausa, indietro e avanti di 15 secondi, barra di avanzamento; il titolo compare anche nella notifica del
telefono. Suona la copia sul telefono (gli stessi byte di "Scarica", anche senza rete) e si chiude da solo quando
si inizia a registrare o se quella copia viene eliminata.

## Aggiungere una materia

In `index.html`, sezione "Notebook delle materie", copia una scheda (`<a class="card" …>`), poi cambia il link
del notebook, il nome della materia e il colore dell'icona (`icon--mate`, `icon--micro`, `icon--storia` o un
nuovo colore definito nello stile). Aggiorna anche il numero di materie in alto e, se vuoi, l'immagine
`anteprima.jpg` mostrata nelle anteprime di WhatsApp.

## File

| File | Contenuto |
| --- | --- |
| `index.html` | La pagina, con stile e script inclusi; nessun servizio di tracciamento. |
| `anteprima.jpg` | Immagine 1200×630 per l'anteprima del link (WhatsApp, Telegram, social). |
| `icona.svg`, `icona-180.png` | Icona della scheda del browser e della schermata Home del telefono. |
| `registra/index.html` | Pagina del registratore (schermate: accesso, pronto, in registrazione, occupato, interrotta, salvata; copie sul telefono; riproduttore). |
| `registra/app.js` | Registrazione, salvataggio sul telefono (IndexedDB), invio adattivo per posizione in byte, segnale di vita, copie scaricabili e ascoltabili, blocco, schermo sempre acceso; invia anche l'audio rimasto dalla versione WAV precedente. |
| `registra/motore.js` | Codifica Opus (WebCodecs) e file Ogg costruito pagina per pagina (RFC 3533 e 7845); ripiego con il registratore del browser. |
| `registra/worklet.js` | Conversione del microfono in 24.000 Hz con filtro anti-distorsione (AudioWorklet). |
| `registra/manifest.webmanifest` | Nome e icona per aggiungere il registratore alla schermata Home. |
