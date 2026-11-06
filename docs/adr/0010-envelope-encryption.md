# ADR-0010 — Envelope encryption a riposo, non end-to-end

**Stato:** Accettata (2026-11-06)

## Contesto
L'admin non deve vedere contenuti né struttura dei vault; un dump di DB o storage deve essere inutile. È accettato che chi gestisce l'host con la master key possa decifrare. Il server deve poter leggere i contenuti per la web app (diff, ZIP, storico) e per il merge futuro.

## Decisione
- **KEK** (master key) fornita via Docker secret o env, mai nel DB né nei backup; il server non parte senza di essa o con quella sbagliata.
- **DEK casuale per vault**, cifrata con la KEK; sottochiavi derivate con HKDF per contenuti, metadati, HMAC dei path e ID dei blob.
- Contenuti cifrati con AEAD a segmenti (AES-256-GCM, schema STREAM); path, nomi e impostazioni cifrati con AES-256-GCM; ID dei blob e chiavi di unicità come HMAC keyed per vault.
- Rotazione della KEK tramite re-wrap delle DEK; crypto-shredding alla cancellazione.
- Dettagli in [04](../04-security-threat-model.md) §5.

## Alternative
- **E2EE**: protegge anche dall'host, ma impedisce diff/ZIP/storico lato web e il merge lato server, e rende complessi il pairing e il recupero. Escluso dal committente.
- **Cifratura del disco/volume**: non protegge dai dump logici del DB né dai backup.
- **Content addressing con SHA-256 in chiaro**: rivelerebbe l'uguaglianza di contenuti tra vault e utenti diversi.

## Conseguenze
- La perdita della KEK rende irrecuperabili i dati sul server: documentazione dedicata e ricostruzione dai dispositivi.
- Le query non possono filtrare per path: tutte le ricerche per path passano dall'HMAC o dalla decifratura lato applicazione.
- La deduplicazione è solo dentro il vault.
