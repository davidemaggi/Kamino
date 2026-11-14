# Pubblicazione nello store della community di Obsidian

> Stato: pronta da inviare (2026-11-14). Nome pubblico confermato: **Kamino**, id `kamino-sync`, icona invariata.

Finché il plugin non è nello store si installa con BRAT ([self-hosting §8](self-hosting.md#8-installare-il-plugin-brat)). Una volta approvato lo si trova in Impostazioni → Plugin della community → Sfoglia, e gli aggiornamenti arrivano da soli a ogni release.

## Requisiti, e come li soddisfiamo

| Requisito di Obsidian | Da noi |
|---|---|
| `manifest.json` e `versions.json` nella **radice** del branch principale | copie di quelli del plugin, riscritte da `pnpm release:version` (`writeRootFiles` in `apps/plugin/scripts/release.ts`); un test di `apps/plugin/test/manifest.test.ts` fa fallire la CI se restano indietro |
| release GitHub con tag **uguale** alla versione del manifest (senza `v`), allegati `main.js`, `manifest.json`, `styles.css` | workflow **Release plugin** |
| la release non è una pre-release | da 1.0.0 in poi; le versioni con suffisso (`-rc.N`) restano pre-release e lo store le ignora |
| `id` senza "obsidian", minuscolo, unico | `kamino-sync` (test in `@kamino/brand`); nessun altro plugin usa "kamino" |
| `name` senza "Obsidian" e senza "Plugin" | `Kamino` |
| README che dichiara account esterni e uso della rete | sezione "Install the plugin" del README: serve un server Kamino e un account, nessuna telemetria |
| licenza nel repository | AGPL-3.0 |
| niente `innerHTML`, stili inline, scorciatoie predefinite, `console.log` | verificato a mano il 2026-11-14 |

## Procedura

Non si apre più una PR su `obsidianmd/obsidian-releases`: si invia dal portale [community.obsidian.md](https://community.obsidian.md) ([guida ufficiale](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)). Serve l'account Obsidian del committente, quindi questo passo lo fa lui.

1. Entrare in [community.obsidian.md](https://community.obsidian.md) con l'account Obsidian.
2. Collegare l'account GitHub al profilo: così il portale verifica che il repository `davidemaggi/Kamino` è del committente.
3. Aggiungere il plugin indicando il repository. Il portale legge il `manifest.json` in testa al branch principale (id, nome, descrizione) e la release con lo stesso tag.
4. La revisione automatica mostra nel portale cosa va corretto. Ogni correzione richiede una nuova release con versione incrementata. Finché ci sono errori il plugin non si installa da Obsidian.
5. Testo per la descrizione o per eventuali domande dei revisori:

   > Kamino is a self-hosted sync system for Obsidian vaults. This plugin syncs a vault with a Kamino server the user runs (Docker image `ghcr.io/davidemaggi/kamino`), on desktop and mobile. It needs an account on that server and talks only to it: no telemetry, no third-party services.
   >
   > - `vault.adapter` is used on purpose: sync must read and write files the Vault API doesn't index (the configuration folder, when the user opts in, and the plugin's own state with atomic writes).
   > - `fetch` is used only on local resource URLs, to stream large local files while hashing them; network calls use `requestUrl` and a WebSocket.

Il README compare in un estratto nella scheda pubblica: le immagini con percorso relativo (`docs/assets/screenshots/…`) vengono riscritte dal portale.

## Dopo l'approvazione

- Togliere BRAT dal README e da self-hosting §8 (lasciarlo come alternativa per le release candidate).
- Il nome resta modificabile (`name` nel manifest); l'`id` no, perché è il nome della cartella del plugin in ogni vault.
