import { DEFAULT_CONFIG, normalizeConfig } from "./config.js";
import { ACCOUNT_TYPES, RUN_MODES, getAccountTypeByMode, normalizeAccountType, normalizeRunMode } from "./runModes.js";

export const STORAGE_KEYS = Object.freeze({
  config: "autoRegister.config",
  logs: "autoRegister.logs",
  outlookMailAuth: "autoRegister.outlookMailAuth",
  outlookGroups: "autoRegister.outlookGroups",
  registerHistory: "autoRegister.registerHistory",
  snapshot: "autoRegister.snapshot"
});

export async function loadConfig() {
  const values = await chrome.storage.local.get(STORAGE_KEYS.config);
  return normalizeConfig(values[STORAGE_KEYS.config] || DEFAULT_CONFIG);
}

export async function saveConfig(config) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.config]: normalizeConfig(config)
  });
}

export async function loadLogs() {
  const values = await chrome.storage.local.get(STORAGE_KEYS.logs);
  return values[STORAGE_KEYS.logs] || [];
}

export async function saveLogs(logs) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.logs]: logs
  });
}

export async function clearLogs() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.logs]: []
  });
}

export async function loadOutlookMailAuthCache() {
  const values = await chrome.storage.local.get(STORAGE_KEYS.outlookMailAuth);
  return values[STORAGE_KEYS.outlookMailAuth] || null;
}

export async function saveOutlookMailAuthCache(cache) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.outlookMailAuth]: cache || null
  });
}

export async function clearOutlookMailAuthCache() {
  await chrome.storage.local.remove(STORAGE_KEYS.outlookMailAuth);
}

export async function loadRegisterHistory() {
  const values = await chrome.storage.local.get(STORAGE_KEYS.registerHistory);
  return normalizeRegisterHistory(values[STORAGE_KEYS.registerHistory]);
}

export async function saveRegisterHistory(history) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.registerHistory]: normalizeRegisterHistory(history)
  });
}

export async function appendRegisterHistory(record) {
  const history = await loadRegisterHistory();
  const nextHistory = [
    {
      id: crypto.randomUUID(),
      registeredAt: new Date().toISOString(),
      ...record
    },
    ...history
  ].slice(0, 500);
  await saveRegisterHistory(nextHistory);
  return nextHistory[0];
}

export async function deleteRegisterHistory(id) {
  const history = await loadRegisterHistory();
  const nextHistory = history.filter((record) => record.id !== id);
  await saveRegisterHistory(nextHistory);
  return nextHistory;
}

export async function loadOutlookGroups() {
  const values = await chrome.storage.local.get(STORAGE_KEYS.outlookGroups);
  return values[STORAGE_KEYS.outlookGroups] || [];
}

export async function saveOutlookGroups(groups) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.outlookGroups]: groups || []
  });
}

export async function loadSnapshot() {
  const values = await chrome.storage.local.get(STORAGE_KEYS.snapshot);
  return values[STORAGE_KEYS.snapshot] || null;
}

export async function saveSnapshot(snapshot) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.snapshot]: snapshot
  });
}

export async function clearSnapshot() {
  await chrome.storage.local.remove(STORAGE_KEYS.snapshot);
}

function normalizeRegisterHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }
  return history.map(normalizeRegisterHistoryRecord);
}

function normalizeRegisterHistoryRecord(record) {
  const source = record || {};
  const flowMode = normalizeRunMode(
    source.flowMode
    || source.registerMode
    || (source.accountType === ACCOUNT_TYPES.grok ? RUN_MODES.grokRegister : RUN_MODES.openaiRegister)
  );
  const accountType = normalizeAccountType(source.accountType || getAccountTypeByMode(flowMode));
  return {
    ...source,
    accountType,
    flowMode
  };
}
