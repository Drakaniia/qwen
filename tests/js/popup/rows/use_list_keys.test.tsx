/**
 * The roving-tabindex keyboard model (spec §10, D14).
 *
 * `useListKeys` is the one piece of §10 that is genuinely logic rather than markup, and
 * it is the piece both `MediaView` and `DownloadsView` mount, so its behaviour is pinned
 * here rather than through a rendered list: the assertions are about which callback ran
 * and with which index, which is exactly the surface a row list cares about.
 *
 * Everything is driven through a real rendered container with a real `keydown`, so the
 * `containerProps` prop bag is exercised too — a hook that computed the right index but
 * returned the wrong `role` would pass a state-only test.
 *
 * Every press goes through `act()`: `setActiveIndex` is a `useState` setter, so preact
 * batches the re-render into a microtask and the index read straight after a synchronous
 * dispatch would still be the old one.
 */
import { act, cleanup, render } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useListKeys, type ListKeys } from "../../../../src/ui/useListKeys.js";
import { clear, selection, select, toggle } from "../../../../src/ui/useStickySelection.js";

async function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

interface Harness {
  host: HTMLElement;
  /** The live hook return value, re-read from the last render. */
  keys(): ListKeys;
  onDownload: ReturnType<typeof vi.fn>;
  onToggleSelect: ReturnType<typeof vi.fn>;
  onSlash: ReturnType<typeof vi.fn>;
}

/**
 * Mounts the hook on a `<ul>` and spreads `containerProps` onto it, which is exactly
 * what both views do — so the prop bag's `role` / `aria-*` / `tabIndex` are under test
 * as well as the handler.
 */
function mount(count: number, overrides: Partial<Parameters<typeof useListKeys>[0]> = {}): Harness {
  const onDownload = vi.fn();
  const onToggleSelect = vi.fn();
  const onSlash = vi.fn();
  let live: ListKeys = null as unknown as ListKeys;

  function List() {
    live = useListKeys({ count, onDownload, onToggleSelect, onSlash, ...overrides });
    return <ul {...live.containerProps} data-testid="list" />;
  }

  const host = render(<List />).container.querySelector("[data-testid=list]") as HTMLElement;
  return { host, keys: () => live, onDownload, onToggleSelect, onSlash };
}

afterEach(() => {
  cleanup();
  clear();
});

