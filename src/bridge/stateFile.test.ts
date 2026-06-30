/**
 * Tests for src/bridge/stateFile.ts — StateFileSchema (thin-channel resilience)
 *
 * Regression guard for the 2026-05-29 E2E finding: a business URL field with a
 * non-URL value (e.g. a relative `mr_url`) must NOT discard the whole state and
 * drop the `status` the bridge actually needs. See stateFile.ts `optionalUrl`.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateFileSchema, readStateFileDetailed, stateFilePathOf } from "./stateFile.js";

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

describe("StateFileSchema — response_surface prototype declaration", () => {
  it("parses a card response surface declaration without changing legacy fields", () => {
    const r = StateFileSchema.safeParse({
      status: "ready",
      last_message: "still rendered by the legacy card path",
      response_surface: {
        mode: "card",
        primary: "card",
        card: {
          compact: false,
          capabilities: ["choices", "content_blocks"],
        },
      },
      updated_at: "2026-06-26T09:00:00.000Z",
    });

    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.last_message).toBe("still rendered by the legacy card path");
      expect(r.data.response_surface).toEqual({
        mode: "card",
        primary: "card",
        card: {
          compact: false,
          capabilities: ["choices", "content_blocks"],
        },
      });
    }
  });

  it("parses a hybrid declaration with post mentions and compact card metadata", () => {
    const r = StateFileSchema.safeParse({
      status: "ready",
      response_surface: {
        mode: "hybrid",
        primary: "post",
        post: {
          mentions: [{ user_id: "ou_peer", label: "Peer bot" }],
        },
        card: {
          compact: true,
          capabilities: ["audit", "fallback"],
        },
      },
      updated_at: "2026-06-26T09:00:00.000Z",
    });

    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.response_surface?.post?.mentions).toEqual([
        { user_id: "ou_peer", label: "Peer bot" },
      ]);
      expect(r.data.response_surface?.card?.compact).toBe(true);
    }
  });

  it("defaults a mode-less response_surface to card so peer mentions survive", () => {
    const r = StateFileSchema.safeParse({
      status: "ready",
      last_message: "handoff",
      response_surface: {
        post: {
          mentions: [{ user_id: "peer_test", label: "Peer" }],
        },
      },
      updated_at: "2026-06-26T09:00:00.000Z",
    });

    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.response_surface).toEqual({
        mode: "card",
        post: {
          mentions: [{ user_id: "peer_test", label: "Peer" }],
        },
      });
    }
  });

  it("soft-fails malformed response_surface so status is still usable", () => {
    const r = StateFileSchema.safeParse({
      status: "ready",
      last_message: "must survive a bad prototype field",
      response_surface: {
        mode: "card",
        primary: "post",
      },
      updated_at: "2026-06-26T09:00:00.000Z",
    });

    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.status).toBe("ready");
      expect(r.data.last_message).toBe("must survive a bad prototype field");
      expect(r.data.response_surface).toBeUndefined();
    }
  });

  it("keeps response_surface soft-fail separate from strict final-card fields", () => {
    const soft = StateFileSchema.safeParse({
      status: "ready",
      last_message: "bad prototype should not drop the answer",
      response_surface: {
        post: {
          mentions: [{ user_id: "bad<script>", label: "Bad" }],
        },
      },
      updated_at: "2026-06-26T09:00:00.000Z",
    });
    expect(soft.success).toBe(true);
    if (soft.success) {
      expect(soft.data.status).toBe("ready");
      expect(soft.data.response_surface).toBeUndefined();
    }

    const strict = StateFileSchema.safeParse({
      status: "ready",
      last_message: "bad choices should reject callback state",
      choices: [{ label: "Missing value", value: "" }],
      updated_at: "2026-06-26T09:00:00.000Z",
    });
    expect(strict.success).toBe(false);
  });

  it("reports diagnostics when response_surface soft-fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "larkway-state-"));
    try {
      await mkdir(join(dir, ".larkway"), { recursive: true });
      await writeFile(
        stateFilePathOf(dir),
        JSON.stringify(
          {
            status: "ready",
            last_message: "must survive a bad prototype field",
            response_surface: {
              mode: "card",
              primary: "post",
            },
            updated_at: "2026-06-26T09:00:00.000Z",
          },
          null,
          2,
        ),
        "utf8",
      );

      const result = await readStateFileDetailed(dir);
      expect(result.state?.status).toBe("ready");
      expect(result.state?.response_surface).toBeUndefined();
      expect(result.diagnostics.join("\n")).toContain("response_surface ignored");
      expect(result.diagnostics.join("\n")).toContain("primary");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("soft-fails invalid mention user_id with diagnostics instead of letting CardKit drop it later", async () => {
    const dir = await mkdtemp(join(tmpdir(), "larkway-state-"));
    try {
      await mkdir(join(dir, ".larkway"), { recursive: true });
      await writeFile(
        stateFilePathOf(dir),
        JSON.stringify(
          {
            status: "ready",
            last_message: "invalid mention id should be diagnosed",
            response_surface: {
              post: {
                mentions: [{ user_id: "bad<script>", label: "Bad" }],
              },
            },
            updated_at: "2026-06-26T09:00:00.000Z",
          },
          null,
          2,
        ),
        "utf8",
      );

      const result = await readStateFileDetailed(dir);
      expect(result.state?.status).toBe("ready");
      expect(result.state?.last_message).toBe("invalid mention id should be diagnosed");
      expect(result.state?.response_surface).toBeUndefined();
      expect(result.diagnostics.join("\n")).toContain("response_surface ignored");
      expect(result.diagnostics.join("\n")).toContain("post.mentions.0.user_id");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

describe("StateFileSchema — V2 content blocks (ordered card body)", () => {
  it("parses ordered markdown/image content_blocks and fills image defaults", () => {
    const r = StateFileSchema.safeParse({
      status: "ready",
      last_message: "legacy fallback",
      image_blocks: [{ img_key: "img_v3_legacy" }],
      content_blocks: [
        { type: "markdown", content: "正文 1" },
        { type: "image", img_key: "img_v3_001" },
        { type: "markdown", content: "正文 2" },
        {
          type: "image",
          img_key: "img_v3_002",
          alt: "第二张图",
          title: "图 2",
          mode: "crop_center",
          preview: false,
        },
      ],
      updated_at: "2026-06-25T10:00:00Z",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.content_blocks).toEqual([
        { type: "markdown", content: "正文 1" },
        {
          type: "image",
          img_key: "img_v3_001",
          alt: "图片预览",
          mode: "fit_horizontal",
          preview: true,
        },
        { type: "markdown", content: "正文 2" },
        {
          type: "image",
          img_key: "img_v3_002",
          alt: "第二张图",
          title: "图 2",
          mode: "crop_center",
          preview: false,
        },
      ]);
      // Schema preserves legacy fields; renderer owns precedence.
      expect(r.data.last_message).toBe("legacy fallback");
      expect(r.data.image_blocks?.[0]?.img_key).toBe("img_v3_legacy");
    }
  });

  it("rejects unsupported content block types instead of exposing raw card JSON", () => {
    const r = StateFileSchema.safeParse({
      status: "ready",
      content_blocks: [
        { type: "raw_card_json", elements: [{ tag: "markdown", content: "x" }] },
      ],
      updated_at: "x",
    });
    expect(r.success).toBe(false);
  });

  it("rejects malformed markdown/image content blocks", () => {
    expect(
      StateFileSchema.safeParse({
        status: "ready",
        content_blocks: [{ type: "markdown", content: "" }],
        updated_at: "x",
      }).success,
    ).toBe(false);

    expect(
      StateFileSchema.safeParse({
        status: "ready",
        content_blocks: [{ type: "image", alt: "missing key" }],
        updated_at: "x",
      }).success,
    ).toBe(false);
  });

  it("caps content block count and image count", () => {
    const thirteen = Array.from({ length: 13 }, (_, i) => ({
      type: "markdown",
      content: `block ${i}`,
    }));
    expect(
      StateFileSchema.safeParse({
        status: "ready",
        content_blocks: thirteen,
        updated_at: "x",
      }).success,
    ).toBe(false);

    const fiveImages = Array.from({ length: 5 }, (_, i) => ({
      type: "image",
      img_key: `img_v3_${i}`,
    }));
    expect(
      StateFileSchema.safeParse({
        status: "ready",
        content_blocks: fiveImages,
        updated_at: "x",
      }).success,
    ).toBe(false);
  });

  it("accepts the scheduled social review-card path: platform markdown followed by matching images", () => {
    const r = StateFileSchema.safeParse({
      status: "ready",
      last_message: "legacy fallback for old renderers",
      image_blocks: [{ img_key: "img_v3_legacy_tail" }],
      content_blocks: [
        { type: "markdown", content: "**Jike**\n\n平台正文 A" },
        { type: "image", img_key: "img_v3_jike", alt: "Jike 配图" },
        { type: "markdown", content: "**X**\n\nPlatform copy B" },
        { type: "image", img_key: "img_v3_x", alt: "X 配图", mode: "crop_center" },
        { type: "markdown", content: "**小红书**\n\n平台正文 C\n\n#话题" },
        { type: "image", img_key: "img_v3_xhs", alt: "小红书配图" },
      ],
      choices: [{ label: "转 Turing 重审", value: "请转 Turing 重审这个 review card" }],
      updated_at: "2026-06-26T00:00:00.000Z",
    });

    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.last_message).toBe("legacy fallback for old renderers");
      expect(r.data.image_blocks?.[0]?.img_key).toBe("img_v3_legacy_tail");
      expect(r.data.content_blocks?.map((block) => block.type)).toEqual([
        "markdown",
        "image",
        "markdown",
        "image",
        "markdown",
        "image",
      ]);
      expect(r.data.content_blocks?.filter((block) => block.type === "image")).toHaveLength(3);
      expect(r.data.choices?.[0]?.value).toBe("请转 Turing 重审这个 review card");
    }
  });
});
