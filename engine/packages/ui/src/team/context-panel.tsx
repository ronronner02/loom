import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { PomoAvatar } from "./pomo-avatar.js";
import { namedSeat } from "./display.js";
import type { TeamWorkspace } from "./workspace-data.js";
import type { TeamSection } from "./sections.js";

/** The on-demand right panel: coordinator status, what needs the owner, the fleet, and tasks. */
export function ContextPanel({ workspace, onClose, go }: {
  workspace: TeamWorkspace; onClose: () => void; go: (section: TeamSection) => void;
}) {
  const { t } = useTranslation();
  const { read, pendingDecisions, pendingQuestions, activeSeats, coordinator, avatarState } = workspace;
  const decisionText = (kind: string, body: string) =>
    kind === "plan" ? t("overview.planApproval") : kind === "resume" ? t("team.resume.action") : body;
  return <>
    <div className="ui-context-head">
      <div className="ui-context-identity">
        <span className="ui-context-avatar" aria-hidden="true">
          <PomoAvatar state={avatarState} />
        </span>
        <div>
          <strong>{t("shell.coordinator")}</strong>
          <div className="ui-status ui-context-status">
            <span className="ui-dot" data-state={["shell.active", "status.attempt.working", "status.attempt.started"].includes(coordinator) ? "ok" : "unknown"} aria-hidden="true" />
            <span>{t(coordinator)}</span>
          </div>
        </div>
      </div>
      <button type="button" className="ui-icon-button" aria-label={t("shell.closeContextPanel")} onClick={onClose}>
        <X aria-hidden="true" />
      </button>
    </div>
    <section className="ui-context-section">
      <h3>{t("shell.ownerDecisions")}</h3>
      {pendingDecisions.length + pendingQuestions.length > 0 && <ul className="ui-fleet-list">
        {pendingDecisions.map(decision => (
          <li key={decision.kind === "message" ? decision.message.id : decision.kind}>
            <span className="ui-dot" data-state="awaiting-decision" aria-hidden="true" />
            <span>{decision.kind === "message" ? decisionText(decision.kind, decision.message.body) : decisionText(decision.kind, "")}</span>
          </li>
        ))}
        {pendingQuestions.map(question => (
          <li key={question.taskId}>
            <span className="ui-dot" data-state="awaiting-decision" aria-hidden="true" />
            <span>{question.title}</span>
          </li>
        ))}
      </ul>}
    </section>
    <section className="ui-context-section">
      <h3>{t("overview.fleet")}</h3>
      {activeSeats.length > 0 && <ul className="ui-fleet-list">
        {activeSeats.map(seat => (
          <li key={seat.seat}>
            <span className="ui-dot" data-state="ok" aria-hidden="true" />
            <strong>{namedSeat(seat, t)}</strong>
          </li>
        ))}
      </ul>}
    </section>
    {read && <section className="ui-context-section">
      <h3>{t("nav.tasks")}</h3>
      <p className="ui-muted ui-count-line">{t("tasks.count", { count: read.tasks.length })}</p>
      <button type="button" className="btn btn-outline" onClick={() => go("tasks")}>
        {t("nav.tasks")}
      </button>
    </section>}
  </>;
}