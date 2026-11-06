# ADR-0014 — Storico configurabile e cestino obbligatorio

**Stato:** Accettata (2026-11-06)

## Contesto
Il committente ha perso un vault per un fallimento silenzioso: la promessa centrale è "non perdi mai niente". Inizialmente aveva proposto storico da 0 a 90 giorni con default 0; con storico 0 una cancellazione accidentale si propaga ovunque e non è recuperabile.

## Decisione
- **Cestino di sicurezza obbligatorio di 7 giorni** per file cancellati e versioni sovrascritte, sempre attivo.
- **Storico** configurabile per vault da 0 a 90 giorni, **default 30**; l'admin fissa il massimo di sistema.
- Tutto conta nella quota; la web app mostra quanto occupa lo storico.
- Le versioni coinvolte in conflitti aperti sono conservate finché il conflitto è aperto.

## Conseguenze
- Lo ZIP "alla data X" è possibile entro la finestra di storico (o di cestino).
- La GC dei blob deve considerare retention, cestino e conflitti aperti.
