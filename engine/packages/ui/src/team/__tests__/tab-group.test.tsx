import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabGroup } from "../tab-group.js";

afterEach(cleanup);

describe("tab group", () => {
  it("presses exactly the selected tab and reports a change for each choice", () => {
    const onChange = vi.fn();
    render(<TabGroup label="Sections" value="summary" onChange={onChange}
      items={[{ id: "summary", label: "Summary" }, { id: "flow", label: "Flow" }, { id: "analytics", label: "Analytics" }]} />);
    const group = screen.getByRole("group", { name: "Sections" });
    expect(within(group).getAllByRole("button").map(button => button.getAttribute("aria-pressed")))
      .toEqual(["true", "false", "false"]);
    fireEvent.click(within(group).getByRole("button", { name: "Flow" }));
    expect(onChange).toHaveBeenLastCalledWith("flow");
  });

  it("disables a tab that has nothing to show without hiding it", () => {
    render(<TabGroup label="Workspace" value="files" onChange={() => {}}
      items={[{ id: "files", label: "Files" }, { id: "work", label: "Work", disabled: true }]} />);
    const work = screen.getByRole("button", { name: "Work" });
    expect(work).toHaveProperty("disabled", true);
    expect(work.getAttribute("aria-pressed")).toBe("false");
  });

  it("accepts the caller's class so an existing tab strip keeps its styling", () => {
    render(<TabGroup label="Layout" className="ui-layout-switch" value="grid" onChange={() => {}}
      items={[{ id: "grid", label: "Grid" }]} />);
    expect(screen.getByRole("group", { name: "Layout" }).className).toBe("ui-layout-switch");
  });
});