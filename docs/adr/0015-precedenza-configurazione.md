# ADR-0015 — Precedenza della configurazione: l'ambiente vince

**Stato:** Accettata (2026-11-06)

## Contesto
La configurazione di sistema (es. SMTP, registrazione, limiti) deve essere impostabile sia con variabili d'ambiente / Docker secret sia dall'interfaccia admin.

## Decisione
Ordine di precedenza: **env / secret → valore salvato da UI (DB) → default**. Un campo impostato da ambiente appare in UI come bloccato con l'indicazione "impostato dall'ambiente". Lo schema della configurazione è un unico schema zod da cui si generano validazione, documentazione delle variabili e metadati per la UI.

## Alternative
- **UI vince sull'ambiente**: sorprende chi gestisce il deploy (il file compose non descrive più il comportamento).
- **Solo ambiente**: niente test SMTP e configurazione comoda dalla UI, che il committente vuole.

## Conseguenze
- Alcuni valori sono **solo da ambiente** per sicurezza o perché servono prima del DB: master key, URL del database, URL pubblico, porta.
