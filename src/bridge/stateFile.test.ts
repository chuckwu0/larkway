/**
 * Tests for src/bridge/stateFile.ts — StateFileSchema (thin-channel resilience)
 *
 * Regression guard for the 2026-05-29 E2E finding: a business URL field with a
 * non-URL value (e.g. a relative `mr_url`) must NOT discard the whole state and
 * drop the `status` the bridge actually needs. See stateFile.ts `optionalUrl`.
 */
import { describe, it, expect } from "vitest";
import { StateFileSchema } from "./stateFile.js";

describe("StateFileSchema — thin-channel URL leniency", () => {
  it("accepts a relative mr_url and still surfaces status (the bridge's only hard need)", () => {
    const r = StateFileSchema.safeParse({
      status: "ready",
      mr_url: "merge_requests/4025", // relative — the value Lee-QA wrote that broke the old schema
      updated_at: "2026-05-29T12:29:30Z",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.status).toBe("ready");
      expect(r.data.mr_url).toBe("merge_requests/4025");
    }
  });

  it("accepts arbitrary-string business url fields without format validation", () => {
    const r = StateFileSchema.safeParse({
      status: "in_progress",
      dev_url: "http://192.0.2.20:3003/demo/activity/landing-page",
      grey_url: "not-a-real-url-but-passes-through",
      updated_at: "2026-05-29T12:00:00Z",
    });
    expect(r.success).toBe(true);
  });

  it("treats empty-string url placeholders as absent (not a validation failure)", () => {
    const r = StateFileSchema.safeParse({
      status: "in_progress",
      mr_url: "",
      dev_url: "  ",
      updated_at: "2026-05-29T12:00:00Z",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.mr_url).toBeUndefined();
      expect(r.data.dev_url).toBeUndefined();
    }
  });

  it("maps plain color names (green/red/grey) to semantic card_color tokens", () => {
    const cases: Array<[string, string]> = [
      ["green", "success"],
      ["red", "failure"],
      ["grey", "neutral"],
      ["gray", "neutral"],
      ["blue", "neutral"],
      ["SUCCESS", "success"], // case-insensitive + semantic token passthrough
    ];
    for (const [input, expected] of cases) {
      const r = StateFileSchema.safeParse({
        status: "ready",
        card_color: input,
        updated_at: "x",
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.card_color).toBe(expected);
    }
  });

  it("an UNKNOWN card_color must NOT discard the state — it becomes undefined", () => {
    // Regression (2026-05-30 E2E): the agent wrote card_color:"green" on a
    // status:ready build report; the old strict enum rejected the WHOLE state →
    // the bridge never saw ready/mr_url/choices and the card stranded. An
    // out-of-vocab color must degrade to undefined, never fail the parse.
    const r = StateFileSchema.safeParse({
      status: "ready",
      card_color: "chartreuse", // not in the map
      mr_url: "https://example/mr/1",
      choices: [{ label: "X", value: "do X" }],
      updated_at: "x",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.status).toBe("ready"); // the field bridge needs survives
      expect(r.data.card_color).toBeUndefined(); // bad color → undefined, not reject
      expect(r.data.mr_url).toBe("https://example/mr/1");
      expect(r.data.choices?.[0]?.label).toBe("X");
    }
  });

  it("still requires a valid status enum (the one field bridge validates strictly)", () => {
    expect(
      StateFileSchema.safeParse({ status: "bogus", updated_at: "x" }).success,
    ).toBe(false);
    expect(
      StateFileSchema.safeParse({ mr_url: "x", updated_at: "x" }).success,
    ).toBe(false); // missing status
  });

  it("tolerates an arbitrary stage field — a bad stage must NOT discard status/choices", () => {
    // Regression: a V2 bot writing stage:"awaiting_choice" used to throw
    // invalid_enum_value and DROP the whole state (incl. choices → no buttons).
    // stage is no longer a schema field, so z.object STRIPS it — the state still
    // parses and status/choices survive.
    const r = StateFileSchema.safeParse({
      stage: "awaiting_choice",
      status: "ready",
      choices: [{ label: "严格", value: "严格 review" }],
      updated_at: "x",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.status).toBe("ready"); // the field bridge actually needs survives
      expect("stage" in r.data).toBe(false); // unknown stage key stripped, not a reject
      expect(r.data.choices?.[0]?.label).toBe("严格"); // choices preserved → buttons render
    }
  });
});

describe("StateFileSchema — V2 dynamic choices (agent-declared, bridge-opaque)", () => {
  it("parses valid choices (+ choice_prompt) and preserves them verbatim", () => {
    const r = StateFileSchema.safeParse({
      status: "ready",
      choice_prompt: "选哪个方案?",
      choices: [
        { label: "方案A", value: "采用方案A,重构组件" },
        { label: "方案B", value: "采用方案B,只调样式" },
      ],
      updated_at: "2026-05-29T12:00:00Z",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.choice_prompt).toBe("选哪个方案?");
      expect(r.data.choices).toEqual([
        { label: "方案A", value: "采用方案A,重构组件" },
        { label: "方案B", value: "采用方案B,只调样式" },
      ]);
    }
  });

  it("absent choices parses fine (V1 + V2 no-choice path — clean card)", () => {
    const r = StateFileSchema.safeParse({
      status: "in_progress",
      updated_at: "2026-05-29T12:00:00Z",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.choices).toBeUndefined();
  });

  it("rejects a malformed choice missing value (no crash — safeParse returns failure)", () => {
    const r = StateFileSchema.safeParse({
      status: "ready",
      choices: [{ label: "方案A" }], // value missing
      updated_at: "2026-05-29T12:00:00Z",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an empty-string label/value (min(1) guards against blank buttons)", () => {
    expect(
      StateFileSchema.safeParse({
        status: "ready",
        choices: [{ label: "", value: "x" }],
        updated_at: "x",
      }).success,
    ).toBe(false);
    expect(
      StateFileSchema.safeParse({
        status: "ready",
        choices: [{ label: "ok", value: "" }],
        updated_at: "x",
      }).success,
    ).toBe(false);
  });

  it("rejects more than 5 choices (max(5) — Card 2.0 column width / UX cap)", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      label: `opt${i}`,
      value: `选项 ${i}`,
    }));
    const r = StateFileSchema.safeParse({
      status: "ready",
      choices: six,
      updated_at: "x",
    });
    expect(r.success).toBe(false);
  });
});

