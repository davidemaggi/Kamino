import type { ReactNode } from "react";
import { BrandMark } from "../../app/BrandMark.js";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { LanguageSwitch } from "../../components/LanguageSwitch.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";

/** Centered layout for the public pages (spec §8.1). */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  useDocumentTitle(title);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      <BrandMark size={36} className="text-xl" />
      <Card className="w-full max-w-sm">
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

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? (
    <p role="alert" className="text-destructive text-sm">
      {children}
    </p>
  ) : null;
}
