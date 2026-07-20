import { RegisterFlow } from "../core/flow.js";
import { StartupInitializeNode } from "../nodes/startupInitializeNode.js";
import { OpenChatGptTabNode } from "../nodes/openChatGptTabNode.js";
import { OpenChatGptPhoneFirstNode } from "../nodes/openChatGptPhoneFirstNode.js";
import { FillEmailAndSubmitNode } from "../nodes/fillEmailAndSubmitNode.js";
import { CreatePasswordNode } from "../nodes/createPasswordNode.js";
import { WaitEmailVerificationCodeNode } from "../nodes/waitEmailVerificationCodeNode.js";
import { FillAboutYouNode } from "../nodes/fillAboutYouNode.js";
import { SelectCodexAccountNode } from "../nodes/selectCodexAccountNode.js";
import { AddPhoneNumberNode } from "../nodes/addPhoneNumberNode.js";
import { PhoneFirstAddPhoneNumberNode } from "../nodes/phoneFirstAddPhoneNumberNode.js";
import { PhoneFirstAddEmailNode } from "../nodes/phoneFirstAddEmailNode.js";
import { WaitSmsVerificationCodeNode } from "../nodes/waitSmsVerificationCodeNode.js";
import { SubmitCodexConsentNode } from "../nodes/submitCodexConsentNode.js";
import { ReauthorizePhoneChallengeNode } from "../nodes/reauthorizePhoneChallengeNode.js";
import { ReauthorizeAccountDeletedNode } from "../nodes/reauthorizeAccountDeletedNode.js";
import { ReauthorizeDeleteAccountNode } from "../nodes/reauthorizeDeleteAccountNode.js";
import { XAiOpenSignupPageNode } from "../nodes/xaiOpenSignupPageNode.js";
import { XAiWaitEmailVerificationCodeNode } from "../nodes/xaiWaitEmailVerificationCodeNode.js";
import { XAiFillProfileNode } from "../nodes/xaiFillProfileNode.js";
import { XAiWaitRegistrationCompleteNode } from "../nodes/xaiWaitRegistrationCompleteNode.js";
import { XAiRefreshOAuthAndLoginNode } from "../nodes/xaiRefreshOAuthAndLoginNode.js";
import { XAiSubmitConsentNode } from "../nodes/xaiSubmitConsentNode.js";
import { XAiSignInNode } from "../nodes/xaiSignInNode.js";
import { RUN_MODES, isXAiRegisterMode, isXAiReauthorizeMode, isOpenAiReauthorizeMode, normalizeRunMode } from "../core/runModes.js";
import { isOpenAiPhoneFirstRegisterFlow } from "../core/openAiRegisterFlows.js";

export function buildRegisterFlow(mode = RUN_MODES.openaiRegister, options = {}) {
  const runMode = normalizeRunMode(mode);
  if (isOpenAiReauthorizeMode(runMode)) {
    return buildReauthorizeFlow();
  }
  if (isXAiRegisterMode(runMode)) {
    return buildXAiRegisterFlow();
  }
  if (isXAiReauthorizeMode(runMode)) {
    return buildXAiReauthorizeFlow();
  }
  if (isOpenAiPhoneFirstRegisterFlow(options.openAiRegisterFlow)) {
    return buildPhoneFirstRegisterFlow();
  }
  return buildEmailRegisterFlow();
}

