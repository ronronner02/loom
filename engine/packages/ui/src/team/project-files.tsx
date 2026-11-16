import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { FileText, Folder, RefreshCw } from "lucide-react";
import { useOwnerSession } from "../hooks/useOwnerSession.js";

type FileRead = { kind: "directory"; entries: { name: string; kind: "file" | "directory" }[] }
  | { kind: "file"; content: string; hash: string };

export function ProjectFiles({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { request, paired } = useOwnerSession();
  const [directory, setDirectory] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const read = (path: string, signal: AbortSignal) => request<FileRead>(
    "/teams/" + encodeURIComponent(projectId) + "/files?path=" + encodeURIComponent(path), { signal });
  const listing = useQuery({ queryKey: ["team", "project-files", projectId, directory], enabled: paired, retry: false,
    queryFn: ({ signal }) => read(directory, signal) });
  const preview = useQuery({ queryKey: ["team", "project-file", projectId, selected], enabled: paired && selected !== null, retry: false,
    queryFn: ({ signal }) => read(selected!, signal) });
  const entries = listing.data?.kind === "directory" ? [...listing.data.entries].sort((a, b) =>
    Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name)) : [];
  const navigate = (path: string) => { setDirectory(path); setSelected(null); };
  return <section className="page ui-project-files" aria-label={t("files.title")}>
    <header className="ui-page-head"><h1>{t("nav.workspace")}</h1>
      <button type="button" className="ui-icon-button" aria-label={t("files.refresh")} title={t("files.refresh")}
        disabled={listing.isFetching || selected !== null && preview.isFetching}
        onClick={() => { void listing.refetch(); if (selected !== null) void preview.refetch(); }}><RefreshCw aria-hidden="true" /></button>
    </header>
    <nav className="ui-file-breadcrumbs" aria-label={t("files.location")}>
      <button type="button" className="btn btn-quiet" onClick={() => navigate("")}>{t("files.root")}</button>
      {directory.split("/").filter(Boolean).map((name, index, parts) => <span key={index}>
        <span aria-hidden="true">/</span><button type="button" className="btn btn-quiet"
          onClick={() => navigate(parts.slice(0, index + 1).join("/"))}>{name}</button>
      </span>)}
    </nav>
    <div className="ui-project-file-layout">
      <aside className="plate ui-project-file-list" aria-label={t("files.folder")}>
        {listing.isError ? <><p role="alert">{t("files.listFailed")}</p>
          <button type="button" className="btn btn-outline" onClick={() => void listing.refetch()}>{t("action.retry")}</button></>
          : listing.isPending ? <p role="status">{t("web.loading")}</p>
            : entries.length === 0 ? <p className="muted">{t("files.empty")}</p>
              : <ul>{entries.map(entry => {
                const path = directory ? directory + "/" + entry.name : entry.name;
                return <li key={entry.name}><button type="button" aria-label={entry.name}
                  aria-pressed={entry.kind === "file" ? selected === path : undefined}
                  onClick={() => entry.kind === "directory" ? navigate(path) : setSelected(path)}>
                  {entry.kind === "directory" ? <Folder aria-hidden="true" /> : <FileText aria-hidden="true" />}
                  <span>{entry.name}</span>
                </button></li>;
              })}</ul>}
      </aside>
      <section className="plate ui-project-file-preview" aria-label={t("files.preview")}>
        {selected === null ? <p className="muted">{t("files.select")}</p> : <>
          <h2 className="mono">{selected}</h2>
          {preview.isError ? <><p role="alert">{t("files.previewFailed")}</p>
            <button type="button" className="btn btn-outline" onClick={() => void preview.refetch()}>{t("action.retry")}</button></>
            : preview.isPending ? <p role="status">{t("web.loading")}</p>
              : preview.data?.kind === "file" ? <pre tabIndex={0}>{preview.data.content}</pre>
                : <p role="status">{t("files.previewFailed")}</p>}
        </>}
      </section>
    </div>
  </section>;
}
