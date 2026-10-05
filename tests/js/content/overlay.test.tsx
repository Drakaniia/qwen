/**
 * Phase 6 (spec D8 / §5) — the in-page overlay lives in a shadow root.
 *
 * The reason this matters is R5: Tailwind v4's preflight is a global CSS reset.
 * While the overlay's stylesheet shipped as light DOM via the manifest
 * `content_scripts.css` key, preflight could reset the *host page*. A shadow root
 * makes that structurally impossible, and these tests are what keep it impossible.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/preact";

import {
  ensureOverlayHost,
  hideOverlay,
  initOverlay,
  positionAllOverlays,
  setOverlayEnabled,
  setOverlayTheme,
  showQualityLoadingDialog,
  updateOverlay,
  updateQualityLoadingStatus,
} from "../../../src/content/content_overlay.js";
import { QualityDialog } from "../../../src/ui/components/QualityDialog";

const HOST_ID = "qwin-video-overlay-host";

interface Box {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

/** The overlay host, asserted so the tests read as behaviour rather than null-guards. */
function host(): HTMLElement {
  const element = document.getElementById(HOST_ID);
  if (!element) {
    throw new Error("overlay host is not attached");
  }
  return element;
}

function shadow(): ShadowRoot {
  const root = host().shadowRoot;
  if (!root) {
    throw new Error("overlay host has no shadow root");
  }
  return root;
}

function overlayButton(): HTMLButtonElement {
  const element = shadow().querySelector<HTMLButtonElement>(".qwin-overlay-btn");
  if (!element) {
    throw new Error("overlay button is not in the shadow root");
  }
  return element;
}

