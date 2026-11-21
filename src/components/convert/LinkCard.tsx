"use client";

import { Bookmark, Check, ClipboardCopy, ExternalLink, Link2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Callout, Input, Spinner } from "@/components/ui/primitives";
import { bookmarkletHref, consoleSnippet, openViewerLink } from "@/lib/convert/actions";
import { updateLink, useConvertStore } from "@/lib/convert/store";
import { pushToast } from "@/lib/store";
import { Card } from "./parts";

/**
 * Autodesk Viewer links: the viewer page cannot be fetched or framed from
 * here, so a bookmarklet runs on it, reads the model the viewer has loaded,
 * and sends it back to this page (or saves it as a file to drop in).
 */
export function LinkCard() {
  const link = useConvertStore((s) => s.link);
  const [url, setUrl] = useState(link.url);
  const anchor = useRef<HTMLAnchorElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    // React does not render javascript: links, so the bookmarklet address is set on the element directly.
    void bookmarkletHref(window.location.origin)
      .then((href) => {
        if (!alive || !anchor.current) return;
        anchor.current.setAttribute("href", href);
        setReady(true);
      })
      .catch(() => setReady(false));
    return () => {
      alive = false;
    };
  }, []);

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(await consoleSnippet(window.location.origin));
      pushToast("success", "Copied. Paste it into the viewer page's developer console (F12) and press Enter.");
    } catch {
      pushToast("error", "Could not copy to the clipboard.");
    }
  };

  const statusLine =
    link.status === "opened" ? (
      <span className="flex items-center gap-1.5">
        <Spinner size={12} /> Viewer opened in a new tab. When the model has loaded, click the bookmark there.
      </span>
    ) : link.status === "connected" ? (
      <span className="flex items-center gap-1.5 text-ok">
        <Check size={13} /> {link.message ?? "Connected to the viewer"}. Pick the files in the panel there and click Send.
      </span>
    ) : link.status === "receiving" ? (
      <span className="flex items-center gap-1.5">
        <Spinner size={12} /> {link.message} ({link.received} of {link.total || "?"})
      </span>
    ) : link.status === "done" ? (
      <span className="flex items-center gap-1.5 text-ok">
        <Check size={13} /> {link.message}
      </span>
    ) : link.status === "error" ? (
      <span className="text-bad">{link.message}</span>
    ) : null;

  return (
    <Card title="Autodesk Viewer link" aside={<Link2 size={14} className="text-fg-3" />}>
      <p className="text-[12px] leading-relaxed text-fg-2">
        For a model shared through viewer.autodesk.com, Autodesk Construction Cloud or any page that shows it in the Autodesk viewer, when the file itself is not at hand.
      </p>
      <ol className="mt-2 flex list-decimal flex-col gap-2 pl-4 text-[12px] leading-relaxed text-fg-2 marker:text-fg-3">
        <li>
          Drag this button to your bookmarks bar (once):
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <a
              ref={anchor}
              onClick={(event) => {
                event.preventDefault();
                pushToast("info", "Drag the button to the bookmarks bar, then click it on the viewer page.");
              }}
              draggable
              data-testid="convert-bookmarklet"
              className="inline-flex h-7 cursor-grab items-center gap-1.5 rounded-md border border-accent bg-accent-soft px-2.5 text-[12.5px] font-medium text-accent"
              title="Drag to the bookmarks bar"
            >
              <Bookmark size={13} /> {ready ? "IFC Studio extractor" : "Preparing…"}
            </a>
            <Button size="sm" variant="ghost" icon={<ClipboardCopy size={12} />} onClick={() => void copySnippet()} title="For browsers where bookmarklets are blocked">
              Copy as console snippet
            </Button>
          </div>
        </li>
        <li>
          Paste the link and open it:
          <form
            className="mt-1 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              openViewerLink(url);
            }}
          >
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://autode.sk/… or https://viewer.autodesk.com/…" aria-label="Link to the shared model" />
            <Button type="submit" variant="primary" icon={<ExternalLink size={13} />} disabled={!url.trim()}>
              Open
            </Button>
          </form>
        </li>
        <li>When the model has loaded there, click the bookmark, choose the files and click Send. The model arrives in Sources.</li>
      </ol>
      {statusLine ? <div className="mt-2 text-[12px] text-fg-2">{statusLine}</div> : null}
      {link.status !== "idle" && link.status !== "error" ? (
        <button type="button" className="mt-1 text-[11px] text-fg-3 underline" onClick={() => updateLink({ status: "idle", message: undefined })}>
          Reset
        </button>
      ) : null}
      <Callout className="mt-2.5">
        Opened the viewer some other way? The bookmark then saves an <span className="font-mono text-[11px]">.eapk</span> file instead; drop it on this page. Only use it on models you are allowed to export.
      </Callout>
    </Card>
  );
}