describe("containerProps", () => {
  it("is a multi-selectable listbox that can hold focus", () => {
    const { host } = mount(3);
    expect(host.getAttribute("role")).toBe("listbox");
    expect(host.getAttribute("aria-multiselectable")).toBe("true");
    expect(host.getAttribute("tabindex")).toBe("0");
  });

  it("names the active row through aria-activedescendant", () => {
    const { host, keys } = mount(3);
    expect(host.getAttribute("aria-activedescendant")).toBe(keys().rowId(0));
  });

  it("omits aria-activedescendant on an empty list rather than naming a row that is not there", () => {
    const { host } = mount(0);
    expect(host.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("honours a caller-supplied row id so the parent can align it with what it renders", () => {
    const { host, keys } = mount(2, { idFor: (index) => `row-${index}` });
    expect(host.getAttribute("aria-activedescendant")).toBe("row-0");
    expect(keys().rowId(1)).toBe("row-1");
  });

  it("gives exactly one row the roving tabindex", () => {
    const { keys } = mount(4);
    expect([0, 1, 2, 3].map(keys().rowTabIndex)).toEqual([0, -1, -1, -1]);
  });

  it("is legal on any element, not only a ul — the prop bag carries no element-bound props", () => {
    // `ref`/`key` are bound to one concrete element in preact's `HTMLAttributes<T>`, so
    // a naive typing of the prop bag would reject `<div {...containerProps}>`.
    let host: HTMLElement | null = null;
    function Div() {
      const keys = useListKeys({ count: 2, onDownload: vi.fn(), onToggleSelect: vi.fn() });
      return (
        <div {...keys.containerProps} data-testid="div">
          <span id={keys.rowId(0)} />
        </div>
      );
    }
    host = render(<Div />).container.querySelector("[data-testid=div]") as HTMLElement;
    expect(host?.getAttribute("role")).toBe("listbox");
  });
});

describe("arrow keys", () => {
  it("starts on the first row", () => {
    expect(mount(5).keys().activeIndex).toBe(0);
  });

  it("moves down and up", async () => {
    const { host, keys } = mount(5);
    await press(host, "ArrowDown");
    expect(keys().activeIndex).toBe(1);
    await press(host, "ArrowDown");
    expect(keys().activeIndex).toBe(2);
    await press(host, "ArrowUp");
    expect(keys().activeIndex).toBe(1);
  });

  it("clamps at both ends instead of wrapping", async () => {
    const { host, keys } = mount(3);
    await press(host, "ArrowUp");
    expect(keys().activeIndex).toBe(0);
    for (let i = 0; i < 4; i += 1) {
      await press(host, "ArrowDown");
    }
    expect(keys().activeIndex).toBe(2);
  });

  it("reports -1 for an empty list", () => {
    expect(mount(0).keys().activeIndex).toBe(-1);
  });

  it("clamps a programmatic index into range", async () => {
    const { keys } = mount(3);
    await act(async () => keys().setActiveIndex(99));
    expect(keys().activeIndex).toBe(2);
    await act(async () => keys().setActiveIndex(-5));
    expect(keys().activeIndex).toBe(0);
  });

  it("keeps the arrow key from scrolling the popup", async () => {
    const { host } = mount(5);
    expect((await press(host, "ArrowDown")).defaultPrevented).toBe(true);
  });
});

describe("Home and End", () => {
  it("jumps to the last row and back to the first", async () => {
    const { host, keys } = mount(8);
    await press(host, "End");
    expect(keys().activeIndex).toBe(7);
    await press(host, "Home");
    expect(keys().activeIndex).toBe(0);
  });

  it("jumps to 0 from the top and to the last index on a single-row list", async () => {
    const { host, keys } = mount(1);
    await press(host, "End");
    expect(keys().activeIndex).toBe(0);
    await press(host, "Home");
    expect(keys().activeIndex).toBe(0);
  });
});

describe("Enter and Space", () => {
  it("Enter downloads the active row", async () => {
    const { host, onDownload, onToggleSelect } = mount(5);
    await press(host, "ArrowDown");
    await press(host, "ArrowDown");
    await press(host, "Enter");
    expect(onDownload).toHaveBeenCalledWith(2);
    expect(onToggleSelect).not.toHaveBeenCalled();
  });

  it("Space toggles selection on the active row", async () => {
    const { host, onDownload, onToggleSelect } = mount(5);
    await press(host, "ArrowDown");
    await press(host, " ");
    expect(onToggleSelect).toHaveBeenCalledWith(1);
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("claims Space so it cannot scroll the body", async () => {
    const { host } = mount(5);
    expect((await press(host, " ")).defaultPrevented).toBe(true);
  });

  it("does nothing on an empty list", async () => {
    const { host, onDownload, onToggleSelect } = mount(0);
    await press(host, "Enter");
    await press(host, " ");
    expect(onDownload).not.toHaveBeenCalled();
    expect(onToggleSelect).not.toHaveBeenCalled();
  });

  it("calls a callback written with no parameters", async () => {
    // The contract was drafted as `() => void`; a zero-argument closure has to keep
    // compiling and running against `(index: number) => void`.
    const calls: number[] = [];
    function Probe() {
      const keys = useListKeys({
        count: 4,
        onDownload: () => calls.push(1),
        onToggleSelect: () => calls.push(2),
      });
      return <div {...keys.containerProps} data-testid="list" />;
    }
    const host = render(<Probe />).container.querySelector("[data-testid=list]") as HTMLElement;
    await press(host, "Enter");
    await press(host, " ");
    expect(calls).toEqual([1, 2]);
  });
});

describe("Escape and /", () => {
  it("Escape clears the selection", async () => {
    select(["a", "b", "c"]);
    expect(selection.value.size).toBe(3);
    const { host } = mount(3);
    await press(host, "Escape");
    expect(selection.value.size).toBe(0);
  });

  it("/ hands off to the caller's search focus", async () => {
    const { host, onSlash } = mount(3);
    await press(host, "/");
    expect(onSlash).toHaveBeenCalledTimes(1);
  });

  it("/ is inert when the caller supplied no handler", async () => {
    function Probe() {
      const keys = useListKeys({ count: 3, onDownload: vi.fn(), onToggleSelect: vi.fn() });
      return <div {...keys.containerProps} data-testid="list" />;
    }
    const host = render(<Probe />).container.querySelector("[data-testid=list]") as HTMLElement;
    await expect(press(host, "/")).resolves.toBeInstanceOf(KeyboardEvent);
  });
});

describe("keys that belong to someone else", () => {
  it("ignores a modified keystroke", async () => {
    const { host, keys, onDownload, onToggleSelect } = mount(5);
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      await press(host, "ArrowDown", init);
      await press(host, "Enter", init);
    }
    expect(keys().activeIndex).toBe(0);
    expect(onDownload).not.toHaveBeenCalled();
    expect(onToggleSelect).not.toHaveBeenCalled();
  });

  it("ignores keys typed into a search field inside the list", async () => {
    const { host, onDownload, onSlash } = mount(5);
    const input = document.createElement("input");
    host.appendChild(input);
    await press(input, "ArrowDown");
    await press(input, "Enter");
    await press(input, "/");
    expect(onDownload).not.toHaveBeenCalled();
    expect(onSlash).not.toHaveBeenCalled();
  });

  it("ignores a contenteditable target", async () => {
    const { host, onDownload } = mount(5);
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    host.appendChild(editor);
    await press(editor, "Enter");
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("has no vim-style bindings (D14)", async () => {
    const { host, keys, onDownload, onToggleSelect } = mount(5);
    for (const key of ["j", "k", "g", "G", "x", "d", "y", "p", "?", "c"]) {
      await press(host, key);
    }
    expect(keys().activeIndex).toBe(0);
    expect(onDownload).not.toHaveBeenCalled();
    expect(onToggleSelect).not.toHaveBeenCalled();
  });
});

describe("selection wiring", () => {
  it("Space through the hook lands on the shared set, not a private copy", async () => {
    // The list's Escape and the sticky bar's Clear both operate on
    // `useStickySelection`'s module state; a hook with its own set would make the bar's
    // count disagree with the boxes.
    const ids = ["a", "b", "c"];
    function Probe() {
      const keys = useListKeys({
        count: ids.length,
        onDownload: vi.fn(),
        onToggleSelect: (index) => toggle(ids[index]),
      });
      return <div {...keys.containerProps} data-testid="list" />;
    }
    const host = render(<Probe />).container.querySelector("[data-testid=list]") as HTMLElement;
    await press(host, "ArrowDown");
    await press(host, " ");
    expect([...selection.value]).toEqual(["b"]);
    await press(host, "Escape");
    expect(selection.value.size).toBe(0);
  });
});
