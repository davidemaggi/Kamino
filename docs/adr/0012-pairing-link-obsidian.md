# ADR-0012 — Pairing tramite link `obsidian://` con approvazione

**Stato:** Accettata (2026-11-06)

## Contesto
Collegare un nuovo dispositivo deve essere banale (un collega non deve chiedere aiuto) e sicuro contro link intercettati.

## Decisione
- QR e magic link sono **lo stesso link** `obsidian://kamino?server=...&token=...`, gestito con `registerObsidianProtocolHandler`. Il QR si legge con la fotocamera di sistema, che apre Obsidian.
- Token monouso, 10 minuti, salvato come hash.
- Il nuovo dispositivo riceve un **codice di verifica** di 4 caratteri; l'origine (dispositivo o web) approva solo se il codice coincide. Senza approvazione il dispositivo non riceve nulla.

## Alternative
- **Scanner QR dentro il plugin**: Obsidian non espone la fotocamera ai plugin; servirebbe una UI di upload foto. Più attrito.
- **Token senza approvazione**: più rapido, ma chi intercetta il link entro la scadenza collega il proprio dispositivo.

## Conseguenze
- Il link viene consegnato al vault aperto in Obsidian: sul nuovo dispositivo serve prima un vault (idealmente vuoto) con il plugin installato. Il plugin guida l'utente.
- Il nome `kamino` nell'URI deriva da `brand` e cambia con il nome pubblico.
