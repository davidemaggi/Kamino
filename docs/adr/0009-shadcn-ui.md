# ADR-0009 — shadcn/ui + Tailwind per la web app

**Stato:** Accettata (2026-11-06)

## Contesto
Web app React + Vite con dashboard utente e admin, tema chiaro/scuro/sistema, i18n. Il committente vuole un design system curato, definito nella fase UI con UI/UX Pro Max e rifinito con impeccable.

## Decisione
shadcn/ui (componenti Radix copiati nel repo) + Tailwind CSS; token del design system come variabili CSS; TanStack Query per i dati; react-i18next.

## Alternative
- **Mantine**: componenti più completi già pronti (date, notifiche, form), dashboard funzionante prima; personalizzazione profonda del linguaggio visivo più costosa.

## Conseguenze
- Il codice dei componenti è nostro: massima libertà sul design, più lavoro per arrivare a una UI completa.
- Alcune parti vanno integrate a parte (tabelle con TanStack Table, form con react-hook-form + zod, toast con sonner).
