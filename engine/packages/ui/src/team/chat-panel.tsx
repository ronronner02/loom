import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_MESSAGE, type ProjectAttachment } from "../../../daemon/dist/contracts/team-control.js";
import { Paperclip } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, FileText, X } from "lucide-react";
import { TextPreview } from "./text-preview.js";
import type { TeamOwnerRead, WorkflowSelection } from "@multi-agent/daemon/team-control";
import { WorkflowOutcomes, WorkflowPicker } from "./workflows.js";
import { useOwnerSession } from "../hooks/useOwnerSession.js";
import { approvePlan, cancelRun, confirmDocument, postTaskComment, selectDocumentStage, sendChatMessage, type ChatMessage, type ChatState, type LiveLeadTurn } from "./clients.js";
import { documentDiscussionPending, DocumentStages } from "./documents.js";
import { mergeToolCalls } from "../hooks/useAttemptActivity.js";
import { useAttemptStatus } from "../hooks/useAttemptStatus.js";
import { usePendingAction } from "../hooks/usePendingAction.js";
import { ToolCalls } from "./workspace/workspace-view.js";
import { clockTime } from "./display.js";
import { isSendReady, messageIntent, type ConfirmationIntent, type StageIntent } from "./composer-model.js";

type OwnerDecision = { kind: "plan" } | { kind: "resume" } | { kind: "message"; message: ChatMessage };

/** The badge and the visible decision rows consume this same list. */
export function pendingOwnerDecisions(read: TeamOwnerRead | undefined, chat: ChatState | undefined): OwnerDecision[] {
  const decisions: OwnerDecision[] = [];
  if (read?.run.state === "canceled" || read?.run.state === "cancel_requested") return decisions;
  if (read?.run.phase === "planning" && (!chat?.documentWorkflow || chat.documentWorkflow.stage === "plan")) decisions.push({ kind: "plan" });
  if (read?.run.state === "blocked") decisions.push({ kind: "resume" });
  for (const message of chat?.available ? chat.messages : []) {
    if (message.kind === "decision" && !message.answeredBy) decisions.push({ kind: "message", message });
  }
  return decisions;
}

/** The questions workers asked the owner, worded as they wrote them. */
export function pendingWorkerQuestions(read: TeamOwnerRead | undefined): TeamOwnerRead["tasks"] {
  if (read?.run.state === "canceled" || read?.run.state === "cancel_requested") return [];
  return (read?.tasks ?? []).filter(task => task.stage === "owner/question" && task.workerReport?.question);
}

export interface PendingAttachment { id: string; file: File; uploaded?: ProjectAttachment }
interface AttachmentDraftProps {
  attachments: PendingAttachment[];
  onAttachmentsChange: (attachments: PendingAttachment[]) => void;
}

export function ChatPanel({ open, onOpenChange, opener, read, runId, chat, connectionError, draftContext, project, onStarted, onOpenDocuments, onChanged }: {
  open: boolean; onOpenChange: (open: boolean) => void; opener: RefObject<HTMLButtonElement | null>;
  read?: TeamOwnerRead; runId: string; chat?: ChatState; connectionError?: boolean; draftContext?: { body: string };
  project?: { id: string; name: string }; onStarted?: (runId: string) => void;
  onOpenDocuments?: () => void; onChanged?: () => void;
}) {
  const { t } = useTranslation();
  // The shell keeps this component mounted; closing its dialog or changing sections keeps the draft.
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  useEffect(() => {
    if (draftContext) setDraft(current => current ? current + "\n\n" + draftContext.body : draftContext.body);
  }, [draftContext]);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 859px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 859px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  // Desktop docks the panel beside the content (non-modal, so Radix renders no scrim); a phone
  // shows it modally.
  return <Dialog.Root open={open} onOpenChange={onOpenChange} modal={mobile}>
    <Dialog.Overlay className="ui-dialog-overlay" />
    <Dialog.Content className="ui-chat-panel" onInteractOutside={event => {
      if (!mobile) event.preventDefault();
    }} onCloseAutoFocus={event => {
      event.preventDefault(); opener.current?.focus();
    }}>
      <header className="ui-panel-heading">
        <div><div className="ui-chat-title"><Dialog.Title>{t("shell.leadChat")}</Dialog.Title>
          <span className="chip">{t(!runId || read?.run.phase === "planning" ? "planning.mode" : "execution.mode")}</span></div>
          <Dialog.Description><TextPreview text={read?.run.displayName || project?.name || t("shell.noRun")} /></Dialog.Description></div>
        {chat?.documentWorkflow && onOpenDocuments && <button type="button" className="ui-icon-button"
          aria-label={t("documents.open")} title={t("documents.open")} onClick={onOpenDocuments}><FileText aria-hidden="true" /></button>}
        <Dialog.Close className="ui-icon-button" aria-label={t("shell.closeChat")}><X aria-hidden="true" /></Dialog.Close>
      </header>
      {!runId && project ? <section className="chat" aria-label={t("team.chat.message")}>
        <div className="chat-log" />
        <Composer runId="" entityVersion={0} body={draft} onBodyChange={setDraft} projectId={project.id} attachments={attachments} onAttachmentsChange={setAttachments} onStarted={onStarted} />
      </section> : <LeadConversation read={read} runId={runId} chat={chat} connectionError={connectionError} draft={draft} onDraftChange={setDraft} onChanged={onChanged} attachments={attachments} onAttachmentsChange={setAttachments}
        documentTools={chat?.documentWorkflow && <div className="ui-chat-documents"><DocumentStages read={read} chat={chat} onChanged={onChanged} /></div>} />}
    </Dialog.Content>
  </Dialog.Root>;
}