function box({ left = 100, top = 50, width = 320, height = 180 }: Box = {}): () => DOMRect {
  const rect = {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
  return () => rect as DOMRect;
}

function makeVideo(rect: () => DOMRect = box()): HTMLVideoElement {
  const video = document.createElement("video");
  video.getBoundingClientRect = rect;
  document.body.append(video);
  return video;
}

function dialogText(): string {
  return shadow().textContent || "";
}

const CANDIDATE = { url: "https://cdn.example.com/a.mp4" };

beforeEach(() => {
  initOverlay({
    sendMessageWithResponse: async () => ({ ok: true, videos: [] }),
    getLastDetectedVideos: () => [],
  });
  setOverlayEnabled(true);
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("overlay shadow root", () => {
  it("attaches an open shadow root and leaves the light DOM empty", () => {
    const element = ensureOverlayHost();

    expect(element.shadowRoot).not.toBeNull();
    expect(element.shadowRoot?.mode).toBe("open");
    // Nothing but the host itself: no styling or UI written into the page.
    expect(element.childElementCount).toBe(0);
    expect(element.getAttribute("style")).toBeNull();
  });

  it("injects no stylesheet into the host page", () => {
    ensureOverlayHost();

    // R5: preflight or any overlay rule must not reach third-party DOM.
    expect(document.querySelectorAll("head style")).toHaveLength(0);
    expect(document.body.querySelector("style")).toBeNull();
  });

  it("hosts a button layer inside the shadow root", () => {
    ensureOverlayHost();
    expect(shadow().querySelector(".qwin-overlay-button-layer")).not.toBeNull();
  });

  it("reuses one host across calls rather than stacking duplicate roots", () => {
    const first = ensureOverlayHost();
    expect(ensureOverlayHost()).toBe(first);
    expect(document.querySelectorAll(`#${HOST_ID}`)).toHaveLength(1);
  });
});

describe("overlay theme channel (spec D6)", () => {
  // The overlay's stylesheet lives in a shadow root on a third-party page, so it
  // cannot see the extension's `<html data-theme>`. The host element is the channel.
  it("leaves the media query in charge for system and for an unknown value", () => {
    ensureOverlayHost();
    setOverlayTheme("system");
    expect(host().getAttribute("data-theme")).toBeNull();

    setOverlayTheme(undefined);
    expect(host().getAttribute("data-theme")).toBeNull();
  });

  it("pins an explicit preference onto the host element", () => {
    ensureOverlayHost();
    setOverlayTheme("dark");
    expect(host().getAttribute("data-theme")).toBe("dark");

    setOverlayTheme("light");
    expect(host().getAttribute("data-theme")).toBe("light");
  });

  it("applies a preference that arrives before the host is built", () => {
    // `content.ts` fires `getSettings` before the first scan, so the setting can land
    // first. Losing it would leave a dark-preference user on a light overlay.
    document.body.innerHTML = "";
    setOverlayTheme("dark");
    expect(ensureOverlayHost().getAttribute("data-theme")).toBe("dark");
  });
});

describe("overlay buttons", () => {
  it("mounts the button inside the shadow root, never as a light-DOM sibling", () => {
    updateOverlay(makeVideo(), CANDIDATE);

    expect(shadow().querySelector(".qwin-overlay-btn")).not.toBeNull();
    expect(document.body.querySelector(".qwin-overlay-btn")).toBeNull();
  });

  it("positions with CSS custom properties, not inline left/top", () => {
    updateOverlay(makeVideo(box({ left: 100, top: 50 })), CANDIDATE);

    // Clamped to right - 106, and at least 8px from each edge.
    expect(overlayButton().style.getPropertyValue("--qwin-x")).toBe("314px");
    expect(overlayButton().style.getPropertyValue("--qwin-y")).toBe("58px");
    expect(overlayButton().style.left).toBe("");
    expect(overlayButton().style.top).toBe("");
  });

  it("drops the zIndex = 2147483647 fullscreen hack", () => {
    updateOverlay(makeVideo(), CANDIDATE);

    expect(overlayButton().style.zIndex).toBe("");
    expect(host().style.zIndex).toBe("");
  });

  it("carries no inline appearance styles at all", () => {
    updateOverlay(makeVideo(), CANDIDATE);

    const style = overlayButton().getAttribute("style") || "";
    // Position only. Every visual property belongs to the shadow stylesheet.
    expect(style.replace(/--qwin-[xy]:\s*[^;]+;?/g, "").trim()).toBe("");
  });

  it("labels itself with an Icon glyph, not a text character", () => {
    updateOverlay(makeVideo(), CANDIDATE);

    // §4.4: one icon set. Emoji are banned here because this button sits over the
    // host page's font stack, so a substituted glyph would not hold its metrics.
    const button = overlayButton();
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.textContent).toBe("Download");
    // The label is beside the glyph, not replaced by it — the button has a text
    // accessible name, so the SVG must stay aria-hidden.
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("repositions on demand, which is how scroll and resize stay correct", () => {
    let rect = box({ left: 100, top: 50 });
    const video = makeVideo(() => rect());
    updateOverlay(video, CANDIDATE);
    expect(overlayButton().style.getPropertyValue("--qwin-x")).toBe("314px");

    rect = box({ left: 40, top: 12 });
    positionAllOverlays();
    expect(overlayButton().style.getPropertyValue("--qwin-x")).toBe("254px");
    expect(overlayButton().style.getPropertyValue("--qwin-y")).toBe("20px");
  });

  it("hides a button whose video has scrolled out of the viewport", () => {
    updateOverlay(makeVideo(box({ top: -5000 })), CANDIDATE);
    expect(overlayButton().hidden).toBe(true);
  });

  it("hides a button too small to be a real player", () => {
    updateOverlay(makeVideo(box({ width: 100, height: 60 })), CANDIDATE);
    expect(overlayButton().hidden).toBe(true);
  });

  it("removes the overlay when the candidate disappears", () => {
    const video = makeVideo();
    updateOverlay(video, CANDIDATE);
    expect(shadow().querySelector(".qwin-overlay-btn")).not.toBeNull();

    updateOverlay(video, null);
    expect(shadow().querySelector(".qwin-overlay-btn")).toBeNull();
  });

  it("tolerates a video with no measurable box", () => {
    const video = makeVideo(() => box({ width: 0, height: 0 })());
    expect(() => updateOverlay(video, CANDIDATE)).not.toThrow();
  });
});

describe("overlay quality dialog", () => {
  it("renders the loading view and updates its status in place", () => {
    ensureOverlayHost();
    showQualityLoadingDialog("Asking yt-dlp…");
    expect(dialogText()).toContain("Asking yt-dlp");

    updateQualityLoadingStatus("Resolving variants…");
    expect(dialogText()).toContain("Resolving variants");
  });

  it("ignores status updates once the dialog is closed", () => {
    ensureOverlayHost();
    showQualityLoadingDialog("Asking yt-dlp…");
    hideOverlay();
    updateQualityLoadingStatus("too late");

    expect(dialogText()).not.toContain("too late");
  });

  it("renders inside the shadow root, not the host page", () => {
    ensureOverlayHost();
    showQualityLoadingDialog("Asking yt-dlp…");

    expect(shadow().textContent).toContain("Asking yt-dlp");
    expect(document.body.textContent).not.toContain("Asking yt-dlp");
  });
});

describe("unified QualityDialog component", () => {
  const noop = (): void => {};

  it("renders the loading view with the supplied status text", () => {
    render(
      <QualityDialog
        open
        view="loading"
        title="Choose quality"
        statusText="Asking yt-dlp…"
        onBack={noop}
        onCancel={noop}
        onSelectVideo={noop}
        onSelectFormat={noop}
      />,
    );

    expect(screen.getByText(/Asking yt-dlp/)).toBeTruthy();
  });

  it("renders one row per video and reports the selection", () => {
    const picked: { title?: string }[] = [];
    render(
      <QualityDialog
        open
        view="videos"
        title="Choose a video"
        emptyText="No videos"
        videos={[
          { title: "First clip", url: "https://cdn.example.com/a.mp4", format: "MP4" },
          { title: "Second clip", url: "https://cdn.example.com/b.mp4", format: "WEBM" },
        ]}
        onBack={noop}
        onCancel={noop}
        onSelectVideo={(video: { title?: string }) => picked.push(video)}
        onSelectFormat={noop}
      />,
    );

    // Two video rows; the dialog's own Cancel action is not a "clip".
    const rows = screen.getAllByRole("button", { name: /clip/ });
    expect(rows).toHaveLength(2);
    rows[1]?.click();
    expect(picked).toHaveLength(1);
    expect(picked[0]?.title).toBe("Second clip");
  });

  it("shows the empty text rather than an empty list", () => {
    render(
      <QualityDialog
        open
        view="videos"
        title="Choose a video"
        emptyText="No videos found"
        videos={[]}
        onBack={noop}
        onCancel={noop}
        onSelectVideo={noop}
        onSelectFormat={noop}
      />,
    );

    expect(screen.getByText("No videos found")).toBeTruthy();
  });

  it("only offers a back control when the caller allows it", () => {
    const props = {
      open: true,
      view: "formats" as const,
      title: "Choose quality",
      emptyText: "No formats",
      onBack: noop,
      onCancel: noop,
      onSelectVideo: noop,
      onSelectFormat: noop,
    };

    const { rerender } = render(<QualityDialog {...props} hasBack={false} />);
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull();

    rerender(<QualityDialog {...props} hasBack />);
    expect(screen.getByRole("button", { name: /back/i })).toBeTruthy();
  });
});
