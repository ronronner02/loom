import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type Database from "better-sqlite3";
import { getStatePath } from "../data-paths.js";
import { ATTACHMENTS_PER_MESSAGE, TeamContractError, type ProjectAttachment } from "../contracts/team-control.js";

export function attachmentPath(attachment: Pick<ProjectAttachment, "id" | "name">): string {
  const extension = extname(attachment.name);
  return getStatePath(join("attachments", attachment.id, "file" + (/^\.[a-z0-9]{1,16}$/i.test(extension) ? extension : "")));
}

/** Store bytes before metadata; a metadata failure removes this new upload. */
export function storeProjectAttachment(db: Database.Database, teamId: string,
  input: { name: string; mediaType: string; bytes: Buffer }): ProjectAttachment {
  const attachment = { id: randomUUID(), name: input.name, size: input.bytes.length, mediaType: input.mediaType };
  const directory = getStatePath(join("attachments", attachment.id));
  mkdirSync(getStatePath("attachments"), { recursive: true });
  mkdirSync(directory, { mode: 0o700 });
  try {
    writeFileSync(attachmentPath(attachment), input.bytes, { flag: "wx", mode: 0o600 });
    db.prepare("INSERT INTO team_attachments (id, rig_id, name, size, media_type, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(attachment.id, teamId, attachment.name, attachment.size, attachment.mediaType, new Date().toISOString());
    return attachment;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Resolve only uploaded references belonging to this message's project, before any chat write. */
export function resolveProjectAttachments(db: Database.Database, teamId: string, value: unknown): ProjectAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ATTACHMENTS_PER_MESSAGE || new Set(value).size !== value.length) {
    throw new TeamContractError("attachments");
  }
  return value.map(id => {
    if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) {
      throw new TeamContractError("attachments");
    }
    const attachment = db.prepare("SELECT id, name, size, media_type AS mediaType FROM team_attachments WHERE id = ? AND rig_id = ?")
      .get(id, teamId) as ProjectAttachment | undefined;
    if (!attachment) throw new TeamContractError("attachments");
    try {
      const file = lstatSync(attachmentPath(attachment));
      if (!file.isFile() || file.size !== attachment.size) throw new Error();
    } catch { throw new TeamContractError("attachments"); }
    return attachment;
  });
}
