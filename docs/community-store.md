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
| la descrizione nella voce coincide con quella del manifest | sì (`write-manifest.ts`) |
| README che dichiara account esterni e uso della rete | sezione "Install the plugin" del README: serve un server Kamino e un account, nessuna telemetria |
| licenza nel repository | AGPL-3.0 |
| niente `innerHTML`, stili inline, scorciatoie predefinite, `console.log` | verificato a mano il 2026-11-14 |

## Procedura

1. Fork di [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases).
2. In fondo a `community-plugins.json` aggiungere:

   ```json
   {
     "id": "kamino-sync",
     "name": "Kamino",
     "author": "Davide Maggi",
     "description": "Self-hosted sync for your vaults across desktop and mobile.",
     "repo": "davidemaggi/Kamino"
   }
   ```

3. Aprire la PR con il template "Community Plugin" e spuntare la checklist. Titolo: `Add plugin: Kamino`.
4. Un bot controlla subito manifest, release e voce; poi arriva la revisione del codice (di solito settimane). Le correzioni richieste si pubblicano con una nuova release, poi si commenta nella PR.

## Testo per la PR

> Kamino is a self-hosted sync system for Obsidian vaults. This plugin syncs a vault with a Kamino server the user runs (Docker image `ghcr.io/davidemaggi/kamino`), on desktop and mobile. It needs an account on that server and talks only to it: no telemetry, no third-party services.
>
> Notes for the review:
> - `vault.adapter` is used on purpose: sync must read and write files the Vault API doesn't index (the configuration folder, when the user opts in, and the plugin's own state with atomic writes).
> - `fetch` is used only on local resource URLs, to stream large local files while hashing them; network calls use `requestUrl` and a WebSocket.

## Dopo l'approvazione

- Togliere BRAT dal README e da self-hosting §8 (lasciarlo come alternativa per le release candidate).
- Il nome resta modificabile (`name` nel manifest); l'`id` no, perché è il nome della cartella del plugin in ogni vault.