function buildEmailRegisterFlow() {
  const nodes = [
    new StartupInitializeNode(),
    new OpenChatGptTabNode(),
    new FillEmailAndSubmitNode(),
    new CreatePasswordNode(),
    new WaitEmailVerificationCodeNode(),
    new FillAboutYouNode(),
    new SelectCodexAccountNode(),
    new AddPhoneNumberNode(),
    new WaitSmsVerificationCodeNode(),
    new SubmitCodexConsentNode()
  ];
  return new RegisterFlow({
    startNode: StartupInitializeNode.name,
    nodes: Object.fromEntries(nodes.map((node) => [node.name, node])),
    transitions: {
      [StartupInitializeNode.name]: [
        { status: StartupInitializeNode.statuses.success, target: OpenChatGptTabNode.name }
      ],
      [OpenChatGptTabNode.name]: [
        { status: OpenChatGptTabNode.statuses.success, target: FillEmailAndSubmitNode.name }
      ],
      [FillEmailAndSubmitNode.name]: [
        { status: FillEmailAndSubmitNode.statuses.success, target: WaitEmailVerificationCodeNode.name },
        { status: FillEmailAndSubmitNode.statuses.smsReady, target: WaitSmsVerificationCodeNode.name },
        { status: FillEmailAndSubmitNode.statuses.createPasswordReady, target: CreatePasswordNode.name }
      ],
      [CreatePasswordNode.name]: [
        { status: CreatePasswordNode.statuses.success, target: WaitEmailVerificationCodeNode.name },
        { status: CreatePasswordNode.statuses.aboutYouReady, target: FillAboutYouNode.name }
      ],
      [WaitEmailVerificationCodeNode.name]: [
        { status: WaitEmailVerificationCodeNode.statuses.retryCurrent, target: WaitEmailVerificationCodeNode.name },
        { status: WaitEmailVerificationCodeNode.statuses.success, target: FillAboutYouNode.name },
        { status: WaitEmailVerificationCodeNode.statuses.chatgptReady, target: SelectCodexAccountNode.name },
        { status: WaitEmailVerificationCodeNode.statuses.needsPhone, target: AddPhoneNumberNode.name },
        { status: WaitEmailVerificationCodeNode.statuses.consent, target: SubmitCodexConsentNode.name }
      ],
      [FillAboutYouNode.name]: [
        { status: FillAboutYouNode.statuses.success, target: SelectCodexAccountNode.name },
        { status: FillAboutYouNode.statuses.retryFillEmail, target: FillEmailAndSubmitNode.name }
      ],
      [SelectCodexAccountNode.name]: [
        { status: SelectCodexAccountNode.statuses.emailVerificationReady, target: WaitEmailVerificationCodeNode.name },
        { status: SelectCodexAccountNode.statuses.needsPhone, target: AddPhoneNumberNode.name },
        { status: SelectCodexAccountNode.statuses.consent, target: SubmitCodexConsentNode.name }
      ],
      [AddPhoneNumberNode.name]: [
        { status: AddPhoneNumberNode.statuses.oauthReauthRequired, target: SelectCodexAccountNode.name },
        { status: AddPhoneNumberNode.statuses.success, target: WaitSmsVerificationCodeNode.name }
      ],
      [WaitSmsVerificationCodeNode.name]: [
        { status: WaitSmsVerificationCodeNode.statuses.retrySelectCodexAccount, target: SelectCodexAccountNode.name },
        { status: WaitSmsVerificationCodeNode.statuses.success, target: SubmitCodexConsentNode.name }
      ]
    }
  });
}

