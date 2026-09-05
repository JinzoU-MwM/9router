import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const BUDGET_PERIODS = new Set(["lifetime", "daily", "monthly"]);

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    limits: parseJson(row.limits, null),
  };
}

function limitsToCol(limits) {
  return limits ? stringifyJson(limits) : null;
}

function positiveIntOrNull(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid ${field}`);
  return n === 0 ? null : n;
}

/**
 * Validate + canonicalize a limits payload from the dashboard.
 * Returns null when nothing is set (stored as SQL NULL). Throws Error("Invalid <field>") on bad input.
 */
export function normalizeLimits(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid limits");

  const rawModels = input.allowedModels ?? [];
  if (!Array.isArray(rawModels) || rawModels.some((m) => typeof m !== "string")) throw new Error("Invalid allowedModels");
  const allowedModels = [...new Set(rawModels.map((m) => m.trim()).filter(Boolean))];

  const rpm = positiveIntOrNull(input.rpm, "rpm");
  const tpm = positiveIntOrNull(input.tpm, "tpm");
  const tokenBudget = positiveIntOrNull(input.tokenBudget, "tokenBudget");

  const budgetPeriod = input.budgetPeriod || "lifetime";
  if (!BUDGET_PERIODS.has(budgetPeriod)) throw new Error("Invalid budgetPeriod");

  let expiresAt = null;
  if (input.expiresAt) {
    if (typeof input.expiresAt !== "string" || Number.isNaN(Date.parse(input.expiresAt))) throw new Error("Invalid expiresAt");
    expiresAt = input.expiresAt;
  }

  if (!allowedModels.length && rpm == null && tpm == null && tokenBudget == null && !expiresAt) return null;
  return { allowedModels, rpm, tpm, tokenBudget, budgetPeriod, expiresAt };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, limits = null) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
    limits: limits || null,
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt, limits) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.createdAt, limitsToCol(apiKey.limits)]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    if (!merged.limits) merged.limits = null;
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, limits = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, limitsToCol(merged.limits), id]
    );
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
