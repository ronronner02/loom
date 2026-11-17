import "./fonts.js";
import "./team.css";

/** The shell's page entry. Its composition lives in `entry.tsx`; the stylesheets load here once. */
export { TeamShell, Pairing, Entry, INTERFACE_LANGUAGE_KEY, type LanguagePreference } from "./entry.js";
export { ShellFrame } from "./shell-frame.js";
export { TEAM_SECTIONS, teamSection, type TeamSection } from "./sections.js";
export { showsNewWork, useTeamWorkspace } from "./workspace-data.js";
