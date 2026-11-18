import type Database from "better-sqlite3";
import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();

export interface MailboxConsumptionReceipt {
  receiptId: string;
  messageId: string;
  rigId: string;
  recipient: string;
  taskId: string;
  runId: string;
  consumedBy: string;
  /** How the route proved `consumedBy`; null when it was not recorded. */
  consumedByProvenance: string | null;
  consumedAt: string;
}

export interface MailboxAttachment {
  taskId: string;
  runId: string;
  artifactId: string;
  hash: string;
}

/**
 * One addressed message as the mailbox publishes it.
 *
 * The projection carries no capability: the secret a seat's poll authenticates with is the
 * mail server's business, and a sender that learned it could read the seat's queue.
 */
export interface MailboxMessage {
  id: string;
  messageId: string;
  rigId: string;
  sender: string;
  kind: "mailbox";
  body: string;
  createdAt: string;
  recipient: string;
  taskId: string;
  runId: string;
  replyTo: string | null;
  attachment: MailboxAttachment[] | null;
  receipt: MailboxConsumptionReceipt | null;
}

interface StoredMailboxMessage extends MailboxMessage {
  capability: string;
}

export interface MailboxSendInput {
  messageId?: string;
  recipient: string;
  taskId: string;
  runId: string;
  body: string;
  replyTo?: string | null;
  attachment?: unknown | null;
  /** The recipient seat's own capability, minted by `worker-mailbox-capability.ts` and required. */
  capability: string;
}

export interface MailboxScope {
  rigId: string;
  recipient: string;
  taskId: string;
  runId: string;
  capability: string;
}

interface MailboxEnvelope {
  version: 1;
  recipient: string;
  taskId: string;
  runId: string;
  replyTo: string | null;
  attachment: unknown | null;
  capability: string;
  receipt: MailboxConsumptionReceipt | null;
}

export class MailboxError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface ChatMessageRow {
  id: string;
  rig_id: string;
  sender: string;
  kind: string;
  body: string;
  topic: string | null;
  created_at: string;
}

const MAILBOX_ENVELOPE_PREFIX = "mailbox:v1:";

export class MailboxRepository {
  readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  sendMailbox(rigId: string, sender: string, input: MailboxSendInput): MailboxMessage {
    if (!MAILBOX_CAPABILITY_PATTERN.test(input.capability)) {
      throw new MailboxError(
        "invalid_mailbox_input",
        "capability must be mailbox: followed by 32 random bytes in base64url",
      );
    }
    const attachment = validateMailboxAttachment(input.attachment, input.taskId, input.runId);
    const id = input.messageId?.trim() || ulid();
    const envelope: MailboxEnvelope = {
      version: 1,
      recipient: input.recipient,
      taskId: input.taskId,
      runId: input.runId,
      replyTo: input.replyTo ?? null,
      attachment,
      capability: input.capability,
      receipt: null,
    };
    const topic = encodeMailboxEnvelope(envelope);

    return this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM chat_messages WHERE id = ?")
        .get(id) as ChatMessageRow | undefined;
      if (existing) {
        if (existing.kind !== "mailbox") {
          throw new MailboxError(
            "mailbox_id_conflict",
            `message id ${id} already names a non-mailbox chat message`,
          );
        }
        const stored = this.rowToMailboxMessage(existing);
        if (
          stored.rigId !== rigId ||
          stored.sender !== sender ||
          stored.body !== input.body ||
          stored.recipient !== input.recipient ||
          stored.taskId !== input.taskId ||
          stored.runId !== input.runId ||
          stored.replyTo !== (input.replyTo ?? null) ||
          stored.capability !== input.capability ||
          stableJson(stored.attachment) !== stableJson(input.attachment ?? null)
        ) {
          throw new MailboxError(
            "mailbox_id_conflict",
            `message id ${id} already names different mailbox content`,
          );
        }
        return mailboxProjection(stored);
      }

      this.db
        .prepare(
          "INSERT INTO chat_messages (id, rig_id, sender, kind, body, topic) VALUES (?, ?, ?, 'mailbox', ?, ?)",
        )
        .run(id, rigId, sender, input.body, topic);

      return mailboxProjection(this.rowToMailboxMessage(
        this.db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as ChatMessageRow,
      ));
    })();
  }

  listMailbox(scope: MailboxScope, limit = 20): MailboxMessage[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM chat_messages WHERE rig_id = ? AND kind = 'mailbox' ORDER BY id ASC",
      )
      .all(scope.rigId) as ChatMessageRow[];

    const messages: MailboxMessage[] = [];
    for (const row of rows) {
      const message = this.rowToMailboxMessage(row);
      if (
        message.recipient !== scope.recipient ||
        message.taskId !== scope.taskId ||
        message.runId !== scope.runId ||
        message.capability !== scope.capability ||
        message.receipt
      ) {
        continue;
      }
      messages.push(mailboxProjection(message));
      if (messages.length >= limit) break;
    }
    return messages;
  }

  countPendingMailbox(scope: MailboxScope): number {
    return this.listMailbox(scope, Number.MAX_SAFE_INTEGER).length;
  }

  /** One mailbox message checked against the caller's scope, without consuming it. */
  getMailbox(scope: MailboxScope & { messageId: string }): MailboxMessage {
    const row = this.db
      .prepare("SELECT * FROM chat_messages WHERE id = ? AND kind = 'mailbox'")
      .get(scope.messageId) as ChatMessageRow | undefined;
    if (!row) {
      throw new MailboxError("mailbox_not_found", `mailbox message ${scope.messageId} not found`);
    }
    const message = this.rowToMailboxMessage(row);
    assertMailboxScope(message, scope);
    return mailboxProjection(message);
  }

  consumeMailbox(
    scope: MailboxScope & { messageId: string; consumedBy: string; consumedByProvenance?: string | null },
  ): { message: MailboxMessage; receipt: MailboxConsumptionReceipt } {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM chat_messages WHERE id = ? AND kind = 'mailbox'")
        .get(scope.messageId) as ChatMessageRow | undefined;
      if (!row) {
        throw new MailboxError(
          "mailbox_not_found",
          `mailbox message ${scope.messageId} not found`,
        );
      }

      const message = this.rowToMailboxMessage(row);
      assertMailboxScope(message, scope);
      if (message.receipt) return { message: mailboxProjection(message), receipt: message.receipt };

      const receipt: MailboxConsumptionReceipt = {
        receiptId: ulid(),
        messageId: message.id,
        rigId: message.rigId,
        recipient: message.recipient,
        taskId: message.taskId,
        runId: message.runId,
        consumedBy: scope.consumedBy,
        consumedByProvenance: scope.consumedByProvenance ?? null,
        consumedAt: new Date().toISOString(),
      };
      const envelope = decodeMailboxEnvelope(row.topic);
      envelope.receipt = receipt;
      const result = this.db
        .prepare("UPDATE chat_messages SET topic = ? WHERE id = ? AND kind = 'mailbox'")
        .run(encodeMailboxEnvelope(envelope), message.id);
      if (result.changes !== 1) {
        throw new MailboxError(
          "mailbox_receipt_not_recorded",
          `mailbox message ${message.id} did not record its consumption receipt`,
        );
      }
      const updated = this.rowToMailboxMessage(
        this.db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(message.id) as ChatMessageRow,
      );
      return { message: mailboxProjection(updated), receipt: updated.receipt! };
    })();
  }

  private rowToMailboxMessage(row: ChatMessageRow): StoredMailboxMessage {
    const envelope = decodeMailboxEnvelope(row.topic);
    return {
      id: row.id,
      messageId: row.id,
      rigId: row.rig_id,
      sender: row.sender,
      kind: "mailbox",
      body: row.body,
      createdAt: row.created_at,
      recipient: envelope.recipient,
      taskId: envelope.taskId,
      runId: envelope.runId,
      replyTo: envelope.replyTo,
      attachment: validateMailboxAttachment(envelope.attachment, envelope.taskId, envelope.runId),
      capability: envelope.capability,
      receipt: envelope.receipt,
    };
  }
}

