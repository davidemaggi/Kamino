import type { ReactNode } from "react";
import { BrandMark } from "../../app/BrandMark.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { LanguageSwitch } from "../../components/LanguageSwitch.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";

/** Centered layout for the public pages (spec §8.1). */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  useDocumentTitle(title);
  return (
    <main className="brand-backdrop flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      <BrandMark size={72} stacked className="text-2xl" />
      <Card className="w-full max-w-sm shadow-[0_16px_40px_-12px_rgb(0_0_0/0.35)]">
        <CardHeader>
          <CardTitle>
            <h1>{title}</h1>
          </CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
      <LanguageSwitch />
    </main>
  );
}

export function ErrorText({ children, id }: { children: ReactNode; id?: string }) {
  return children ? (
    <p id={id} role="alert" className="text-destructive text-sm">
      {children}
    </p>
  ) : null;
}
