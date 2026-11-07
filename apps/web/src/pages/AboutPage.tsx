import type { VersionInfo } from "@kamino/protocol";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchVersion } from "../api/client.js";

type State = { status: "loading" } | { status: "error" } | { status: "ready"; info: VersionInfo };

export function AboutPage() {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    fetchVersion(ctrl.signal).then(
      (info) => setState({ status: "ready", info }),
      () => {
        if (!ctrl.signal.aborted) setState({ status: "error" });
      },
    );
    return () => ctrl.abort();
  }, []);

  return (
    <section className="mx-auto max-w-md space-y-4 p-6">
      <h1 className="text-2xl font-semibold">{t("about.title")}</h1>
      {state.status === "loading" && <p>{t("about.loading")}</p>}
      {state.status === "error" && <p role="alert">{t("about.error")}</p>}
      {state.status === "ready" && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          <dt className="font-medium">{t("about.version")}</dt>
          <dd>{state.info.version}</dd>
          <dt className="font-medium">{t("about.codename")}</dt>
          <dd>{state.info.codename}</dd>
          <dt className="font-medium">{t("about.protocol")}</dt>
          <dd>
            {state.info.protocol.min}-{state.info.protocol.max}
          </dd>
          <dt className="font-medium">{t("about.commit")}</dt>
          <dd>{state.info.commit}</dd>
        </dl>
      )}
    </section>
  );
}
