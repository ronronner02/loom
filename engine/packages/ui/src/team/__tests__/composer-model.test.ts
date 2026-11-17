import { describe, expect, it } from "vitest";
import { isSendReady, messageIntent, type SendReadiness } from "../composer-model.js";

const ready = (overrides: Partial<SendReadiness> = {}): SendReadiness => ({
  closed: false, nextStage: null, intent: null, settled: true, stageReady: true, confirmationReady: true, ...overrides,
});

describe("composer message intent", () => {
  it.each([
    ["write the plan", { kind: "stage", stage: "plan" }],
    ["Generate plan", { kind: "stage", stage: "plan" }],
    ["编写计划", { kind: "stage", stage: "plan" }],
    ["prepare the requirements document", { kind: "stage", stage: "requirements" }],
    ["explore ideas", { kind: "stage", stage: "exploration" }],
    ["approve the current plan", { kind: "confirm", intent: "plan" }],
    ["确认计划。", { kind: "confirm", intent: "plan" }],
    ["approve execution", { kind: "confirm", intent: "execute" }],
    ["confirm the requirements", { kind: "confirm", intent: "requirements" }],
  ] as const)("reads %s", (body, expected) => {
    expect(messageIntent(body)).toEqual(expected);
  });

  it.each(["", "   ", "Please fix the failing tests", "plan", "approve"])("leaves ordinary chat alone: %s", body => {
    expect(messageIntent(body)).toBeNull();
  });
});

describe("composer send readiness", () => {
  it("sends ordinary chat whenever the run is open", () => {
    expect(isSendReady(ready())).toBe(true);
    expect(isSendReady(ready({ settled: false, stageReady: false, confirmationReady: false }))).toBe(true);
  });

  it("holds a stage message until the run is settled and the stage can move", () => {
    expect(isSendReady(ready({ nextStage: "plan" }))).toBe(true);
    expect(isSendReady(ready({ nextStage: "plan", settled: false }))).toBe(false);
    expect(isSendReady(ready({ nextStage: "plan", stageReady: false }))).toBe(false);
  });

  it("holds a confirmation until the run is settled and the target carries its evidence", () => {
    expect(isSendReady(ready({ intent: "plan" }))).toBe(true);
    expect(isSendReady(ready({ intent: "plan", settled: false }))).toBe(false);
    expect(isSendReady(ready({ intent: "execute", confirmationReady: false }))).toBe(false);
  });

  it("never sends to a canceled run, whatever the typed message says", () => {
    expect(isSendReady(ready({ closed: true }))).toBe(false);
    expect(isSendReady(ready({ closed: true, nextStage: "plan" }))).toBe(false);
  });
});