function buildReauthorizeFlow() {
  const nodes = [
    new StartupInitializeNode(),
    new SelectCodexAccountNode(),
    new WaitEmailVerificationCodeNode(),
    new ReauthorizePhoneChallengeNode(),
    new ReauthorizeAccountDeletedNode(),
    new ReauthorizeDeleteAccountNode(),
    new SubmitCodexConsentNode()
  ];
  return new RegisterFlow({
    startNode: StartupInitializeNode.name,
    nodes: Object.fromEntries(nodes.map((node) => [node.name, node])),
    transitions: {
      [StartupInitializeNode.name]: [
        { status: StartupInitializeNode.statuses.success, target: SelectCodexAccountNode.name }
      ],
      [SelectCodexAccountNode.name]: [
        { status: SelectCodexAccountNode.statuses.emailVerificationReady, target: WaitEmailVerificationCodeNode.name },
        { status: SelectCodexAccountNode.statuses.needsPhone, target: ReauthorizePhoneChallengeNode.name },
        { status: SelectCodexAccountNode.statuses.accountDeleted, target: ReauthorizeAccountDeletedNode.name },
        { status: SelectCodexAccountNode.statuses.consent, target: SubmitCodexConsentNode.name }
      ],
      [WaitEmailVerificationCodeNode.name]: [
        { status: WaitEmailVerificationCodeNode.statuses.retryCurrent, target: WaitEmailVerificationCodeNode.name },
        { status: WaitEmailVerificationCodeNode.statuses.needsPhone, target: ReauthorizePhoneChallengeNode.name },
        { status: WaitEmailVerificationCodeNode.statuses.accountDeleted, target: ReauthorizeAccountDeletedNode.name },
        { status: WaitEmailVerificationCodeNode.statuses.consent, target: SubmitCodexConsentNode.name }
      ],
      [ReauthorizePhoneChallengeNode.name]: [
        { status: ReauthorizePhoneChallengeNode.statuses.deleteAccount, target: ReauthorizeDeleteAccountNode.name },
        { status: ReauthorizePhoneChallengeNode.statuses.accountDeleted, target: ReauthorizeAccountDeletedNode.name },
        { status: ReauthorizePhoneChallengeNode.statuses.consent, target: SubmitCodexConsentNode.name }
      ],
      [ReauthorizeAccountDeletedNode.name]: [
        { status: ReauthorizeAccountDeletedNode.statuses.deleteAccount, target: ReauthorizeDeleteAccountNode.name }
      ]
    }
  });
}

function buildPhoneFirstRegisterFlow() {
  const nodes = [
    new StartupInitializeNode(),
    new OpenChatGptPhoneFirstNode(),
    new PhoneFirstAddPhoneNumberNode(),
    new CreatePasswordNode(),
    new WaitSmsVerificationCodeNode(),
    new FillAboutYouNode(),
    new SelectCodexAccountNode(),
    new PhoneFirstAddEmailNode(),
    new WaitEmailVerificationCodeNode(),
    new SubmitCodexConsentNode()
  ];
  return new RegisterFlow({
    startNode: StartupInitializeNode.name,
    nodes: Object.fromEntries(nodes.map((node) => [node.name, node])),
    transitions: {
      [StartupInitializeNode.name]: [
        { status: StartupInitializeNode.statuses.success, target: OpenChatGptPhoneFirstNode.name }
      ],
      [OpenChatGptPhoneFirstNode.name]: [
        { status: OpenChatGptPhoneFirstNode.statuses.success, target: PhoneFirstAddPhoneNumberNode.name }
      ],
      [PhoneFirstAddPhoneNumberNode.name]: [
        { status: PhoneFirstAddPhoneNumberNode.statuses.success, target: CreatePasswordNode.name }
      ],
      [CreatePasswordNode.name]: [
        { status: CreatePasswordNode.statuses.retryStartup, target: StartupInitializeNode.name },
        { status: CreatePasswordNode.statuses.phoneVerificationReady, target: WaitSmsVerificationCodeNode.name },
        { status: CreatePasswordNode.statuses.aboutYouReady, target: FillAboutYouNode.name }
      ],
      [WaitSmsVerificationCodeNode.name]: [
        { status: WaitSmsVerificationCodeNode.statuses.retryStartup, target: StartupInitializeNode.name },
        { status: WaitSmsVerificationCodeNode.statuses.retrySelectCodexAccount, target: StartupInitializeNode.name },
        { status: WaitSmsVerificationCodeNode.statuses.success, target: SubmitCodexConsentNode.name },
        { status: WaitSmsVerificationCodeNode.statuses.aboutYouReady, target: FillAboutYouNode.name }
      ],
      [FillAboutYouNode.name]: [
        { status: FillAboutYouNode.statuses.success, target: SelectCodexAccountNode.name }
      ],
      [SelectCodexAccountNode.name]: [
        { status: SelectCodexAccountNode.statuses.addEmailReady, target: PhoneFirstAddEmailNode.name },
        { status: SelectCodexAccountNode.statuses.emailVerificationReady, target: WaitEmailVerificationCodeNode.name },
        { status: SelectCodexAccountNode.statuses.consent, target: SubmitCodexConsentNode.name }
      ],
      [PhoneFirstAddEmailNode.name]: [
        { status: PhoneFirstAddEmailNode.statuses.success, target: WaitEmailVerificationCodeNode.name }
      ],
      [WaitEmailVerificationCodeNode.name]: [
        { status: WaitEmailVerificationCodeNode.statuses.retryCurrent, target: WaitEmailVerificationCodeNode.name },
        { status: WaitEmailVerificationCodeNode.statuses.consent, target: SubmitCodexConsentNode.name }
      ]
    }
  });
}

