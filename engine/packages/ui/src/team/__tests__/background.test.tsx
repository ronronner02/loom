import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Background } from "../background.js";

afterEach(() => { cleanup(); });

describe("command-center background", () => {
  it("renders no decorative skin video or image backdrop", () => {
    const view = render(<Background />);
    expect(view.container.querySelector("video")).toBeNull();
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector(".team-backdrop")).toBeNull();
  });
});
