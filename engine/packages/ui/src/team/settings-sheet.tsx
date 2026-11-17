import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { InterfaceI18n } from "@multi-agent/i18n";
import type { SettingsScreen } from "./settings.js";
import { SettingsScreen as Settings } from "./settings.js";
import type { useThemePreference } from "./theme.js";
import { Sheet } from "./sheet.js";

/** The settings modal: a centred dialog over the shell with the section navigation inside. */
export function SettingsSheet({ open, onOpenChange, language, onLanguage, appearance, props }: {
  open: boolean; onOpenChange: (open: boolean) => void;
  language: InterfaceI18n; onLanguage: (next: "zh-CN" | "en") => void;
  appearance: ReturnType<typeof useThemePreference>;
  props: Omit<Parameters<typeof SettingsScreen>[0], "language" | "onLanguage" | "appearance">;
}) {
  const { t } = useTranslation();
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Overlay className="ui-dialog-overlay" />
    <Dialog.Content className="ui-settings-modal" aria-describedby={undefined}>
      <header className="ui-panel-heading">
        <Dialog.Title>{t("settings.title")}</Dialog.Title>
        <Dialog.Close className="ui-icon-button" aria-label={t("shell.closeSettings")}><X aria-hidden="true" /></Dialog.Close>
      </header>
      <div className="ui-settings-modal-body">
        <Settings language={language} onLanguage={onLanguage} appearance={appearance} {...props} />
      </div>
    </Dialog.Content>
  </Dialog.Root>;
}