# M7 — Hardening e prima release (spec leggera)

**Data:** 2026-11-13 · **Roadmap:** `docs/06-roadmap.md` §M7 · **Processo:** snello (solo le scelte vere al committente).

Tre PR, in quest'ordine.

## M7a — Sicurezza del server

| # | Cosa |
|---|---|
| A1 | Intestazioni di sicurezza su ogni risposta: `Content-Security-Policy` restrittiva per la web app (`default-src 'self'`, niente inline script, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `img-src 'self' data: blob:`, `connect-src 'self'` più `ws(s):` della stessa origine), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy` minima. HSTS solo se `KAMINO_PUBLIC_URL` è HTTPS. Le risposte API: `Cache-Control: no-store`. Senza dipendenze nuove (un hook `onSend`). |
| A2 | Rate limiting dove manca (04 §8 e T-13): device-login/pairing già coperti; aggiungere creazione di upload per dispositivo e le scritture della web app più costose (ZIP, ripristini, resolve-all). In memoria, istanza singola, come gli altri. |
| A3 | Matrice di autorizzazione: un test che enumera **tutte** le rotte registrate in Fastify e per ognuna verifica (a) senza credenziali → 401, (b) con credenziali di un altro utente sul vault altrui → 404, (c) admin senza bypass sui contenuti. Una rotta nuova senza voce nella matrice fa fallire il test. |
| A4 | `pnpm audit --prod --audit-level high` in CI; Dependabot per npm e GitHub Actions. |
| A5 | Revisione del threat model (04): stato di ogni T-xx con riferimento a dove è implementato, rischi residui aggiornati. |

## M7b — Chiavi e backup

| # | Cosa |
|---|---|
| B1 | `kamino keys rotate` come 04 §5.2: il server riparte con nuova chiave + `KAMINO_MASTER_KEY_PREVIOUS[_FILE]` e accetta entrambe; il comando fa il re-wrap di DEK e segreti di sistema a lotti, ripetibile e riprendibile, poi ritira la vecchia; audit. (Niente `--new-key-file`: con il server acceso sulla sola chiave vecchia i vault nuovi resterebbero sotto di essa.) |
| B2 | `kamino backup create <file>`: archivio con dump logico del DB e copia dello storage (blob già cifrati); la master key non c'è mai. **Scelta:** dump in Node con `COPY … TO STDOUT` tabella per tabella più la versione delle migrazioni, invece di `pg_dump`: nessun binario nell'immagine, nessun vincolo di versione, funziona uguale con storage `fs` e `s3`. |
| B3 | `kamino backup verify <file>`: ripristina in un database temporaneo, verifica che la KEK apra tutte le DEK e che un campione di blob si decifri e corrisponda al suo hash. |
| B4 | `kamino backup restore <file>`: solo su database vuoto (migrato alla stessa versione), poi lo storage. Ripristino provato in CI (test di integrazione: crea dati, backup, restore in un DB nuovo, il server legge tutto). |

## M7c — Prestazioni, documentazione, release

| # | Cosa |
|---|---|
| C1 | Prestazioni: test di carico con 10.000 file (primo collegamento, scansione senza cambiamenti, snapshot, una modifica) con soglie in CI larghe; i colli di bottiglia trovati si correggono. Batteria su mobile: con i test sui dispositivi (fine sviluppo). |
| C2 | `docs/self-hosting.md` completo: tre scenari di rete, custodia della master key, rotazione, backup e ripristino, retention dei backup (04 §7), aggiornamenti. |
| C3 | Distribuzione del plugin via BRAT: workflow di release che pubblica `main.js`, `manifest.json`, `styles.css` come asset di una GitHub Release, versione da changesets. |
| C4 | 1.0.0 "Ash": **solo con il via del committente** dopo i test sui dispositivi. La scelta del nome pubblico (02 §9) è del committente e serve prima dello store, non per BRAT. |

## Fuori da M7

Batteria e prove con persone vere (a fine sviluppo, dal committente); rotazione della DEK (04 §5.3).