function validateMailboxAttachment(value: unknown, taskId: string, runId: string): MailboxAttachment[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    throw new MailboxError("invalid_mailbox_input", "attachment must be null or an array of artifact references");
  }
  const keys = ["taskId", "runId", "artifactId", "hash"];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).length !== keys.length ||
        !keys.every(key => Object.hasOwn(entry, key) && typeof entry[key] === "string")) {
      throw new MailboxError("invalid_mailbox_input", "attachment entries must contain only taskId, runId, artifactId and hash strings");
    }
    if (entry.taskId !== taskId || entry.runId !== runId) {
      throw new MailboxError("attachment_scope_mismatch", "attachment taskId and runId must match the mailbox message");
    }
  }
  return value as MailboxAttachment[];
}

function mailboxProjection(message: StoredMailboxMessage): MailboxMessage {
  const { capability: _capability, ...projection } = message;
  return projection;
}

function encodeMailboxEnvelope(envelope: MailboxEnvelope): string {
  return `${MAILBOX_ENVELOPE_PREFIX}${JSON.stringify(envelope)}`;
}

function decodeMailboxEnvelope(value: string | null): MailboxEnvelope {
  if (!value?.startsWith(MAILBOX_ENVELOPE_PREFIX)) {
    throw new MailboxError("mailbox_corrupt", "mailbox row has no valid envelope");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(MAILBOX_ENVELOPE_PREFIX.length));
  } catch {
    throw new MailboxError("mailbox_corrupt", "mailbox row has invalid envelope JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MailboxError("mailbox_corrupt", "mailbox envelope is not an object");
  }
  const envelope = parsed as Partial<MailboxEnvelope>;
  if (
    envelope.version !== 1 ||
    typeof envelope.recipient !== "string" ||
    typeof envelope.taskId !== "string" ||
    typeof envelope.runId !== "string" ||
    (envelope.replyTo !== null && typeof envelope.replyTo !== "string") ||
    typeof envelope.capability !== "string" ||
    (envelope.receipt !== null && typeof envelope.receipt !== "object")
  ) {
    throw new MailboxError("mailbox_corrupt", "mailbox envelope fields are invalid");
  }
  return {
    version: 1,
    recipient: envelope.recipient,
    taskId: envelope.taskId,
    runId: envelope.runId,
    replyTo: envelope.replyTo ?? null,
    attachment: envelope.attachment ?? null,
    capability: envelope.capability,
    receipt: (envelope.receipt as MailboxConsumptionReceipt | null | undefined) ?? null,
  };
}

/** The daemon's own format (32 random bytes); a weaker sender-chosen secret is refused. */
const MAILBOX_CAPABILITY_PATTERN = /^mailbox:[A-Za-z0-9_-]{43}$/;

function assertMailboxScope(message: StoredMailboxMessage, scope: MailboxScope): void {
  if (
    message.rigId !== scope.rigId ||
    message.recipient !== scope.recipient ||
    message.taskId !== scope.taskId ||
    message.runId !== scope.runId ||
    message.capability !== scope.capability
  ) {
    throw new MailboxError(
      "mailbox_scope_mismatch",
      `mailbox message ${message.id} is outside the requested recipient, task, run or capability`,
    );
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
