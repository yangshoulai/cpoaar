import assert from "node:assert/strict";
import test from "node:test";

import {
  runFindEmailVerificationCodeInput,
  runOneTimeCodeLoginButtonAction
} from "../src/nodes/reauthorizeHelpers.js";

const codeInputSelectors = [
  "input[name='code']",
  "input[type='code']",
  "input[autocomplete='one-time-code']",
  "input[placeholder='Code']",
  "input[aria-label='Code']"
];

test("验证码页优先被识别，密码切换操作不会误报失败", () => {
  const codeInput = createElement({ tagName: "INPUT", name: "code", placeholder: "Code" });
  withDocument({ codeInput }, () => {
    const found = runFindEmailVerificationCodeInput(codeInputSelectors);
    const result = runOneTimeCodeLoginButtonAction("click", ["one-time code"], codeInputSelectors);

    assert.equal(found.selector, "input[name='code']");
    assert.equal(result.state, "code_input");
    assert.equal(result.codeInput.selector, "input[name='code']");
  });
});

test("仅通过 Code placeholder 暴露的验证码输入框也可识别", () => {
  const codeInput = createElement({ tagName: "INPUT", placeholder: "Code" });
  withDocument({ codeInput }, () => {
    const found = runFindEmailVerificationCodeInput(codeInputSelectors);

    assert.equal(found.selector, "input[placeholder='Code']");
  });
});

test("密码页只点击明确的一次性验证码入口", () => {
  const passwordInput = createElement({ tagName: "INPUT", name: "current-password" });
  const passwordButton = createElement({ tagName: "BUTTON", name: "intent", text: "Continue with password" });
  const codeButton = createElement({ tagName: "BUTTON", name: "intent", text: "Use a one-time code" });
  withDocument({ passwordInput, buttons: [passwordButton, codeButton] }, () => {
    const result = runOneTimeCodeLoginButtonAction("click", ["one-time code"], codeInputSelectors);

    assert.equal(result.state, "clicked");
    assert.equal(result.button.text, "Use a one-time code");
    assert.equal(passwordButton.clickCount, 0);
    assert.equal(codeButton.clickCount, 1);
  });
});

test("密码页没有验证码入口时不点击任意 intent 按钮", () => {
  const passwordInput = createElement({ tagName: "INPUT", name: "current-password" });
  const passwordButton = createElement({ tagName: "BUTTON", name: "intent", text: "Continue with password" });
  withDocument({ passwordInput, buttons: [passwordButton] }, () => {
    const result = runOneTimeCodeLoginButtonAction("click", ["one-time code"], codeInputSelectors);

    assert.equal(result, null);
    assert.equal(passwordButton.clickCount, 0);
  });
});

function withDocument({ codeInput = null, passwordInput = null, buttons = [] }, callback) {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  globalThis.window = {
    getComputedStyle: () => ({ visibility: "visible", display: "block" })
  };
  globalThis.document = {
    querySelector(selector) {
      if (selector === "input[name='current-password']") {
        return passwordInput;
      }
      if (codeInput && matchesCodeInputSelector(codeInput, selector)) {
        return codeInput;
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'button[name="intent"]' ? buttons : [];
    }
  };
  try {
    callback();
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
}

function matchesCodeInputSelector(input, selector) {
  if (selector === "input[name='code']") {
    return input.getAttribute("name") === "code";
  }
  if (selector === "input[type='code']") {
    return input.getAttribute("type") === "code";
  }
  if (selector === "input[autocomplete='one-time-code']") {
    return input.getAttribute("autocomplete") === "one-time-code";
  }
  if (selector === "input[placeholder='Code']") {
    return input.getAttribute("placeholder") === "Code";
  }
  return selector === "input[aria-label='Code']" && input.getAttribute("aria-label") === "Code";
}

function createElement({ tagName, name = "", type = "", autocomplete = "", placeholder = "", ariaLabel = "", text = "" }) {
  return {
    tagName,
    textContent: text,
    value: "",
    id: "",
    disabled: false,
    clickCount: 0,
    getAttribute(attribute) {
      if (attribute === "name") {
        return name;
      }
      if (attribute === "placeholder") {
        return placeholder;
      }
      if (attribute === "type") {
        return type;
      }
      if (attribute === "autocomplete") {
        return autocomplete;
      }
      if (attribute === "aria-label") {
        return ariaLabel;
      }
      return "";
    },
    getClientRects() {
      return [{}];
    },
    scrollIntoView() {},
    click() {
      this.clickCount += 1;
    }
  };
}
