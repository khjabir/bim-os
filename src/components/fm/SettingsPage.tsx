"use client";

// Settings: the facility's details, the person using this device, the
// workspace file (backup, moving to another device, bringing changes in),
// storage on this device, and starting over.

import { Download, HardDrive, ShieldCheck, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Callout } from "@/components/ui/primitives";
import { pushToast } from "@/lib/store";
import { formatBytes } from "@/lib/utils/format";
import { requestPersistence, storageEstimate } from "@/lib/fm/db";
import { clearWorkspace, updateFacility, useFm } from "@/lib/fm/store";
import { exportWorkspace, importFile, type ImportResult } from "@/lib/fm/sync";
import type { Facility } from "@/lib/fm/types";
import { FormRow, inputCls, Modal, PageFrame, Panel, plural } from "./ui";

export function SettingsPage() {
  const status = useFm((s) => s.status);
  const facility = useFm((s) => s.facility);
  return (
    <PageFrame title="Settings" subtitle="The facility on this device, its workspace file and this device's storage.">
      {status === "ready" && facility ? <FacilityPanel facility={facility} /> : null}
      <WorkspacePanel />
      <StoragePanel />
    </PageFrame>
  );
}

function Text({ label, value, onSave, hint, placeholder }: { label: string; value: string; onSave: (v: string) => void; hint?: string; placeholder?: string }) {
  return (
    <FormRow label={label} hint={hint}>
      <input className={inputCls} defaultValue={value} placeholder={placeholder} onBlur={(e) => e.target.value.trim() !== value && onSave(e.target.value.trim())} />
    </FormRow>
  );
}

function FacilityPanel({ facility }: { facility: Facility }) {
  const set = (patch: Partial<Facility>) => updateFacility(patch);
  return (
    <Panel title="Facility">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Text label="Building name" value={facility.name} onSave={(v) => v && set({ name: v })} />
        <Text label="Site" value={facility.site} onSave={(v) => set({ site: v })} />
        <Text label="Address" value={facility.address} onSave={(v) => set({ address: v })} />
        <Text label="Site code" value={facility.siteCode} onSave={(v) => set({ siteCode: v })} hint="Used in location codes; asset codes made at onboarding keep theirs." />
        <Text label="Building code" value={facility.buildingCode} onSave={(v) => set({ buildingCode: v })} />
        <Text label="Currency" value={facility.currency} onSave={(v) => set({ currency: v.toUpperCase() })} placeholder="AED, GBP, EUR…" />
        <Text label="Your name" value={facility.user} onSave={(v) => set({ user: v })} hint="Recorded with the changes, checks and work orders made on this device." />
        <Text label="App address for QR labels" value={facility.labelBaseUrl} onSave={(v) => set({ labelBaseUrl: v.replace(/\/+$/, "") })} hint="Labels then open the asset in the field app when scanned with a phone camera." placeholder="https://fm.example.com" />
      </div>
      <p className="mt-3 text-[11.5px] text-fg-3">
        Onboarded from {facility.source === "demo" ? "the demo" : facility.source === "ifc" ? "IFC models" : facility.source === "file" ? "a workspace file" : "models"} on {facility.createdAt.slice(0, 10)}.
      </p>
    </Panel>
  );
}

