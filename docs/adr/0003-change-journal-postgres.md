# ADR-0003 — Journal delle modifiche in Postgres, nessun message broker

**Stato:** Accettata (2026-11-06)

## Contesto
Il sync deve consegnare le modifiche ai dispositivi connessi in tempo reale e a quelli offline alla riconnessione, anche dopo settimane. Il backend deve conoscere sempre lo stato di ogni dispositivo. Il deploy deve essere semplice per chi fa self-hosting.

## Decisione
Ogni vault ha un **journal append-only** in Postgres con sequenza monotona `seq`, assegnata nella stessa transazione che registra la modifica. Ogni dispositivo ha un **cursore** (ultimo `seq` applicato). La riconnessione è "dammi tutto dopo N". Il fan-out realtime usa `LISTEN/NOTIFY` di Postgres e le connessioni WebSocket in memoria.

## Alternative
- **RabbitMQ**: code per dispositivo. Duplica lo stato (il DB resta comunque la fonte di verità per storico e metadati), introduce il problema della doppia scrittura DB+broker e un container in più. Le code non sostituiscono il replay da una posizione arbitraria.
- **NATS JetStream / Kafka**: stream persistenti con replay da offset, concettualmente vicini al journal. Avrebbero senso con molte istanze e alti volumi; qui aggiungono infrastruttura senza vantaggi.
- **Redis pub/sub/streams**: un servizio in più; pub/sub non è durevole.

## Conseguenze
- Una sola fonte di verità; lo stato di sync di ogni dispositivo è `head − cursor`, sempre derivabile.
- Le scritture su uno stesso vault sono serializzate dal lock sulla riga del vault: accettabile (un utente, pochi dispositivi). Se diventasse un collo di bottiglia: sequenze per vault tramite tabella contatori o advisory lock.
- `LISTEN/NOTIFY` funziona anche con più istanze: non preclude la scalabilità orizzontale.
- Il journal va compattato (vedi [03](../03-sync-protocol.md) §6.3).
