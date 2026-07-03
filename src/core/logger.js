import { loadLogs, saveLogs } from "./storage.js";

const MAX_LOGS = 800;
let logWriteQueue = Promise.resolve();

export class Logger {
  constructor(source = "app") {
    this.source = source;
  }

  debug(message, data) {
    return appendLog("DEBUG", this.source, message, data);
  }

  info(message, data) {
    return appendLog("INFO", this.source, message, data);
  }

  warn(message, data) {
    return appendLog("WARN", this.source, message, data);
  }

  error(message, data) {
    return appendLog("ERROR", this.source, message, data);
  }
}

export function createLogger(source) {
  return new Logger(source);
}

export function appendLog(level, source, message, data = null) {
  const entry = {
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    level,
    source,
    message,
    data
  };
  const writeTask = logWriteQueue.catch(() => {}).then(async () => {
    const logs = await loadLogs();
    logs.push(entry);
    const nextLogs = logs.slice(-MAX_LOGS);
    await saveLogs(nextLogs);
    emitLog(entry);
    return entry;
  });
  logWriteQueue = writeTask;
  return writeTask;
}

function emitLog(entry) {
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent("auto-register-log-entry", {
      detail: entry
    }));
  }
  chrome.runtime.sendMessage({ type: "auto-register-log", entry }).catch(() => {});
}
