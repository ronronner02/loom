import { FileText, LayoutDashboard, ListTodo, MessageSquare, Users } from "lucide-react";
import type { MessageKey } from "@multi-agent/i18n";

export const TEAM_SECTIONS = ["chat", "overview", "tasks", "workspace", "documents"] as const;
export type TeamSection = (typeof TEAM_SECTIONS)[number];

/** Old section routes keep working and land on the screen that now hosts them. */
const LEGACY_SECTIONS: Readonly<Record<string, TeamSection>> = {
  agents: "workspace",
  logs: "workspace",
  knowledge: "workspace",
  decisions: "workspace",
  reviews: "workspace",
  inbox: "workspace",
  analytics: "overview",
  flow: "overview",
};

export function teamSection(pathname: string): TeamSection {
  const raw = pathname.split("/")[2] || "chat";
  return LEGACY_SECTIONS[raw] ?? (TEAM_SECTIONS.includes(raw as TeamSection) ? raw as TeamSection : "chat");
}

export const SECTION_LABELS: Record<TeamSection, MessageKey> = {
  chat: "nav.chat",
  overview: "nav.overview",
  tasks: "nav.tasks",
  workspace: "nav.workspace",
  documents: "nav.documents",
};

export const NAV_ICONS = {
  chat: MessageSquare,
  overview: LayoutDashboard,
  tasks: ListTodo,
  workspace: Users,
  documents: FileText,
};