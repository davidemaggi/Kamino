# ADR-0017 — HTTP per le scritture, WebSocket per il push

**Stato:** Accettata (2026-11-06)

## Contesto
Il sync richiede scritture affidabili e idempotenti, upload binari riprendibili e consegna in tempo reale. Su mobile il WebSocket cade spesso (background, cambi di rete); in modalità Periodica non deve esserci connessione permanente.

## Decisione
- **REST** per commit, upload, risoluzioni e pairing: semantica richiesta/risposta chiara, retry semplici, `Range`, rate limiting standard.
- **WebSocket** per il push delle voci di journal, heartbeat ed eventi. Il primo messaggio porta il token (non nell'URL).
- Tutto ciò che passa dal WebSocket è recuperabile anche via REST (`GET /changes`): il WebSocket è un'ottimizzazione di latenza, mai l'unica via.

## Alternative
- **Tutto su WebSocket**: meno connessioni, ma retry, backpressure e upload binari diventano protocollo custom.
- **Server-Sent Events** per il push: più semplice, ma unidirezionale (servirebbe HTTP per `ack` e `status`) e supporto meno uniforme nelle WebView mobili.
- **Solo polling**: semplice ma non realtime.

## Conseguenze
- Due canali da testare; il comportamento "WS giù → polling/catch-up" deve essere coperto dai test multi-client.
