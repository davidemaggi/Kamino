import { PRODUCT_NAME } from "@kamino/brand";

export const TEMPLATES = [
  "invite",
  "reset",
  "admin_reset",
  "pairing_link",
  "export_ready",
  "new_device",
  "smtp_test",
] as const;
export type Template = (typeof TEMPLATES)[number];
export type Locale = "it" | "en";
export interface Rendered {
  subject: string;
  text: string;
  html: string;
}

type Copy = { subject: string; lines: string[]; action?: string };
/** `{name}` placeholders; `{link}`, when present, becomes a button in the HTML version. */
const COPY: Record<Locale, Record<Template, Copy>> = {
  it: {
    invite: {
      subject: "Il tuo invito a {product}",
      lines: ["Ciao {username},", "sei stato invitato a usare {product}. Il link vale 7 giorni."],
      action: "Attiva l'account",
    },
    reset: {
      subject: "Reimposta la password di {product}",
      lines: [
        "Abbiamo ricevuto una richiesta per reimpostare la tua password. Il link vale 1 ora.",
        "Se non sei stato tu, ignora questo messaggio: la password resta quella di prima.",
      ],
      action: "Reimposta la password",
    },
    admin_reset: {
      subject: "Un amministratore ha avviato il ripristino del tuo account {product}",
      lines: [
        "Ciao {username},",
        "un amministratore ha creato un link per reimpostare la tua password. Se non te lo aspettavi, contatta chi gestisce il server.",
      ],
    },
    pairing_link: {
      subject: "Collega un dispositivo a {product}",
      lines: ["Apri questo link sul dispositivo da collegare. Il link vale 10 minuti."],
      action: "Collega il dispositivo",
    },
    export_ready: {
      subject: "La copia dei tuoi dati {product} è pronta",
      lines: [
        "La copia dei tuoi vault è pronta da scaricare fino al {expires}.",
        "Dopo quella data il link non funziona più e i dati vengono cancellati.",
      ],
      action: "Scarica la copia",
    },
    new_device: {
      subject: "Nuovo dispositivo collegato a {product}",
      lines: [
        "Il dispositivo «{device}» è stato collegato al tuo account.",
        "Se non sei stato tu, scollegalo dalla pagina Dispositivi e cambia la password.",
      ],
    },
    smtp_test: {
      subject: "Email di prova da {product}",
      lines: ["Se leggi questo messaggio, la configurazione email del server funziona."],
    },
  },
  en: {
    invite: {
      subject: "Your invitation to {product}",
      lines: [
        "Hi {username},",
        "you have been invited to use {product}. The link is valid for 7 days.",
      ],
      action: "Activate your account",
    },
    reset: {
      subject: "Reset your {product} password",
      lines: [
        "We received a request to reset your password. The link is valid for 1 hour.",
        "If it wasn't you, ignore this message: your password stays the same.",
      ],
      action: "Reset password",
    },
    admin_reset: {
      subject: "An administrator started a reset of your {product} account",
      lines: [
        "Hi {username},",
        "an administrator created a link to reset your password. If you weren't expecting it, contact whoever runs the server.",
      ],
    },
    pairing_link: {
      subject: "Link a device to {product}",
      lines: ["Open this link on the device you want to link. The link is valid for 10 minutes."],
      action: "Link the device",
    },
    export_ready: {
      subject: "Your {product} data copy is ready",
      lines: [
        "The copy of your vaults can be downloaded until {expires}.",
        "After that date the link stops working and the data is deleted.",
      ],
      action: "Download the copy",
    },
    new_device: {
      subject: "New device linked to {product}",
      lines: [
        "The device “{device}” was linked to your account.",
        "If it wasn't you, unlink it from the Devices page and change your password.",
      ],
    },
    smtp_test: {
      subject: "Test email from {product}",
      lines: ["If you can read this, the server's email settings work."],
    },
  },
};

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function fill(s: string, params: Record<string, string>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) =>
    k === "product" ? PRODUCT_NAME : (params[k] ?? m),
  );
}

export function render(t: Template, locale: Locale, params: Record<string, string>): Rendered {
  const c = COPY[locale][t];
  const subject = fill(c.subject, params);
  const lines = c.lines.map((l) => fill(l, params));
  const link = params["link"];
  const text = [
    ...lines,
    ...(link && c.action ? ["", `${c.action}: ${link}`] : []),
    "",
    PRODUCT_NAME,
  ].join("\n");
  const body = lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("");
  const button =
    link && c.action
      ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 16px;background:#1f6f78;color:#fff;border-radius:8px;text-decoration:none">${escapeHtml(c.action)}</a></p><p style="font-size:12px;color:#666">${escapeHtml(link)}</p>`
      : "";
  const html = `<!doctype html><html lang="${locale}"><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#222">${body}${button}<p style="color:#666">${escapeHtml(PRODUCT_NAME)}</p></body></html>`;
  return { subject, text, html };
}
