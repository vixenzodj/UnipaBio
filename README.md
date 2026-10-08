# Lezioni UniPA · link in bio

Pagina del gruppo con i link ai materiali delle lezioni:

- **Cartella delle lezioni (Google Drive):** registrazioni per materia, dispense, riassunti e libri.
- **Notebook NotebookLM:** Matematica Generale, Microeconomia, Storia Economica.

Pagina pubblicata: <https://vixenzodj.github.io/UnipaBio/>

## Registratore delle lezioni

Il microfono in cima alla pagina apre <https://vixenzodj.github.io/UnipaBio/registra/>, il registratore per chi
registra la lezione dal telefono (serve il codice di accesso impostato nella dashboard di Unipa-bot). L'audio
(WAV mono, 22.050 Hz, 16 bit, come il registratore di sempre) viene salvato prima sul telefono e inviato a pezzi
da 10 secondi all'ingresso del registratore di Unipa-bot (Google Apps Script); a fine registrazione il file
arriva nella cartella Dropbox delle registrazioni e la sincronizzazione lo porta su Drive, nella cartella della
lezione del calendario. Registra un solo telefono alla volta.

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
| `registra/index.html` | Pagina del registratore (schermate: accesso, pronto, in registrazione, occupato, interrotta, inviata). |
| `registra/app.js` | Registrazione, salvataggio sul telefono (IndexedDB), invio a pezzi, blocco, schermo sempre acceso. |
| `registra/worklet.js` | Conversione del microfono in 22.050 Hz con filtro anti-distorsione (AudioWorklet). |
| `registra/manifest.webmanifest` | Nome e icona per aggiungere il registratore alla schermata Home. |
