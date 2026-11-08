import { PRODUCT_NAME } from "@kamino/brand";
import type { ReactNode } from "react";
import { useDocumentTitle } from "../../app/useDocumentTitle.js";
import { LanguageSwitch } from "../../components/LanguageSwitch.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";

/** Centered layout for the public pages (spec §8.1). */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  useDocumentTitle(title);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      <p className="font-serif text-xl font-semibold">{PRODUCT_NAME}</p>
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
