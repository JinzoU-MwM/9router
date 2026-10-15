// ZCode bonus resource key — Z.AI general endpoint (api/paas/v4).
// Referral bonus (100M GLM tokens) bills against the GENERAL endpoint, NOT
// /api/coding/paas/v4 (coding-plan only; returns 1309 expired for bonus keys).
// Key format: {apiKey}.{secretKey}, resolved via zcode OAuth cli/poll flow.
const zcodeProvider = {
  id: "zcode",
  priority: 95,
  alias: "zcode",
  aliases: ["zcode-bridge", "zcode-proxy"],
  display: {
    name: "ZCode Bridge",
    icon: "terminal",
    color: "#0EA5E9",
    textIcon: "ZC",
    website: "https://zcode.z.ai",
    notice: {
      text: "Bridge via local zcode-proxy (coding-plan → api.z.ai). Requires zcode-proxy running on 127.0.0.1:8099.",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://api.z.ai/api/paas/v4/chat/completions",
    validateUrl: "https://api.z.ai/api/paas/v4/models",
    format: "openai",
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
  },
  models: [
    { id: "glm-5.3", name: "GLM 5.3" },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "glm-5.3-flashx", name: "GLM 5.3 FlashX" },
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "glm-5", name: "GLM 5" },
    { id: "glm-5-turbo", name: "GLM 5 Turbo" },
    { id: "glm-4.7", name: "GLM 4.7" },
    { id: "glm-4.6", name: "GLM 4.6" },
    { id: "glm-4.5-air", name: "GLM 4.5 Air" },
    { id: "glm-4.5", name: "GLM 4.5" },
  ],
  serviceKinds: ["llm"],
  features: {
    usage: false,
  },
};

export default zcodeProvider;
