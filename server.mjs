import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

const AI_TIMEOUT = 300;
const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);

function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function invalidInput(response) {
  return json(response, 400, { status: "invalid_input" });
}

function manualReview(response) {
  return json(response, 200, {
    status: "manual_review",
    topic: null,
    draft: null,
  });
}

async function handleTriage(request, response) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  let body;

  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return invalidInput(response);
  }

  const text = body?.text;

  if (typeof text !== "string" || !text.trim()) {
    return invalidInput(response);
  }

  const controller = new AbortController();
  let timeoutId;

  let rawResult;

  try {
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error("AI_TIMEOUT");
        error.code = "AI_TIMEOUT";
        reject(error);
        controller.abort();
      }, AI_TIMEOUT);
    });

    rawResult = await Promise.race([
      classify(text.trim(), { signal: controller.signal }),
      timeout,
    ]);
  } catch {
    return manualReview(response);
  } finally {
    clearTimeout(timeoutId);
  }

  let result;

  try {
    result = JSON.parse(rawResult);
  } catch {
    return manualReview(response);
  }

  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !ALLOWED_TOPICS.has(result.topic) ||
    typeof result.draft !== "string" ||
    !result.draft.trim()
  ) {
    return manualReview(response);
  }

  return json(response, 200, {
    status: "ready",
    topic: result.topic,
    draft: result.draft.trim(),
  });
}

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
    });
    response.end(html);
    return;
  }

  if (request.method !== "POST" || request.url !== "/api/triage") {
    return json(response, 404, { status: "not_found" });
  }

  try {
    await handleTriage(request, response);
  } catch {
    if (!response.headersSent) {
      json(response, 500, { status: "server_error" });
    }
  }
}).listen(Number(process.env.PORT || 3000), "0.0.0.0");