function buildXAiRegisterFlow() {
  const nodes = [
    new StartupInitializeNode(),
    new XAiOpenSignupPageNode(),
    new XAiWaitEmailVerificationCodeNode(),
    new XAiFillProfileNode(),
    new XAiSignInNode(),
    new XAiWaitRegistrationCompleteNode(),
    new XAiRefreshOAuthAndLoginNode(),
    new XAiSubmitConsentNode()
  ];
  return new RegisterFlow({
    startNode: StartupInitializeNode.name,
    nodes: Object.fromEntries(nodes.map((node) => [node.name, node])),
    transitions: {
      [StartupInitializeNode.name]: [
        { status: StartupInitializeNode.statuses.success, target: XAiOpenSignupPageNode.name }
      ],
      [XAiOpenSignupPageNode.name]: [
        { status: XAiOpenSignupPageNode.statuses.success, target: XAiWaitEmailVerificationCodeNode.name }
      ],
      [XAiWaitEmailVerificationCodeNode.name]: [
        { status: XAiWaitEmailVerificationCodeNode.statuses.success, target: XAiFillProfileNode.name }
      ],
      [XAiFillProfileNode.name]: [
        { status: XAiFillProfileNode.statuses.success, target: XAiWaitRegistrationCompleteNode.name },
        { status: XAiFillProfileNode.statuses.signInReady, target: XAiSignInNode.name }
      ],
      [XAiSignInNode.name]: [
        { status: XAiSignInNode.statuses.success, target: XAiWaitRegistrationCompleteNode.name }
      ],
      [XAiWaitRegistrationCompleteNode.name]: [
        { status: XAiWaitRegistrationCompleteNode.statuses.success, target: XAiRefreshOAuthAndLoginNode.name },
        { status: XAiWaitRegistrationCompleteNode.statuses.signInReady, target: XAiSignInNode.name }
      ],
      [XAiRefreshOAuthAndLoginNode.name]: [
        { status: XAiRefreshOAuthAndLoginNode.statuses.consent, target: XAiSubmitConsentNode.name }
      ]
    }
  });
}

function buildXAiReauthorizeFlow() {
  const nodes = [
    new StartupInitializeNode(),
    new XAiSignInNode(),
    new XAiRefreshOAuthAndLoginNode(),
    new XAiSubmitConsentNode()
  ];
  return new RegisterFlow({
    startNode: StartupInitializeNode.name,
    nodes: Object.fromEntries(nodes.map((node) => [node.name, node])),
    transitions: {
      [StartupInitializeNode.name]: [
        { status: StartupInitializeNode.statuses.success, target: XAiSignInNode.name }
      ],
      [XAiSignInNode.name]: [
        { status: XAiSignInNode.statuses.success, target: XAiRefreshOAuthAndLoginNode.name }
      ],
      [XAiRefreshOAuthAndLoginNode.name]: [
        { status: XAiRefreshOAuthAndLoginNode.statuses.consent, target: XAiSubmitConsentNode.name }
      ]
    }
  });
}

