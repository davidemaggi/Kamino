# ADR-0016 — `@codemirror/merge` per diff e merge in web e plugin

**Stato:** Accettata (2026-11-06)

## Contesto
La risoluzione dei conflitti con diff side-by-side e merge manuale deve esistere sia nella web app sia nel plugin, con un'esperienza coerente.

## Decisione
Un pacchetto `packages/ui-diff` costruito su `@codemirror/merge` (CodeMirror 6). Obsidian usa CodeMirror 6: nel plugin `@codemirror/state` e `@codemirror/view` sono esterni (forniti da Obsidian), `@codemirror/merge` è incluso nel bundle.

## Alternative
- **Monaco diff editor**: pesante, non adatto al plugin mobile.
- **Librerie di diff testuale + rendering custom**: niente merge interattivo.

## Conseguenze
- Compatibilità di versione con il CodeMirror di Obsidian da verificare (spike R-3); fallback: vista a due pannelli in sola lettura nel plugin e merge manuale solo da web.
