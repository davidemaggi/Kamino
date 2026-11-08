import type { Me } from "@kamino/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../api/endpoints.js";
import { errorMessage } from "../../api/errors.js";
import { LanguageSwitch } from "../../components/LanguageSwitch.js";
import { TextField } from "../../components/TextField.js";
import { Button } from "../../components/ui/button.js";
import { useTheme } from "../../theme/ThemeProvider.js";
import { ThemeSwitcher } from "../../theme/ThemeSwitcher.js";
import { ErrorText } from "../auth/AuthCard.js";
import { SectionCard } from "./SectionCard.js";

export function ProfileSection({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const { theme } = useTheme();
  const qc = useQueryClient();
  const [email, setEmail] = useState(me.email);
  const save = useMutation({
    mutationFn: () =>
      api.updateProfile({ email, lang: i18n.language === "en" ? "en" : "it", theme }),
    onSuccess: (updated) => {
      qc.setQueryData(["me"], updated);
      toast(t("account.saved"));
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <SectionCard title={t("account.profile.title")}>
      <form onSubmit={submit} className="space-y-4">
        <TextField
          label={t("account.profile.email")}
          value={email}
          onChange={setEmail}
          type="email"
          autoComplete="email"
        />
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{t("account.profile.language")}</p>
          <LanguageSwitch />
        </div>
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{t("account.profile.theme")}</p>
          <ThemeSwitcher />
        </div>
        <ErrorText>{save.isError ? errorMessage(save.error, t) : null}</ErrorText>
        <Button type="submit" disabled={save.isPending}>
          {t("account.profile.save")}
        </Button>
      </form>
    </SectionCard>
  );
}