function WorkspacePanel() {
  const facility = useFm((s) => s.facility);
  const assets = useFm((s) => s.assets.length);
  const workOrders = useFm((s) => s.workOrders.length);
  const photos = useFm((s) => s.photos.length);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<Extract<ImportResult, { kind: "workspace" }> | null>(null);
  const [resetting, setResetting] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  return (
    <Panel title="Workspace file" id="workspace">
      <div className="flex flex-col gap-3">
        <p className="max-w-[90ch] text-[12.5px] leading-relaxed text-fg-2">
          The facility&apos;s data lives in this browser. A workspace file holds all of it (assets, edits, rooms, plans, work orders, points, photos; not broker passwords): keep it as a backup, open it on another computer or a phone, or hand it to the next team. Change files from the field app are brought in here too, and merged.
        </p>
        {facility ? (
          <p className="text-[12.5px] text-fg">
            <b>{facility.name}</b>: {plural(assets, "asset")}, {plural(workOrders, "work order")}, {plural(photos, "photo")}.
          </p>
        ) : (
          <p className="text-[12.5px] text-fg-3">No workspace on this device yet.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            icon={<Download size={14} />}
            disabled={!facility}
            busy={busy === "export"}
            onClick={async () => {
              setBusy("export");
              try {
                await exportWorkspace();
              } finally {
                setBusy(null);
              }
            }}
          >
            Export the workspace
          </Button>
          <Button icon={<Upload size={14} />} busy={busy === "import"} onClick={() => input.current?.click()}>
            Open a workspace or change file
          </Button>
          <input
            ref={input}
            type="file"
            accept=".bimos,.zip,application/zip"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setBusy("import");
              setMessage(null);
              try {
                const r = await importFile(file);
                if (r.kind === "changes") setMessage(r.text);
                else if (!r.current) {
                  await r.apply();
                  pushToast("success", `Opened ${r.facility}.`);
                } else setPending(r);
              } catch (error) {
                setMessage(error instanceof Error ? error.message : String(error));
              } finally {
                setBusy(null);
              }
            }}
          />
          {facility ? (
            <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => setResetting(true)}>
              Remove from this device
            </Button>
          ) : null}
        </div>
        {message ? <Callout>{message}</Callout> : null}
      </div>
      {pending ? (
        <Modal
          open
          onClose={() => setPending(null)}
          title="Replace the workspace?"
          footer={
            <>
              <Button onClick={() => setPending(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={async () => {
                  await pending.apply();
                  setPending(null);
                  pushToast("success", `Opened ${pending.facility}.`);
                }}
              >
                Replace {pending.current}
              </Button>
            </>
          }
        >
          <p className="text-[12.5px] leading-relaxed text-fg-2">
            The file holds <b>{pending.facility}</b> with {plural(pending.assets, "asset")}. It replaces <b>{pending.current}</b> on this device, with everything done here since. Export this workspace first if you may need it.
          </p>
        </Modal>
      ) : null}
      {resetting && facility ? <ResetDialog name={facility.name} onClose={() => setResetting(false)} /> : null}
    </Panel>
  );
}

function ResetDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  return (
    <Modal
      open
      onClose={onClose}
      title="Remove the workspace from this device"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={typed.trim() !== name}
            onClick={async () => {
              await clearWorkspace();
              pushToast("info", `${name} was removed from this device.`);
              onClose();
            }}
          >
            Remove
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[12.5px] leading-relaxed text-fg-2">
        <p>Everything about {name} on this device goes: assets, edits, plans, work orders, readings and photos. It cannot be undone; a workspace file exported earlier brings it back.</p>
        <FormRow label={`Type the building's name (${name}) to confirm`}>
          <input className={inputCls} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </FormRow>
      </div>
    </Modal>
  );
}

function StoragePanel() {
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  useEffect(() => {
    void storageEstimate().then(setEstimate);
    void navigator.storage?.persisted?.().then(setPersisted);
  }, []);
  return (
    <Panel title="This device">
      <div className="flex flex-col gap-3 text-[12.5px] text-fg-2">
        <p className="flex items-center gap-2">
          <HardDrive size={15} className="text-fg-3" />
          {estimate ? `${formatBytes(estimate.usage)} used by this app, of ${formatBytes(estimate.quota)} the browser allows.` : "The browser does not report its storage."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck size={15} className={persisted ? "text-ok" : "text-fg-3"} />
          {persisted ? (
            <span>The browser keeps this app&apos;s data even when space runs low.</span>
          ) : (
            <>
              <span>The browser may clear this app&apos;s data when space runs low.</span>
              <Button
                size="sm"
                onClick={async () => {
                  const ok = await requestPersistence();
                  setPersisted(ok);
                  pushToast(ok ? "success" : "info", ok ? "The browser will keep the data." : "The browser did not agree; export the workspace regularly.");
                }}
              >
                Ask to keep it
              </Button>
            </>
          )}
        </div>
        <p className="text-[11.5px] text-fg-3">Nothing here is sent to a server. Export the workspace regularly as a backup.</p>
      </div>
    </Panel>
  );
}
