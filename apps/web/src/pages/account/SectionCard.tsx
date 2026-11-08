import type { ReactNode } from "react";

export function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bg-card space-y-4 rounded-xl border p-5">
      <h2 className="font-serif text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}
