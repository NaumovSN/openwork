"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, File, Folder, Upload } from "lucide-react";
import { z } from "zod";
import { DenButton } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const fileSchema = z.object({ id: z.string(), path: z.string(), sizeBytes: z.number(), status: z.enum(["uploading", "ready", "deleting"]), createdAt: z.string() });
const listingSchema = z.object({ items: z.array(fileSchema), usedBytes: z.number(), reservedBytes: z.number(), quotaBytes: z.number(), maxFileBytes: z.number(), allowedFolders: z.array(z.string()) });
const memberPolicySchema = z.object({ quotaBytes: z.number(), allowedFolders: z.array(z.string()) });
const policySchema = z.object({ default: memberPolicySchema, members: z.record(z.string(), memberPolicySchema) });
const MIB = 1024 * 1024;
function sizeLabel(bytes: number) { return bytes >= 1024 * MIB ? `${(bytes / (1024 * MIB)).toFixed(1)} GB` : `${(bytes / MIB).toFixed(1)} MB`; }

async function driveRequest(orgId: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set(ORG_SCOPE_HEADER, orgId);
  const { response, payload } = await requestJson(path, { ...init, headers }, 45_000);
  if (!response.ok) {
    const error = z.object({ message: z.string() }).safeParse(payload);
    throw new Error(error.success ? error.data.message : "Drive request failed. Try again.");
  }
  return payload;
}

/** No feature offer or storage request until this org's effective flag is on. */
export function CloudDriveScreen() {
  const { orgId, orgContext, orgBusy } = useOrgDashboard();
  const router = useRouter();
  const enabled = orgContext?.organization.id === orgId && orgContext.capabilities.cloudDrive === true;
  useEffect(() => { if (orgContext && !orgBusy && !enabled) router.replace("/dashboard"); }, [enabled, orgBusy, orgContext, router]);
  if (!enabled || !orgId || !orgContext) return null;
  return <MemberDrive key={`${orgId}:${orgContext.currentMember.id}`} orgId={orgId} />;
}

