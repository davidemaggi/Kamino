# Nomi delle release

## Regole

- Ogni versione **MAJOR** e **MINOR** ha un nome in codice preso da un clone famoso (fantascienza, fumetti, cinema, videogiochi, o reale).
- L'**iniziale** corrisponde alla MAJOR: `1.x` → A, `2.x` → B, `3.x` → C, e così via.
- Un cambio di **MINOR** mantiene la lettera e cambia nome. Un cambio di **PATCH** non cambia nome.
- **Eccezione:** tutte le `0.x.y` e la `1.0.y` si chiamano **Ash** (saga di Alien).
- La regola standard parte da `1.1.0` (prima "A"); `2.0.0` passa a B.
- **Un nome non si riusa mai.**
- Il nome compare nel titolo della release, nel CHANGELOG, nella pagina "Informazioni" della web app, nelle impostazioni del plugin e nell'endpoint `/version`. I tag Docker restano numerici.

**Fonte di verità macchina:** `release-names.json` alla radice del repo (da creare in M0). Questo documento ne è la versione leggibile. La CI fallisce se una versione MAJOR/MINOR non ha un nome, se la lettera non corrisponde alla MAJOR o se un nome compare due volte. *(scelta del tech lead)*

## Registro

| Versione | Nome in codice | Data | Note |
|---|---|---|---|
| 0.x.y | Ash | — | pre-release |
| 1.0.y | Ash | — | prima release stabile |

## Candidati (da verificare prima dell'uso)

Riferimenti da controllare uno per uno quando il nome viene assegnato. ✓ = noto con buona sicurezza, ? = da verificare.

| Lettera | Candidati |
|---|---|
| A | Alison (Orphan Black) ✓, Appo (Star Wars) ✓, Alpha-17 (Star Wars) ✓ |
| B | Boba (Star Wars) ✓, Bly (Star Wars) ✓, Bacara (Star Wars) ✓, Beth (Orphan Black) ✓ |
| C | Cody (Star Wars) ✓, Cosima (Orphan Black) ✓, Crosshair (Star Wars) ✓ |
| D | Dolly (pecora clonata, reale) ✓, Dogma (Star Wars) ✓, Duncan (ghola di Duncan Idaho, Dune) ? |
| E | Echo (Star Wars) ✓ |
| F | Fives (Star Wars) ✓, Fox (Star Wars) ✓ |
| G | Gregor (Star Wars) ✓, Gree (Star Wars) ✓ |
| H | Hunter (Star Wars) ✓, Helena (Orphan Black) ✓, Hardcase (Star Wars) ✓ |
| J | Jesse (Star Wars) ✓ |
| K | Kix (Star Wars) ✓ |
| L | Lincoln Six Echo (The Island) ✓ |
| M | Mewtwo (Pokémon) ✓ |
| N | Neyo (Star Wars) ✓ |
| O | Omega (Star Wars) ✓, Odd Ball (Star Wars) ✓ |
| P | Ponds (Star Wars) ✓ |
| R | Rex (Star Wars) ✓, Ripley 8 (Alien: la clonazione) ✓, Rachel (Orphan Black) ✓ |
| S | Sam Bell (Moon) ✓, Sarah (Orphan Black) ✓, Snuppy (cane clonato, reale) ✓ |
| T | Tech (Star Wars) ✓, Tup (Star Wars) ✓, Thire (Star Wars) ✓ |
| W | Wrecker (Star Wars) ✓, Wolffe (Star Wars) ✓ |
| X | X-23 (Marvel) ✓ |

Lettere senza candidati (I, Q, U, V, Y, Z): da completare quando serviranno — con una release MAJOR all'anno c'è tempo.
