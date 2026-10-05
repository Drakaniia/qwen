import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button } from "../../../src/ui/components/Button.js";
import { Field } from "../../../src/ui/components/Field.js";
import { ProgressBar } from "../../../src/ui/components/ProgressBar.js";
import { Toggle } from "../../../src/ui/components/Toggle.js";

afterEach(cleanup);

describe("Button", () => {
  it("renders a real button and fires onClick", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Download link</Button>);

    const button = screen.getByRole("button", { name: "Download link" });
    expect(button.tagName).toBe("BUTTON");
    // Defaults to type="button" so it never submits a form it did not ask to submit.
    expect(button.getAttribute("type")).toBe("button");

    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("exposes aria-pressed only when it is a two-state button", () => {
    const { rerender } = render(<Button>Downloads</Button>);
    expect(screen.getByRole("button").hasAttribute("aria-pressed")).toBe(false);

    rerender(<Button pressed>Downloads</Button>);
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("true");
  });

  it("does not fire onClick while disabled", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Clear
      </Button>,
    );

    const button = screen.getByRole("button");
    expect(button.hasAttribute("disabled")).toBe(true);
    button.click();
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Toggle", () => {
  it("is a real checkbox associated with its label", () => {
    render(<Toggle label="Download subtitles (CC)" checked={false} onChange={() => {}} />);

    const checkbox = screen.getByRole("checkbox", { name: "Download subtitles (CC)" });
    expect(checkbox.tagName).toBe("INPUT");
    expect(checkbox.getAttribute("type")).toBe("checkbox");
    expect((checkbox as HTMLInputElement).checked).toBe(false);
  });

  it("reports the new value on change", () => {
    const onChange = vi.fn();
    render(<Toggle label="Show download overlay" checked={false} onChange={onChange} />);

    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    checkbox.click();
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("points its hint at the checkbox via aria-describedby", () => {
    render(<Toggle label="Sync history" hint="Signed-in browsers only." checked onChange={() => {}} />);

    const describedBy = screen.getByRole("checkbox").getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe("Signed-in browsers only.");
  });
});

describe("Field", () => {
  it("labels the control and describes it with hint and status", () => {
    render(
      <Field label="Download folder" hint="Use a Windows path." status="Settings saved.">
        {({ id, describedBy }) => <input id={id} aria-describedby={describedBy} type="text" />}
      </Field>,
    );

    const input = screen.getByLabelText("Download folder") as HTMLInputElement;
    const describedBy = input.getAttribute("aria-describedby") as string;

    expect(describedBy.split(" ")).toHaveLength(2);
    expect(document.getElementById(describedBy.split(" ")[0])?.textContent).toBe("Use a Windows path.");
    expect(document.getElementById(describedBy.split(" ")[1])?.textContent).toBe("Settings saved.");
  });

  it("announces the status line politely", () => {
    render(
      <Field label="Download method" status="Helper not installed.">
        {({ id }) => <select id={id} />}
      </Field>,
    );

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Helper not installed.");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("leaves aria-describedby off when there is nothing to describe", () => {
    render(
      <Field label="Backend">
        {({ id, describedBy }) => <input id={id} aria-describedby={describedBy} type="text" />}
      </Field>,
    );

    expect(screen.getByLabelText("Backend").hasAttribute("aria-describedby")).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("ProgressBar", () => {
  it("reports a determinate value, its percentage, and the text label", () => {
    render(<ProgressBar value={42.4} label="42% downloaded of 5 MB" />);

    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(bar.getAttribute("aria-valuetext")).toBe("42% downloaded of 5 MB");
    // The visible label is the same string, so sighted and AT users read one thing.
    expect(screen.getByText("42% downloaded of 5 MB")).toBeTruthy();
  });

  it("omits aria-valuenow while indeterminate rather than reporting a stale number", () => {
    render(<ProgressBar value={null} label="Merging downloaded segments..." />);

    const bar = screen.getByRole("progressbar");
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.getAttribute("aria-valuetext")).toBe("Merging downloaded segments...");
  });

  it("clamps an out-of-range value instead of overflowing the track", () => {
    const { rerender } = render(<ProgressBar value={-20} label="Starting" />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");

    rerender(<ProgressBar value={140} label="Done" />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  });

  it("takes an accessible name from ariaLabel when the row already names it", () => {
    render(<ProgressBar value={10} label="10% downloaded" ariaLabel="ep.mp4 download progress" />);

    expect(screen.getByRole("progressbar", { name: "ep.mp4 download progress" }).getAttribute("aria-valuetext")).toBe(
      "10% downloaded",
    );
  });

  describe("percentApproximate (spec D2/D9, §4.3)", () => {
    it("marks an estimate in the readout and in aria-valuetext", () => {
      render(<ProgressBar value={21.7} label="21% downloaded" speed="236.92KBps" percentApproximate />);

      // The tilde rides on the visible number… The readout joins its parts with a
      // separator, so assert on the rendered text rather than an exact node match.
      expect(document.body.textContent).toContain("~22%");
      // …and the accessible value says so too: an estimate announced as an exact
      // figure is the accessibility half of D2.
      expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("21% downloaded (approximate)");
      // The number itself is untouched — only its honesty is marked.
      expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("22");
    });

    it.each([undefined, false])("behaves exactly as before when the flag is %j", (percentApproximate) => {
      render(
        <ProgressBar value={21.7} label="21% downloaded" speed="236.92KBps" percentApproximate={percentApproximate} />,
      );

      expect(document.body.textContent).toContain("22%");
      expect(document.body.textContent).not.toContain("~");
      expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("21% downloaded");
    });

    it("leaves an indeterminate bar's text alone", () => {
      // No percent, so nothing to mark — and the bar must not gain a value now.
      render(<ProgressBar value={null} label="Merging downloaded segments..." percentApproximate />);

      const bar = screen.getByRole("progressbar");
      expect(bar.hasAttribute("aria-valuenow")).toBe(false);
      expect(bar.getAttribute("aria-valuetext")).toBe("Merging downloaded segments... (approximate)");
    });
  });
});