/** Shared with the retained run page, including its existing approval and resume controls. */
export function LeadConversation({ read, runId, chat, connectionError, draft, onDraftChange, onChanged, documentTools, welcome, attachments, onAttachmentsChange }: {
  read?: TeamOwnerRead; runId: string; chat?: ChatState; connectionError?: boolean; draft: string; onDraftChange: (draft: string) => void; onChanged?: () => void;
  documentTools?: ReactNode; welcome?: ReactNode;
} & AttachmentDraftProps) {
  const { t } = useTranslation();
  const entityVersion = read?.run.entityVersion ?? 0;
  const pending = pendingOwnerDecisions(read, chat);
  const log = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const revision = [chat?.messages.at(-1)?.id, chat?.liveTurn?.attemptId, chat?.liveTurn?.progress?.sequence,
    chat?.liveTurn?.activity?.nextSeq].join(":");
  useEffect(() => {
    if (following && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [revision, following]);
  return <section className="chat" aria-label={t("team.chat.message")}>
    <div className="chat-log" ref={log} onScroll={event => {
      const element = event.currentTarget;
      setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 80);
    }}>
      {documentTools}
      {welcome}
      <WorkflowOutcomes runId={runId} />
      {chat?.available && chat.messages.filter(message => message.kind !== "decision" || message.answeredBy)
        .map(message => <Turn key={message.id} message={message} />)}
      {chat?.available && !!chat.activity?.length && <details className="ui-chat-tools ui-chat-activity">
        <summary>{t("chat.activity", { count: chat.activity.length })}</summary>
        {chat.activity.map(entry => <div key={entry.id} className="turn">
          <div className="turn-who">{t("role.lead")}<time className="ui-muted" dateTime={entry.createdAt}>{clockTime(entry.createdAt)}</time></div>
          <p className="turn-body ui-turn-body">{entry.body}</p>
        </div>)}
      </details>}
      {chat?.liveTurn && <LiveOutput key={chat.liveTurn.attemptId} runId={runId} turn={chat.liveTurn}
        createdAt={read?.attempts.find(attempt => attempt.attemptId === chat.liveTurn!.attemptId)?.createdAt ?? chat.liveTurn.activity?.startedAt}
        connectionError={connectionError} />}
      {connectionError && <p role="alert" className="ui-muted">{t("chat.liveInterrupted")}</p>}
      {pending.length > 0 && <section aria-label={t("shell.ownerDecisions")}>
        <h3 className="ui-attention-heading">{t("shell.ownerDecisions")}</h3>
        {pending.some(decision => decision.kind === "message") && <p className="ui-muted" role="status">{t("chat.questionWaiting")}</p>}
        <ul className="ui-decision-list">{pending.map(decision => <li key={decision.kind === "message" ? decision.message.id : decision.kind}>
          {decision.kind === "plan" ? <PlanPlate read={read} runId={runId} entityVersion={entityVersion} chat={chat} onChanged={onChanged} />
            : decision.kind === "resume" ? <ResumePlate read={read!} />
              : <DecisionPlate message={decision.message} runId={runId} entityVersion={entityVersion} onChanged={onChanged} />}
        </li>)}</ul>
      </section>}
      {read?.run.phase !== "planning" && <PlanPlate read={read} runId={runId} entityVersion={entityVersion} onChanged={onChanged} />}
      {chat && !chat.available && <p className="muted">{t("team.chat.unavailable")}</p>}
    </div>
    {!following && <button className="btn btn-outline ui-chat-latest" onClick={() => setFollowing(true)}>{t("chat.latest")}</button>}
    {chat?.available && <Composer runId={runId} entityVersion={entityVersion} body={draft} onBodyChange={onDraftChange} attachments={attachments} onAttachmentsChange={onAttachmentsChange} read={read} chat={chat} onChanged={onChanged} />}
  </section>;
}

function LiveOutput({ runId, turn, createdAt, connectionError }: { runId: string; turn: LiveLeadTurn; createdAt?: string; connectionError?: boolean }) {
  const { t } = useTranslation();
  const mountedAt = useRef(new Date().toISOString());
  const progress = turn.progress;
  // A live record set can carry one call's start and completion as two rows with the same id;
  // merging collapses them to the latest state so the panel counts the call once.
  const activity = turn.activity ? { ...turn.activity, records: mergeToolCalls([], turn.activity.records) } : undefined;
  const lifecycle = useAttemptStatus(runId, { attemptId: turn.attemptId, state: turn.state, createdAt: createdAt ?? mountedAt.current }, !!progress?.sequence);
  const state = turn.state === "running" ? progress?.status ?? lifecycle ?? "started" : progress?.status === "failed" ? "failed" : "stopped";
  const active = !connectionError && turn.state === "running" && !["completed", "failed", "stopped"].includes(state);
  return <section className="turn ui-chat-live" aria-label={t("chat.live")} aria-busy={active} data-attempt={turn.attemptId}>
    <div className="turn-who"><span>{t("role.lead")}</span>
      {!connectionError && <span className="ui-chat-status" role="status" data-active={active}>
        <span aria-hidden="true" />{t(state === "started" || state === "acknowledged" || state === "no-response" || state === "unknown"
          ? `status.attempt.${state}` : `chat.progress.${state}`)}</span>}
    </div>
    {progress?.blocks.filter(block => block.text).map(block => <p key={block.id} className="turn-body">{block.text}</p>)}
    {activity && <details className="ui-chat-tools"><summary>{t("chat.tools")}</summary><ToolCalls activity={activity} /></details>}
    {progress?.truncated && <p className="ui-muted">{t("chat.liveTruncated")}</p>}
  </section>;
}

function Turn({ message }: { message: ChatMessage }) {
  const { t } = useTranslation();
  const owner = message.sender === "owner";
  return <div className={owner ? "turn turn-owner" : "turn"}>
    <div className="turn-who">{owner ? t("team.chat.you") : t("role.lead")}</div>
    <p className="turn-body ui-turn-body">{message.body}</p>
    {!!message.attachments?.length && <ul className="ui-chat-attachments" aria-label={t("chat.attachments")}>
      {message.attachments.map(attachment => <li key={attachment.id}><Paperclip aria-hidden="true" /><span>{attachment.name}</span></li>)}
    </ul>}
    {message.kind === "confirmation" && <span className="plate-done"><Check />{t("chat.confirmationRecorded")}</span>}
  </div>;
}

/**
 * A decision is a plate, not a dialog: the lead's question, then one row per option. Choosing
 * sends that option's text back with `answerTo`, which is the only thing that tells the lead
 * which question was answered.
 */
function DecisionPlate({ message, runId, entityVersion, onChanged }: { message: ChatMessage; runId: string; entityVersion: number; onChanged?: () => void }) {
  const { t, i18n } = useTranslation();
  const responseLanguage = i18n.resolvedLanguage === "zh-CN" ? "zh-CN" : "en";
  const { request } = useOwnerSession();
  const action = usePendingAction(message.id + ":" + message.answeredBy);
  const { busy } = action;
  const [failed, setFailed] = useState(false);
  const [question, ...context] = message.body.split("\n\n");
  const answer = async (option: string) => {
    if (!action.begin()) return;
    setFailed(false);
    try { await sendChatMessage(request, runId, option, entityVersion, message.id, responseLanguage); action.complete(); onChanged?.(); }
    catch { setFailed(true); action.fail(); }
  };
  return <div className="plate plate-waiting" role="group" aria-label={t("team.chat.message")}>
    <h2 className="plate-title">{question}</h2>
    {context.length > 0 && <p className="plate-meta ui-pre-line">{context.join("\n\n")}</p>}
    {failed !== null && <p role="alert" className="ui-alert-inline">{failed || t("action.failed")}</p>}
    <div className="options">
      {(message.options ?? []).map(option => <button key={option} className="option" disabled={busy} onClick={() => void answer(option)}>
        {option}
        <ChevronRight />
      </button>)}
    </div>
  </div>;
}

export function Composer({ runId, entityVersion, body, onBodyChange, projectId, onStarted, read, chat, onChanged, attachments, onAttachmentsChange }: {
  runId: string; entityVersion: number; body: string; onBodyChange: (body: string) => void;
  projectId?: string; onStarted?: (runId: string) => void; read?: TeamOwnerRead; chat?: ChatState; onChanged?: () => void;
} & AttachmentDraftProps) {
  const { t, i18n } = useTranslation();
  const responseLanguage = i18n.resolvedLanguage === "zh-CN" ? "zh-CN" : "en";
  const { request } = useOwnerSession();
  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowSelection | undefined>();
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachmentProject = projectId ?? read?.run.rigId;
  const [failed, setFailed] = useState<string | null>(null);
  const closed = read?.run.state === "canceled" || read?.run.state === "cancel_requested" ? read.run.state : null;
  const question = chat?.pendingDecision ?? chat?.messages.filter(message => message.kind === "decision" && !message.answeredBy).at(-1);
  const planning = runId && read?.run.phase === "planning" && !closed;
  const workflow = chat?.documentWorkflow, proposal = chat?.planApproval;
  const typed = planning && !question && !attachments.length ? messageIntent(body) : null;
  const intent: ConfirmationIntent | null = typed?.kind === "confirm" ? typed.intent : null;
  const nextStage: StageIntent | null = typed?.kind === "stage" ? typed.stage : null;
  const version = workflow?.versions.find(document => document.kind === intent);
  const requirements = workflow?.versions.find(document => document.kind === "requirements");
  const requirementsConfirmed = !!requirements && requirements.id === workflow?.confirmed.requirements;
  const execution = intent === "execute" || intent === "plan" && !workflow;
  const settled = !!read && read.run.state === "approved" && !documentDiscussionPending(read, chat);
  const legacyApproval = proposal === null && !workflow;
  const stageReady = !workflow?.pendingStage && (nextStage !== "plan" || (requirementsConfirmed && !workflow?.error));
  const confirmationReady = execution
    ? legacyApproval || (!!proposal?.plan?.content.trim() && !!proposal.roster?.digest && !proposal.error
      && (!workflow || !!proposal.documentVersions))
    : !!version && !workflow?.error && !workflow?.pendingStage;
  const ready = isSendReady({ closed: !!closed, nextStage, intent, settled, stageReady, confirmationReady });
  return <form className="composer" aria-busy={busy || undefined} onSubmit={async event => {
    event.preventDefault();
    if ((!body.trim() && !attachments.length) || sending.current || !ready) return;
    sending.current = true;
    setBusy(true); setFailed(null);
    try {
      let uploaded = [...attachments];
      for (let index = 0; index < uploaded.length; index++) {
        const item = uploaded[index]!;
        if (item.uploaded) continue;
        if (!attachmentProject) throw new Error(t("chat.attachmentProjectMissing"));
        const form = new FormData();
        form.append("file", item.file);
        const result = await request<{ attachment: ProjectAttachment }>(
          "/teams/" + encodeURIComponent(attachmentProject) + "/attachments", { method: "POST", body: form });
        uploaded = uploaded.map(entry => entry.id === item.id ? { ...entry, uploaded: result.attachment } : entry);
        onAttachmentsChange(uploaded);
      }
      const attachmentIds = uploaded.map(entry => entry.uploaded!.id);
      const message = body.trim() || t("chat.attachmentsMessage");
      if (!runId && projectId) {
        const started = await request<{ runId: string }>("/runs", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ goal: message, responseLanguage, rig: projectId, planning: true, documentWorkflow: true,
            ...(attachmentIds.length ? { attachments: attachmentIds } : {}), ...(selectedWorkflow ? { workflow: selectedWorkflow } : {}) }) });
        if (!started.runId) throw new Error("Missing planning record");
        onStarted?.(started.runId);
      } else if (nextStage) {
        await selectDocumentStage(request, runId, entityVersion, nextStage, body.trim(), responseLanguage);
      } else if (intent && execution && (legacyApproval || proposal?.plan)) {
        await approvePlan(request, runId, entityVersion, proposal?.roster?.digest, proposal?.documentVersions,
          { ownerMessage: body.trim(), ...(proposal?.plan ? { planHash: proposal.plan.hash } : {}) }, responseLanguage);
      } else if (intent && version) {
        await confirmDocument(request, runId, entityVersion, version, body.trim(), responseLanguage);
      } else await sendChatMessage(request, runId, selectedWorkflow
        ? `/${selectedWorkflow.entrypoint}${selectedWorkflow.readOnly ? " --read-only" : ""}\n${message}`
        : message, entityVersion, question?.id, responseLanguage, attachmentIds);
      onAttachmentsChange([]);
      setSelectedWorkflow(undefined);
      onBodyChange(""); onChanged?.();
    }
    catch (cause) { setFailed(cause instanceof Error ? cause.message : t("action.failed")); } finally { sending.current = false; setBusy(false); }
  }}>
    {(!runId || read?.run.phase === "delivery") && !question &&
      <WorkflowPicker value={selectedWorkflow} onChange={setSelectedWorkflow} disabled={busy || !!closed} />}
    {closed && <p className="composer-confirmation" role="status">{t(`status.run.${closed}`)}</p>}
    {question && <p className="composer-confirmation">{t("chat.answerQuestion")}</p>}
    {nextStage && <p className="composer-confirmation" role="status">{!ready ? t("chat.stageWaiting")
      : t("chat.stageRequestConsequence", { stage: t(`documents.stage.${nextStage}`) })}</p>}
    {intent && <p className="composer-confirmation" role="status">{!ready ? t("chat.confirmationWaiting") : execution
      ? t(read?.run.binding.readPaths.includes(".") ? "team.plan.projectScopeConsequence"
        : workflow ? "documents.approveConsequence" : "chat.legacyApprovalConsequence")
      : t("chat.documentConfirmationConsequence", { kind: t(`documents.kind.${version!.kind}`), version: version!.version })}</p>}
    {failed && <p role="alert" className="composer-error">{failed}</p>}
    {!!attachments.length && <ul className="ui-chat-attachments" aria-label={t("chat.attachments")}>
      {attachments.map(item => <li key={item.id}><Paperclip aria-hidden="true" /><span>{item.file.name}</span>
        <button type="button" className="ui-icon-button" disabled={busy || !!closed} aria-label={t("chat.removeAttachment", { name: item.file.name })}
          onClick={() => onAttachmentsChange(attachments.filter(entry => entry.id !== item.id))}><X aria-hidden="true" /></button>
      </li>)}
    </ul>}
    <input ref={fileInput} type="file" hidden multiple disabled={busy || !!closed || !attachmentProject} aria-label={t("chat.chooseAttachments")}
      onChange={event => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (attachments.length + files.length > ATTACHMENTS_PER_MESSAGE) { setFailed(t("chat.attachmentCount")); return; }
        const oversized = files.find(file => file.size > ATTACHMENT_MAX_BYTES);
        if (oversized) { setFailed(t("chat.attachmentSize", { name: oversized.name })); return; }
        setFailed(null);
        onAttachmentsChange([...attachments, ...files.map(file => ({ id: crypto.randomUUID(), file }))]);
      }} />
    <button type="button" className="ui-icon-button" disabled={busy || !!closed || !attachmentProject} aria-label={t("chat.attachFiles")}
      title={t("chat.attachmentLimits")} onClick={() => fileInput.current?.click()}><Paperclip aria-hidden="true" /></button>
    <textarea rows={1} maxLength={65_536} disabled={busy || !!closed} aria-label={t("team.chat.message")} value={body} onChange={event => onBodyChange(event.target.value)} />
    <button className="btn btn-primary" type="submit" disabled={busy || (!body.trim() && !attachments.length) || !ready}>{t("team.chat.send")}</button>
  </form>;
}