describe("StateFileSchema — V2 image blocks (agent-declared, bridge-opaque)", () => {
  it("parses image_blocks and fills safe card-render defaults", () => {
    const r = StateFileSchema.safeParse({
      status: "ready",
      last_message: "平台正文",
      image_blocks: [
        { img_key: "img_v3_preview_001" },
        {
          img_key: "img_v3_preview_002",
          alt: "小红书预览图",
          title: "对应图片",
          mode: "crop_center",
          preview: false,
        },
      ],
      updated_at: "2026-06-25T10:00:00Z",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.image_blocks).toEqual([
        {
          img_key: "img_v3_preview_001",
          alt: "图片预览",
          mode: "fit_horizontal",
          preview: true,
        },
        {
          img_key: "img_v3_preview_002",
          alt: "小红书预览图",
          title: "对应图片",
          mode: "crop_center",
          preview: false,
        },
      ]);
    }
  });

  it("rejects malformed image blocks without weakening required status", () => {
    expect(
      StateFileSchema.safeParse({
        status: "ready",
        image_blocks: [{ alt: "missing key" }],
        updated_at: "x",
      }).success,
    ).toBe(false);

    const tooMany = Array.from({ length: 5 }, (_, i) => ({
      img_key: `img_v3_${i}`,
    }));
    expect(
      StateFileSchema.safeParse({
        status: "ready",
        image_blocks: tooMany,
        updated_at: "x",
      }).success,
    ).toBe(false);
  });
});

describe("StateFileSchema — ordered card sections with adjacent images", () => {
  it("parses card_sections and defaults each section image independently", () => {
    const r = StateFileSchema.safeParse({
      status: "ready",
      last_message: "三平台预览如下。",
      card_sections: [
        {
          title: "Jike",
          body: "即刻正文",
          image: { img_key: "img_v3_jike" },
        },
        {
          title: "X",
          body: "X fallback 正文",
          image: {
            img_key: "img_v3_x",
            alt: "X 预览",
            mode: "crop_center",
          },
        },
      ],
      updated_at: "2026-06-25T10:00:00Z",
    });

    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.card_sections).toEqual([
        {
          title: "Jike",
          body: "即刻正文",
          image: {
            img_key: "img_v3_jike",
            alt: "图片预览",
            mode: "fit_horizontal",
            preview: true,
          },
        },
        {
          title: "X",
          body: "X fallback 正文",
          image: {
            img_key: "img_v3_x",
            alt: "X 预览",
            mode: "crop_center",
            preview: true,
          },
        },
      ]);
    }
  });

  it("rejects blank section bodies and caps section count", () => {
    expect(
      StateFileSchema.safeParse({
        status: "ready",
        card_sections: [{ title: "Jike", body: " " }],
        updated_at: "x",
      }).success,
    ).toBe(false);

    const tooMany = Array.from({ length: 9 }, (_, i) => ({
      title: `section ${i}`,
      body: "body",
    }));
    expect(
      StateFileSchema.safeParse({
        status: "ready",
        card_sections: tooMany,
        updated_at: "x",
      }).success,
    ).toBe(false);
  });
});