export function getNodeOrder(mode = RUN_MODES.openaiRegister, options = {}) {
  const runMode = normalizeRunMode(mode);
  if (isOpenAiReauthorizeMode(runMode)) {
    return [
      StartupInitializeNode.name,
      SelectCodexAccountNode.name,
      WaitEmailVerificationCodeNode.name,
      ReauthorizePhoneChallengeNode.name,
      ReauthorizeAccountDeletedNode.name,
      ReauthorizeDeleteAccountNode.name,
      SubmitCodexConsentNode.name
    ];
  }
  if (isXAiRegisterMode(runMode)) {
    return XAI_REGISTER_NODE_ORDER;
  }
  if (isXAiReauthorizeMode(runMode)) {
    return XAI_REAUTHORIZE_NODE_ORDER;
  }
  if (isOpenAiPhoneFirstRegisterFlow(options.openAiRegisterFlow)) {
    return PHONE_FIRST_REGISTER_NODE_ORDER;
  }
  return EMAIL_REGISTER_NODE_ORDER;
}

export function getManualRetryPolicy(mode = RUN_MODES.openaiRegister, nodeName, options = {}) {
  const runMode = normalizeRunMode(mode);
  const policies = isOpenAiReauthorizeMode(runMode)
    ? REAUTHORIZE_MANUAL_RETRY_POLICIES
    : isXAiRegisterMode(runMode)
      ? XAI_REGISTER_MANUAL_RETRY_POLICIES
      : isXAiReauthorizeMode(runMode)
        ? XAI_REAUTHORIZE_MANUAL_RETRY_POLICIES
        : isOpenAiPhoneFirstRegisterFlow(options.openAiRegisterFlow)
          ? PHONE_FIRST_REGISTER_MANUAL_RETRY_POLICIES
      : EMAIL_REGISTER_MANUAL_RETRY_POLICIES;
  return policies[nodeName] || {
    retryable: false,
    message: "当前节点不支持手动重试"
  };
}

export const EMAIL_REGISTER_NODE_ORDER = [
  StartupInitializeNode.name,
  OpenChatGptTabNode.name,
  FillEmailAndSubmitNode.name,
  CreatePasswordNode.name,
  WaitEmailVerificationCodeNode.name,
  FillAboutYouNode.name,
  SelectCodexAccountNode.name,
  AddPhoneNumberNode.name,
  WaitSmsVerificationCodeNode.name,
  SubmitCodexConsentNode.name
];

export const PHONE_FIRST_REGISTER_NODE_ORDER = [
  StartupInitializeNode.name,
  OpenChatGptPhoneFirstNode.name,
  PhoneFirstAddPhoneNumberNode.name,
  CreatePasswordNode.name,
  WaitSmsVerificationCodeNode.name,
  FillAboutYouNode.name,
  SelectCodexAccountNode.name,
  PhoneFirstAddEmailNode.name,
  WaitEmailVerificationCodeNode.name,
  SubmitCodexConsentNode.name
];

export const XAI_REGISTER_NODE_ORDER = [
  StartupInitializeNode.name,
  XAiOpenSignupPageNode.name,
  XAiWaitEmailVerificationCodeNode.name,
  XAiFillProfileNode.name,
  XAiSignInNode.name,
  XAiWaitRegistrationCompleteNode.name,
  XAiRefreshOAuthAndLoginNode.name,
  XAiSubmitConsentNode.name
];

export const XAI_REAUTHORIZE_NODE_ORDER = [
  StartupInitializeNode.name,
  XAiSignInNode.name,
  XAiRefreshOAuthAndLoginNode.name,
  XAiSubmitConsentNode.name
];

export const NODE_ORDER = EMAIL_REGISTER_NODE_ORDER;

const RETRY_DIRECT = Object.freeze({
  retryable: true,
  prepare: "direct"
});

const RETRY_REFRESH = Object.freeze({
  retryable: true,
  prepare: "refresh"
});

function retryFromNode(nodeName) {
  return Object.freeze({
    retryable: true,
    prepare: "direct",
    startNode: nodeName
  });
}