/** Approval carries the digest of the proposal displayed here, never an unseen re-read. */
function PlanPlate({ read, runId, entityVersion, chat, onChanged }: {
  read?: TeamOwnerRead; runId: string; entityVersion: number; chat?: ChatState; onChanged?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const responseLanguage = i18n.resolvedLanguage === "zh-CN" ? "zh-CN" : "en";
  const { request } = useOwnerSession();
  const cache = useQueryClient();
  const action = usePendingAction(entityVersion);
  const { busy } = action;
  const [failed, setFailed] = useState(false);
  const [cancelStatus, setCancelStatus] = useState<"canceled" | "cancel_requested" | null>(null);
  if (!read) return null;
  const approved = read.run.phase !== "planning";
  const proposal = chat?.planApproval;
  const proposalReady = proposal === null || (!!proposal?.plan?.content.trim() && !!proposal.roster?.digest && !proposal.error);
  const updating = !approved && documentDiscussionPending(read, chat);
  const needsRecovery = !approved && !!proposal?.error && !proposal.plan && !proposal.roster;
  const canCancel = !approved && read.run.state !== "canceled" && read.run.state !== "cancel_requested";
  const canApprove = chat?.available && chat.phase === "planning" && proposalReady && !updating && read.run.state === "approved"
    && (!chat.documentWorkflow || !!proposal?.documentVersions);
  const work = read.tasks.filter(task => task.role !== "reviewer").length;
  return <div className={approved ? "plate" : "plate plate-waiting"} role="group" aria-label={t("team.plan.approve")}>
    <h2 className="plate-title">{read.run.displayName}</h2>
    {approved && <div className="plate-meta">{t("team.plan.work", { count: work })}</div>}
    {!approved && proposal?.plan && <details className="plate-meta">
      <summary>{t("team.plan")}</summary>
      <pre className="ui-plan-pre">{proposal.plan.content}</pre>
    </details>}
    {!approved && proposal?.roster && <div role="group" aria-label={t("team.plan.roster")}>
      <h3 className="plate-meta">{t("team.plan.roster")}</h3>
      {proposal.roster.seats.map((seat, index) => <p key={index} className="plate-meta">
        {t(`role.${seat.role}`)} · {t(`team.client.${seat.client}`)}{seat.model ? " · " + seat.model : ""}
      </p>)}
    </div>}
    {!approved && (updating || !proposalReady) && !proposal?.error && <p className="plate-meta">{t("team.plan.preparing")}</p>}
    {needsRecovery && <p className="plate-meta">{t("team.plan.staleRun")}</p>}
    {(!updating && proposal?.error || failed) && <p role="alert" className="ui-alert-inline">
      {proposal?.error || t("team.plan.approvalFailed")}
    </p>}
    {!approved && (chat?.documentWorkflow || read.run.binding.readPaths.includes(".")) && <p className="plate-meta">
      {t(read.run.binding.readPaths.includes(".") ? "team.plan.projectScopeConsequence" : "documents.approveConsequence")}
    </p>}
    <div className="plate-foot">
      {canCancel && <button className="btn btn-outline" disabled={busy} onClick={async () => {
        if (!window.confirm(t("team.cancelPrompt")) || !action.begin()) return;
        setFailed(false); setCancelStatus(null);
        try {
          const result = await cancelRun(request, runId, entityVersion);
          if (result.status === "denied") throw new Error("Cancellation denied");
          setCancelStatus(result.value?.state === "canceled" ? "canceled" : "cancel_requested");
          await cache.invalidateQueries({ queryKey: ["team", runId] });
          onChanged?.();
          action.complete();
        } catch { setFailed(true); action.fail(); }
      }}>{t("action.cancel")}</button>}
      {!approved && !updating && proposal?.error && <button className="btn btn-outline" disabled={busy} onClick={async () => {
        if (!action.begin()) return;
        setFailed(false);
        try { await sendChatMessage(request, runId, t("chat.repairPlanMessage"), entityVersion, undefined, responseLanguage); action.complete(); }
        catch { setFailed(true); action.fail(); }
      }}>{t("chat.repairPlan")}</button>}
      {approved ? <span className="plate-done"><Check />{t("team.plan.approvedShort")}</span>
        : <button className="btn btn-primary" disabled={busy || !canApprove} onClick={async () => {
          if (!action.begin()) return;
          setFailed(false);
          try { await approvePlan(request, runId, entityVersion, proposal?.roster?.digest, proposal?.documentVersions,
            { ownerMessage: t("team.plan.approve"), ...(proposal?.plan ? { planHash: proposal.plan.hash } : {}) }, responseLanguage); action.complete(); }
          catch { setFailed(true); action.fail(); }
        }}>{t("team.plan.approve")}</button>}
    </div>
    {cancelStatus && <p role="status">{t(cancelStatus === "canceled" ? "status.run.canceled" : "status.run.cancel_requested")}</p>}
  </div>;
}

/** A worker's question, worded as it wrote it; the answer goes to that worker's task. */
export function QuestionPlate({ read, task }: { read: TeamOwnerRead; task: TeamOwnerRead["tasks"][number] }) {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const action = usePendingAction(task.taskId + ":" + read.run.entityVersion);
  const [answer, setAnswer] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const send = async () => {
    if (!answer.trim() || !action.begin()) return;
    setFailed(null);
    try { await postTaskComment(request, read.runId, task.taskId, answer.trim(), read.run.entityVersion); setAnswer(""); action.complete(); }
    catch (cause) { setFailed(cause instanceof Error ? cause.message : null); action.fail(); }
  };
  return <div className="plate plate-waiting" role="group" aria-label={task.displayName}>
    <h2 className="plate-title"><TextPreview text={task.workerReport?.question ?? ""} /></h2>
    <p className="plate-meta"><TextPreview text={task.displayName} /></p>
    {failed !== null && <p role="alert" className="ui-alert-inline">{failed || t("action.failed")}</p>}
    <textarea className="ui-question-answer" aria-label={t("overview.answerWorker")} value={answer} disabled={action.busy}
      onChange={event => setAnswer(event.target.value)}
      onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); } }} />
    <div className="plate-foot">
      <button className="btn btn-primary" disabled={action.busy || !answer.trim()} onClick={() => void send()}>{t("overview.answerWorker")}</button>
    </div>
  </div>;
}

