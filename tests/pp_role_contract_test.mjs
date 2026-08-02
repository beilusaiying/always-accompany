import assert from "node:assert/strict";

import {
  mergeConsecutiveRoles,
  postProcessMessages,
} from "../src/yonban/core/functions/api/proxy/lib/messageTransform.mjs";
import {
  adaptForProvider,
  PROVIDER_META,
} from "../src/yonban/core/functions/api/proxy/lib/apiAdapters.mjs";
import {
  fetchChatCompletion,
} from "../src/yonban/core/functions/api/proxy/lib/httpFetch.mjs";
import {
  buildGeminiModelParams,
  convertOpenAIToGeminiMessages,
} from "../src/yonban/core/functions/api/gemini/messageAdapter.mjs";

const mixedRoles = () => [
  { role: "system", content: "system-a" },
  { role: "user", content: "user-a" },
  { role: "system", content: "system-b" },
  { role: "assistant", content: "assistant-a" },
];

Deno.test("PP none keeps role order and message boundaries unchanged", () => {
  const input = mixedRoles();
  const output = postProcessMessages(input, "none");

  assert.deepEqual(output, input);
  assert.deepEqual(output.map((message) => message.role), [
    "system",
    "user",
    "system",
    "assistant",
  ]);
});

Deno.test("merge combines consecutive roles without changing role authority", () => {
  const output = mergeConsecutiveRoles([
    { role: "system", content: "system-a" },
    { role: "system", content: "system-b" },
    { role: "user", content: "user-a" },
    { role: "user", content: "user-b" },
  ]);

  assert.deepEqual(output.map((message) => message.role), ["system", "user"]);
  assert.equal(output[0].content, "system-a\n\nsystem-b");
  assert.equal(output[1].content, "user-a\n\nuser-b");
});

Deno.test("legacy semi and strict values never demote middle system", () => {
  for (const mode of ["semi", "strict"]) {
    const output = postProcessMessages(mixedRoles(), mode);
    assert.deepEqual(
      output.map((message) => message.role),
      ["system", "user", "system", "assistant"],
      `${mode} changed system authority`,
    );
  }
});

Deno.test("Gemini OpenAI-compatible adapter preserves middle system", () => {
  const { messages } = adaptForProvider(mixedRoles(), {
    provider: "gemini",
    url:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-test",
  });

  assert.deepEqual(messages.map((message) => message.role), [
    "system",
    "user",
    "system",
    "assistant",
  ]);
});

Deno.test("DeepSeek reasoner adapter preserves system role", () => {
  const { messages } = adaptForProvider([
    { role: "system", content: "system-a" },
    { role: "user", content: "user-a" },
  ], {
    provider: "deepseek-r1",
    url: "https://api.deepseek.com/chat/completions",
    model: "deepseek-reasoner",
  });

  assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
  assert.equal(messages[0].content, "system-a");
  assert.equal(messages[1].content, "user-a");
});

Deno.test("Gemini native adapter maps system to systemInstruction, not user contents", () => {
  const { contents, systemInstruction } = convertOpenAIToGeminiMessages([
    { role: "system", content: "system-a" },
    { role: "user", content: "user-a" },
    {
      role: "system",
      content: [
        { type: "text", text: "system-b" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
      ],
    },
    { role: "assistant", content: "assistant-a" },
  ], {
    imageSkippedText: "[image skipped]",
  });

  assert.equal(systemInstruction, "system-a\n\nsystem-b\n\n[image skipped]");
  assert.deepEqual(contents, [
    { role: "user", parts: [{ text: "user-a" }] },
    { role: "model", parts: [{ text: "assistant-a" }] },
  ]);
  assert.equal(
    contents.some((message) =>
      message.parts.some((part) => part.text?.startsWith("system:\n"))
    ),
    false,
  );
});

Deno.test("Gemini final SDK request keeps systemInstruction in config", () => {
  const modelParams = buildGeminiModelParams({
    model: "gemini-test",
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
    config: { temperature: 0.7 },
    systemInstruction: "authoritative-system",
  });

  assert.deepEqual(modelParams, {
    model: "gemini-test",
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
    config: {
      temperature: 0.7,
      systemInstruction: "authoritative-system",
    },
  });
});

Deno.test("Claude proxy does not advertise a nonexistent official chat-completions URL", () => {
  assert.equal(PROVIDER_META.claude.defaultUrl, "");
  assert.match(PROVIDER_META.claude.hint, /\/v1\/messages/);
});

Deno.test("proxy final HTTP body honors explicit PP none", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;

  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(String(init?.body || "{}"));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  try {
    const input = [
      { role: "system", content: "system-a" },
      { role: "user", content: "user-a" },
      { role: "user", content: "user-b" },
      { role: "system", content: "system-b" },
    ];
    const result = { content: "", files: [] };

    await fetchChatCompletion(input, {
      url: "https://api.openai.com/v1/chat/completions",
      model: "gpt-test",
      use_stream: false,
      model_arguments: {},
      convert_config: {
        provider: "openai",
        prompt_post_processing: "none",
        claude_prefill_mode: "off",
      },
    }, {
      signal: undefined,
      previewUpdater: () => {},
      result,
      _resumePrefix: "",
    });

    assert.equal(result.content, "ok");
    assert.deepEqual(requestBody.messages, input);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
