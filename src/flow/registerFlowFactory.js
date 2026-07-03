import { RegisterFlow } from "../core/flow.js";
import { StartupInitializeNode } from "../nodes/startupInitializeNode.js";
import { OpenChatGptTabNode } from "../nodes/openChatGptTabNode.js";
import { FillEmailAndSubmitNode } from "../nodes/fillEmailAndSubmitNode.js";
import { CreatePasswordNode } from "../nodes/createPasswordNode.js";
import { WaitEmailVerificationCodeNode } from "../nodes/waitEmailVerificationCodeNode.js";
import { FillAboutYouNode } from "../nodes/fillAboutYouNode.js";
import { SelectCodexAccountNode } from "../nodes/selectCodexAccountNode.js";
import { AddPhoneNumberNode } from "../nodes/addPhoneNumberNode.js";
import { WaitSmsVerificationCodeNode } from "../nodes/waitSmsVerificationCodeNode.js";
import { SubmitCodexConsentNode } from "../nodes/submitCodexConsentNode.js";
import { ReauthorizePhoneChallengeNode } from "../nodes/reauthorizePhoneChallengeNode.js";
import { ReauthorizeAccountDeletedNode } from "../nodes/reauthorizeAccountDeletedNode.js";

export function buildRegisterFlow(mode = "email_register") {
  if (mode === "reauthorize") {
    return buildReauthorizeFlow();
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
        { status: ReauthorizePhoneChallengeNode.statuses.accountDeleted, target: ReauthorizeAccountDeletedNode.name },
        { status: ReauthorizePhoneChallengeNode.statuses.consent, target: SubmitCodexConsentNode.name }
      ]
    }
  });
}

export function getNodeOrder(mode = "email_register") {
  if (mode === "reauthorize") {
    return [
      StartupInitializeNode.name,
      SelectCodexAccountNode.name,
      WaitEmailVerificationCodeNode.name,
      ReauthorizePhoneChallengeNode.name,
      ReauthorizeAccountDeletedNode.name,
      SubmitCodexConsentNode.name
    ];
  }
  return EMAIL_REGISTER_NODE_ORDER;
}

export function getManualRetryPolicy(mode = "email_register", nodeName) {
  const policies = mode === "reauthorize"
    ? REAUTHORIZE_MANUAL_RETRY_POLICIES
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

const REAUTHORIZE_MANUAL_RETRY_POLICIES = Object.freeze({
  [StartupInitializeNode.name]: RETRY_DIRECT,
  [SelectCodexAccountNode.name]: RETRY_DIRECT,
  [WaitEmailVerificationCodeNode.name]: RETRY_REFRESH,
  [ReauthorizePhoneChallengeNode.name]: RETRY_REFRESH,
  [ReauthorizeAccountDeletedNode.name]: Object.freeze({
    retryable: false,
    message: "账号停用处理节点不支持重试"
  }),
  [SubmitCodexConsentNode.name]: retryFromNode(SelectCodexAccountNode.name)
});