const EMAIL_REGISTER_MANUAL_RETRY_POLICIES = Object.freeze({
  [StartupInitializeNode.name]: RETRY_DIRECT,
  [OpenChatGptTabNode.name]: RETRY_REFRESH,
  [FillEmailAndSubmitNode.name]: RETRY_REFRESH,
  [CreatePasswordNode.name]: RETRY_REFRESH,
  [WaitEmailVerificationCodeNode.name]: RETRY_REFRESH,
  [FillAboutYouNode.name]: RETRY_REFRESH,
  [SelectCodexAccountNode.name]: RETRY_DIRECT,
  [AddPhoneNumberNode.name]: RETRY_DIRECT,
  [WaitSmsVerificationCodeNode.name]: retryFromNode(SelectCodexAccountNode.name),
  [SubmitCodexConsentNode.name]: retryFromNode(SelectCodexAccountNode.name)
});

const PHONE_FIRST_REGISTER_MANUAL_RETRY_POLICIES = Object.freeze({
  [StartupInitializeNode.name]: RETRY_DIRECT,
  [OpenChatGptPhoneFirstNode.name]: RETRY_REFRESH,
  [PhoneFirstAddPhoneNumberNode.name]: RETRY_DIRECT,
  [CreatePasswordNode.name]: RETRY_REFRESH,
  [WaitSmsVerificationCodeNode.name]: retryFromNode(StartupInitializeNode.name),
  [FillAboutYouNode.name]: RETRY_REFRESH,
  [SelectCodexAccountNode.name]: RETRY_DIRECT,
  [PhoneFirstAddEmailNode.name]: RETRY_REFRESH,
  [WaitEmailVerificationCodeNode.name]: RETRY_REFRESH,
  [SubmitCodexConsentNode.name]: retryFromNode(SelectCodexAccountNode.name)
});

const REAUTHORIZE_MANUAL_RETRY_POLICIES = Object.freeze({
  [StartupInitializeNode.name]: RETRY_DIRECT,
  [SelectCodexAccountNode.name]: RETRY_DIRECT,
  [WaitEmailVerificationCodeNode.name]: RETRY_REFRESH,
  [ReauthorizePhoneChallengeNode.name]: RETRY_REFRESH,
  [ReauthorizeAccountDeletedNode.name]: Object.freeze({
    retryable: false,
    message: "账号停用处理节点不支持重试"
  }),
  [ReauthorizeDeleteAccountNode.name]: Object.freeze({
    retryable: false,
    message: "删除账号节点不支持重试"
  }),
  [SubmitCodexConsentNode.name]: retryFromNode(SelectCodexAccountNode.name)
});

const XAI_REGISTER_MANUAL_RETRY_POLICIES = Object.freeze({
  [StartupInitializeNode.name]: RETRY_DIRECT,
  [XAiOpenSignupPageNode.name]: retryFromNode(XAiOpenSignupPageNode.name),
  [XAiWaitEmailVerificationCodeNode.name]: retryFromNode(XAiOpenSignupPageNode.name),
  [XAiFillProfileNode.name]: retryFromNode(XAiOpenSignupPageNode.name),
  [XAiSignInNode.name]: retryFromNode(XAiSignInNode.name),
  [XAiWaitRegistrationCompleteNode.name]: RETRY_REFRESH,
  [XAiRefreshOAuthAndLoginNode.name]: RETRY_DIRECT,
  [XAiSubmitConsentNode.name]: retryFromNode(XAiRefreshOAuthAndLoginNode.name)
});

const XAI_REAUTHORIZE_MANUAL_RETRY_POLICIES = Object.freeze({
  [StartupInitializeNode.name]: RETRY_DIRECT,
  [XAiSignInNode.name]: retryFromNode(XAiSignInNode.name),
  [XAiRefreshOAuthAndLoginNode.name]: RETRY_DIRECT,
  [XAiSubmitConsentNode.name]: retryFromNode(XAiRefreshOAuthAndLoginNode.name)
});
