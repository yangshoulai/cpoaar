import { createLogger } from "./logger.js";
import { loadSnapshot, saveSnapshot } from "./storage.js";

const logger = createLogger("flow");

export class NodeResult {
  constructor({ success, status, data = {}, error = "" }) {
    this.success = success;
    this.status = status;
    this.data = data;
    this.error = error;
  }

  static ok(status = "success", data = {}) {
    return new NodeResult({ success: true, status, data });
  }

  static fail(status = "failed", error = "", data = {}) {
    return new NodeResult({ success: false, status, error, data });
  }
}

export class RegisterNode {
  constructor(name, title, options = {}) {
    this.name = name;
    this.title = title;
    this.retryPolicy = {
      maxAttempts: 1,
      intervalMs: 0,
      retryableStatuses: null,
      ...(options.retryPolicy || {})
    };
  }

  async execute() {
    throw new Error(`节点未实现: ${this.name}`);
  }
}

export class RegisterFlow {
  constructor({ startNode, nodes, transitions }) {
    this.startNode = startNode;
    this.nodes = nodes;
    this.transitions = transitions;
  }

  getNode(name) {
    const node = this.nodes[name];
    if (!node) {
      throw new Error(`注册节点不存在: ${name}`);
    }
    return node;
  }

  findNextNode(nodeName, result) {
    const transitions = this.transitions[nodeName] || [];
    const matched = transitions.find((transition) => transition.status === result.status);
    return matched?.target || null;
  }
}

export class FlowRunner {
  constructor(flow, ctx, onUpdate) {
    this.flow = flow;
    this.ctx = ctx;
    this.onUpdate = onUpdate || (() => {});
    this.stopped = false;
    this.abortController = new AbortController();
    this.ctx.signal = this.abortController.signal;
    this.ctx.isStopped = () => this.stopped || this.abortController.signal.aborted;
  }

  stop() {
    this.stopped = true;
    if (!this.abortController.signal.aborted) {
      this.abortController.abort();
    }
  }

  async run(startNode = null) {
    let currentNode = startNode || this.flow.startNode;
    this.ctx.snapshot.currentNode = currentNode;
    this.ctx.snapshot.startedAt = this.ctx.snapshot.startedAt || new Date().toISOString();
    await this._publish();

    while (currentNode && !this.stopped) {
      const node = this.flow.getNode(currentNode);
      let result = await this._executeNodeWithRetry(node);
      if (this.stopped && result.status !== "stopped") {
        result = buildFlowStoppedResult();
      }
      Object.assign(this.ctx.state, result.data || {});
      await this._recordNodeResult(node, result);

      if (this.stopped || result.status === "stopped") {
        const stoppedResult = NodeResult.fail("stopped", "流程已停止");
        this.ctx.snapshot.status = "stopped";
        this.ctx.snapshot.error = stoppedResult.error;
        await this._publish();
        return stoppedResult;
      }

      if (!result.success) {
        this.ctx.snapshot.status = "failed";
        this.ctx.snapshot.error = result.error;
        await this._publish();
        return result;
      }

      const nextNode = this.flow.findNextNode(currentNode, result);
      if (!nextNode) {
        this.ctx.snapshot.status = "success";
        this.ctx.snapshot.currentNode = currentNode;
        await this._publish();
        logger.info("注册流程执行完成");
        return result;
      }

      logger.info("节点流转", {
        from: currentNode,
        status: result.status,
        to: nextNode
      });
      currentNode = nextNode;
      this.ctx.snapshot.currentNode = currentNode;
      await this._publish();
    }

    const stoppedResult = NodeResult.fail("stopped", "流程已停止");
    this.ctx.snapshot.status = "stopped";
    this.ctx.snapshot.error = stoppedResult.error;
    await this._publish();
    return stoppedResult;
  }

  async _executeNodeWithRetry(node) {
    const policy = node.retryPolicy;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      this.ctx.snapshot.currentNode = node.name;
      this.ctx.snapshot.status = "running";
      this.ctx.snapshot.nodeStarts[node.name] = {
        url: await this.ctx.tabs.getCurrentUrlIfAvailable().catch(() => ""),
        at: new Date().toISOString()
      };
      this.ctx.snapshot.nodeResults[node.name] = {
        status: "running",
        attempt,
        title: node.title
      };
      await this._publish();
      logger.info("节点执行开始", { node: node.name, attempt, maxAttempts: policy.maxAttempts });

      let result;
      try {
        if (this.stopped || this.ctx.signal?.aborted) {
          result = buildFlowStoppedResult();
        } else {
          result = await node.execute(this.ctx);
        }
      } catch (error) {
        result = this.stopped || this.ctx.signal?.aborted
          ? buildFlowStoppedResult()
          : NodeResult.fail("exception", formatExecutionError(error));
      }

      logger[result.success ? "info" : "warn"]("节点执行结束", {
        node: node.name,
        attempt,
        status: result.status,
        error: result.error || ""
      });

      if (result.success || attempt >= policy.maxAttempts || !canRetry(policy, result)) {
        return result;
      }
      if (policy.intervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, policy.intervalMs));
      }
    }
    return NodeResult.fail("failed", `节点没有产生结果: ${node.name}`);
  }

  async _recordNodeResult(node, result) {
    this.ctx.snapshot.nodeResults[node.name] = {
      title: node.title,
      status: result.status === "stopped" ? "stopped" : result.success ? "success" : "failed",
      resultStatus: result.status,
      error: result.error || "",
      at: new Date().toISOString()
    };
  }

  async _publish() {
    this.ctx.snapshot.tabId = this.ctx.tabs.currentTabId || null;
    this.ctx.snapshot.state = sanitizeState(this.ctx.state);
    await saveSnapshot(this.ctx.snapshot);
    this.onUpdate(this.ctx.snapshot);
    chrome.runtime.sendMessage({ type: "auto-register-snapshot", snapshot: this.ctx.snapshot }).catch(() => {});
  }
}

export function isFlowStopped(ctx) {
  return ctx?.signal?.aborted === true || ctx?.isStopped?.() === true;
}

export function buildFlowStoppedResult() {
  return NodeResult.fail("stopped", "流程已停止");
}

export async function createInitialSnapshot(flow) {
  const previous = await loadSnapshot();
  return previous || {
    status: "idle",
    currentNode: flow.startNode,
    nodeResults: {},
    nodeStarts: {},
    state: {},
    startedAt: "",
    error: ""
  };
}

function canRetry(policy, result) {
  if (!policy.retryableStatuses) {
    return true;
  }
  return policy.retryableStatuses.includes(result.status);
}

function sanitizeState(state) {
  return JSON.parse(JSON.stringify(state, (_key, value) => {
    if (typeof value === "function") {
      return undefined;
    }
    return value;
  }));
}

function formatExecutionError(error) {
  const message = `${error.name}: ${error.message}`;
  if (error.url) {
    return `${message}；URL=${error.url}`;
  }
  return message;
}