function MemberDrive({ orgId }: { orgId: string }) {
  const { orgContext } = useOrgDashboard();
  const queryClient = useQueryClient();
  const [folder, setFolder] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const queryKey = ["cloud-drive", orgId, orgContext?.currentMember.id];
  const listing = useQuery({ queryKey, queryFn: async () => listingSchema.parse(await driveRequest(orgId, "/v1/drive")), retry: false });
  const upload = useMutation({
    mutationFn: async (file: globalThis.File) => {
      if (!listing.data || file.size > listing.data.maxFileBytes) throw new Error("Files must be 8 MB or smaller.");
      if (file.size + listing.data.usedBytes + listing.data.reservedBytes > listing.data.quotaBytes) throw new Error("Your Drive storage limit is reached.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parts: string[] = [];
      for (let start = 0; start < bytes.length; start += 8192) parts.push(String.fromCharCode(...bytes.subarray(start, start + 8192)));
      await driveRequest(orgId, "/v1/drive/files", { method: "POST", body: JSON.stringify({ id: crypto.randomUUID(), path: `${folder}${file.name}`, contentBase64: btoa(parts.join("")) }) });
    },
    onSuccess: () => { setMessage("File uploaded."); },
    onError: (error) => setMessage(error.message),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey }); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => driveRequest(orgId, `/v1/drive/files/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => { setMessage("File deleted."); }, onError: (error) => setMessage(error.message),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey }); },
  });
  const [downloadId, setDownloadId] = useState<string | null>(null);
  async function download(id: string) {
    setDownloadId(id);
    try {
      const data = fileSchema.extend({ contentBase64: z.string() }).parse(await driveRequest(orgId, `/v1/drive/files/${encodeURIComponent(id)}`));
      const binary = atob(data.contentBase64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      // Download-only: active documents never execute on Den's origin.
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      const link = document.createElement("a"); link.href = url; link.download = data.path.split("/").at(-1) ?? "download";
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMessage("File downloaded.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Download failed."); }
    finally { setDownloadId(null); }
  }
  const data = listing.data;
  const folders = [...new Set((data?.items ?? []).filter((item) => item.path.startsWith(folder)).flatMap((item) => {
    const rest = item.path.slice(folder.length); return rest.includes("/") ? [rest.split("/")[0]] : [];
  }))].sort();
  const files = (data?.items ?? []).filter((item) => item.path.startsWith(folder) && !item.path.slice(folder.length).includes("/")).sort((a, b) => a.path.localeCompare(b.path));
  const admin = orgContext?.currentMember.isOwner || orgContext?.currentMember.role.split(",").includes("admin");
  return <main className="mx-auto w-full max-w-5xl px-6 py-8" data-testid="cloud-drive-screen">
    <div className="mb-6 flex items-center justify-between gap-4">
      <h1 className="text-xl font-semibold text-gray-900">My Drive</h1>
      <DenButton icon={Upload} loading={upload.isPending} disabled={!data} onClick={() => fileInput.current?.click()}>Upload file</DenButton>
      <input ref={fileInput} type="file" className="hidden" aria-label="Upload Drive file" onChange={(event) => {
        const file = event.target.files?.[0]; if (file) upload.mutate(file); event.target.value = "";
      }} />
    </div>
    {data && <div className="mb-5 text-sm text-gray-500" data-testid="drive-usage">
      {sizeLabel(data.usedBytes)} of {sizeLabel(data.quotaBytes)} used · Private to you
      {data.reservedBytes > 0 && <span> · {sizeLabel(data.reservedBytes)} reserved for unfinished files</span>}
      <progress className="mt-2 block h-1 w-full accent-gray-900" max={Math.max(1, data.quotaBytes)} value={data.usedBytes + data.reservedBytes} aria-label="Drive storage used" />
    </div>}
    {(message || listing.error) && <p role="status" className="mb-4 text-sm text-gray-700">{message ?? listing.error?.message}</p>}
    <form className="mb-4 flex items-end gap-3" onSubmit={(event) => {
      event.preventDefault(); const value = new FormData(event.currentTarget).get("folder");
      const next = typeof value === "string" ? value.trim().replace(/\/+$/, "") : ""; setFolder(next ? `${next}/` : "");
    }}>
      <label className="block text-sm text-gray-600">Folder<DenInput key={folder} name="folder" aria-label="Folder" defaultValue={folder.replace(/\/$/, "")} placeholder="All files" /></label>
      <DenButton type="submit" variant="secondary">Open</DenButton>
      {folder && <DenButton variant="ghost" onClick={() => setFolder("")}>All files</DenButton>}
    </form>
    <div className="divide-y divide-gray-100 border-y border-gray-200">
      {listing.isPending && <p className="py-5 text-sm text-gray-500" role="status">Loading files…</p>}
      {folders.map((name) => <div key={name} className="flex h-12 items-center gap-3">
        <Folder className="h-4 w-4 text-gray-400" /><DenButton variant="ghost" onClick={() => setFolder(`${folder}${name}/`)}>{name}</DenButton>
      </div>)}
      {files.map((file) => <div key={file.id} className="flex min-h-12 flex-wrap items-center gap-3 py-2 text-sm" data-testid="drive-file-row">
        <File className="h-4 w-4 shrink-0 text-gray-400" /><span className="min-w-0 flex-1 truncate">{file.path.slice(folder.length)}</span>
        <span className="text-gray-500">{sizeLabel(file.sizeBytes)}</span>
        {file.status === "ready" ? <>
          <DenButton variant="ghost" size="sm" icon={Download} aria-label={`Download ${file.path}`} loading={downloadId === file.id} onClick={() => void download(file.id)}>Download</DenButton>
          <DenButton variant="ghost" size="sm" disabled={remove.isPending} onClick={() => {
            if (window.confirm(`Delete ${file.path} from your private Drive? This cannot be undone.`)) remove.mutate(file.id);
          }}>Delete</DenButton>
        </> : file.status === "deleting" ? <DenButton variant="secondary" size="sm" loading={remove.isPending} onClick={() => remove.mutate(file.id)}>Retry delete</DenButton>
          : <span className="text-gray-500">Upload unfinished · Contact admin</span>}
      </div>)}
      {data && !files.length && !folders.length && <p className="py-8 text-sm text-gray-500">No files in this folder.</p>}
    </div>
    {data && <details className="mt-5 text-sm text-gray-500"><summary className="cursor-pointer">Storage limits</summary>
      <p className="py-3">8 MB per file · Allowed folders: {data.allowedFolders.join(", ") || "None"}</p>
    </details>}
    {admin && <DriveAccess orgId={orgId} />}
  </main>;
}

function DriveAccess({ orgId }: { orgId: string }) {
  const { orgContext } = useOrgDashboard();
  const [target, setTarget] = useState("default");
  const [message, setMessage] = useState<string | null>(null);
  const client = useQueryClient();
  const queryKey = ["cloud-drive-policy", orgId];
  const policy = useQuery({ queryKey, queryFn: async () => policySchema.parse(await driveRequest(orgId, "/v1/drive/policy")), retry: false });
  const save = useMutation({
    mutationFn: async (form: FormData) => {
      if (!policy.data) return;
      const quota = Number(form.get("quota")) * MIB;
      const rawFolders = form.get("folders");
      const folders = typeof rawFolders === "string" ? rawFolders.split(",").map((part) => part.trim()).filter(Boolean) : [];
      if (!Number.isSafeInteger(quota) || quota < 0 || !folders.length) throw new Error("Enter a storage limit and at least one allowed folder.");
      const next = { quotaBytes: quota, allowedFolders: folders };
      const body = target === "default" ? { ...policy.data, default: next } : { ...policy.data, members: { ...policy.data.members, [target]: next } };
      await driveRequest(orgId, "/v1/drive/policy", { method: "PUT", body: JSON.stringify(body) });
    },
    onSuccess: () => { setMessage("Drive access saved."); void client.invalidateQueries({ queryKey }); void client.invalidateQueries({ queryKey: ["cloud-drive", orgId] }); },
    onError: (error) => setMessage(error.message),
  });
  const selected = target === "default" ? policy.data?.default : policy.data?.members[target] ?? policy.data?.default;
  return <details className="mt-6 border-t border-gray-200 pt-4 text-sm">
    <summary className="cursor-pointer font-medium text-gray-700">Manage Drive access</summary>
    <div className="mt-4 max-w-xl space-y-4">
      <label className="block text-gray-600">Member
        <select aria-label="Drive policy member" className="mt-1 block h-10 w-full rounded-lg border border-gray-200 bg-white px-3" value={target} onChange={(event) => setTarget(event.target.value)}>
          <option value="default">Organization default</option>
          {(orgContext?.members ?? []).map((member) => <option key={member.id} value={member.id}>{member.user.name || member.user.email}</option>)}
        </select>
      </label>
      {selected && <form key={`${target}:${JSON.stringify(selected)}`} className="space-y-4" onSubmit={(event) => { event.preventDefault(); save.mutate(new FormData(event.currentTarget)); }}>
        <label className="block text-gray-600">Storage limit (MB)<DenInput name="quota" aria-label="Storage limit (MB)" type="number" min="0" step="1" defaultValue={selected.quotaBytes / MIB} /></label>
        <label className="block text-gray-600">Allowed folders<DenInput name="folders" aria-label="Allowed folders" defaultValue={selected.allowedFolders.join(", ")} placeholder="**, or projects/**, reports/**" /></label>
        <p className="text-gray-500">Use ** for all folders, or a folder followed by /**. Separate folders with commas. The server storage limit also applies.</p>
        <DenButton type="submit" size="sm" loading={save.isPending}>Save access</DenButton>
      </form>}
      {(message || policy.error) && <p role="status">{message ?? policy.error?.message}</p>}
    </div>
  </details>;
}
