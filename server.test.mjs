
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

let serverProcess;
let baseUrl;

async function getFreePort() {
  const probe = createServer();

  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });

  const port = probe.address().port;

  await new Promise((resolve, reject) => {
    probe.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  return port;
}

before(async () => {
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;

  serverProcess = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });

  for (let attempt = 0; attempt < 50; attempt++) {
    if (serverProcess.exitCode !== null) {
      throw new Error("Тестовый сервер завершился до запуска");
    }

    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Сервер ещё запускается
    }

    await delay(100);
  }

  throw new Error("Не удалось запустить тестовый сервер");
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => serverProcess.once("exit", resolve));
  }
});

async function post(text) {
  return fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

async function assertManualReview(response) {
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(data, {
    status: "manual_review",
    topic: null,
    draft: null,
  });
}

test("успешно классифицирует заявку", async () => {
  const response = await post("Хочу узнать стоимость доставки");
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.status, "ready");
  assert.equal(data.topic, "pricing");
  assert.ok(data.draft.trim());
});

test("отклоняет пустую заявку", async () => {
  const response = await post("   ");
  const data = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(data, { status: "invalid_input" });
});

test("отклоняет заявку без поля text", async () => {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { status: "invalid_input" });
});

test("отклоняет нестроковый text", async () => {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: 123 }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { status: "invalid_input" });
});

test("отклоняет некорректный JSON запроса", async () => {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"text":',
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { status: "invalid_input" });
});

test("передаёт заявку менеджеру при ошибке AI", async () => {
  await assertManualReview(await post("[error] Не могу оформить заявку"));
});

test("передаёт заявку менеджеру при некорректном JSON от AI", async () => {
  await assertManualReview(await post("[bad-json] Не могу оформить заявку"));
});

test("передаёт заявку менеджеру при неизвестной теме AI", async () => {
  await assertManualReview(await post("[bad-topic] Не могу оформить заявку"));
});

test("передаёт заявку менеджеру при пустом черновике AI", async () => {
  await assertManualReview(await post("[empty-draft] Не могу оформить заявку"));
});

test("передаёт заявку менеджеру при таймауте AI", async () => {
  const startedAt = Date.now();

  await assertManualReview(await post("[timeout] Не могу оформить заявку"));

  assert.ok(Date.now() - startedAt < 800, "Ответ должен прийти примерно за 300 мс");
});