/**
 * A blocked run's one owner action. A budget block asks for an explicit increase; each click
 * adds one hour, including after earlier extensions, and states that amount first. The cache
 * is invalidated on success so the plate releases even when the event stream is down.
 */
export function ResumePlate({ read }: { read: TeamOwnerRead }) {
  const { t } = useTranslation();
  const { request } = useOwnerSession();
  const cache = useQueryClient();
  const action = usePendingAction(read.run.entityVersion);
  const { busy } = action;
  const [failed, setFailed] = useState<string | null>(null);
  const run = read.run;
  const limits = run.binding.limits;
  const minutes = 60;
  const retries = Math.max(1, limits.maxRetries);
  const rounds = Math.max(1, limits.maxReviewRounds);
  const increase =
    run.stateReasonKey === "team.reason.activeWallClockBudget" ? { addMinutes: minutes }
      : run.stateReasonKey === "team.reason.retryLimitExhausted" ? { addRetries: retries }
        : run.stateReasonKey === "team.reason.reviewLimitExhausted" ? { addReviewRounds: rounds }
          : {};
  return <div className="plate plate-waiting" role="group" aria-label={t("team.resume.action")}>
    <h2 className="plate-title">{run.stateReasonKey ? t(run.stateReasonKey) : run.stateReason}</h2>
    {run.stateReasonKey === "team.reason.activeWallClockBudget" && <p className="plate-meta">{t("team.resume.minutes", { count: minutes })}</p>}
    {run.stateReasonKey === "team.reason.retryLimitExhausted" && <p className="plate-meta">{t("team.resume.retries", { count: retries })}</p>}
    {run.stateReasonKey === "team.reason.reviewLimitExhausted" && <p className="plate-meta">{t("team.resume.rounds", { count: rounds })}</p>}
    {failed !== null && <p role="alert" className="ui-alert-inline">{failed || t("action.failed")}</p>}
    <div className="plate-foot">
      <button className="btn btn-primary" disabled={busy} onClick={async () => {
        if (!action.begin()) return;
        setFailed(null);
        try {
          await request(`/runs/${encodeURIComponent(run.id)}/resume`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ protocolVersion: "1.0", runId: run.id, actionId: run.id,
              expectedEntityVersion: run.entityVersion, idempotencyKey: crypto.randomUUID(), payload: increase }),
          });
          await cache.invalidateQueries({ queryKey: ["team", read.runId] });
          action.complete();
        } catch (cause) { setFailed(cause instanceof Error ? cause.message : null); action.fail(); }
      }}>{t("team.resume.action")}</button>
    </div>
  </div>;
}
