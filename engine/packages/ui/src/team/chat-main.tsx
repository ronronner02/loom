import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TeamOwnerRead } from "@multi-agent/daemon/team-control";
import { Composer, LeadConversation, type PendingAttachment } from "./chat-panel.js";
import type { ChatState } from "./clients.js";
import type { TeamSummary } from "./hooks.js";
import { useState } from "react";

/** The Chat destination: the lead conversation, or the first-run welcome when a project has no run. */
export function ChatMainScreen({ read, runId, chat, connectionError, project, onStarted, onChanged, onOpenDocuments, onOpenOverview }: {
  read?: TeamOwnerRead; runId: string; chat?: ChatState; connectionError?: boolean;
  project?: TeamSummary; onStarted: (runId: string) => void; onChanged: () => void;
  onOpenDocuments: () => void; onOpenOverview: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const examples = [t("chat.examplePlan"), t("chat.exampleFix"), t("chat.exampleSummary")];

  if (!runId && project) {
    return <div className="ui-chat-main">
      <div className="ui-chat-welcome">
        <h1>{t("chat.welcomeTitle")}</h1>
        <div className="ui-example-prompts">
          {examples.map(prompt => (
            <button key={prompt} type="button" className="ui-example-prompt" onClick={() => setDraft(prompt)}>
              {prompt}
            </button>
          ))}
        </div>
      </div>
      <Composer runId="" entityVersion={0} body={draft} onBodyChange={setDraft} projectId={project.id} attachments={attachments} onAttachmentsChange={setAttachments} onStarted={onStarted} />
    </div>;
  }

  return <div className="ui-chat-main">
    <LeadConversation
      read={read}
      runId={runId}
      chat={chat}
      connectionError={connectionError}
      draft={draft}
      onDraftChange={setDraft}
      attachments={attachments}
      onAttachmentsChange={setAttachments}
      onChanged={onChanged}
      welcome={chat?.available && chat.messages.length === 0 && !chat.liveTurn ? (
        <div className="ui-chat-welcome">
          <h1>{read?.run.displayName || t("nav.chat")}</h1>
        </div>
      ) : undefined}
      documentTools={chat?.documentWorkflow && <div className="ui-chat-documents">
        <button type="button" className="btn btn-outline" onClick={onOpenDocuments}>
          <FileText aria-hidden="true" />
          {t("documents.open")}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onOpenOverview}>
          {t("nav.overview")}
        </button>
      </div>}
    />
  </div>;
}