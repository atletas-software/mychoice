const localConfig = window.INTERVIEW_ME_CONFIG || {};
let config = { ...localConfig };

const placeholderClientId = "PASTE_GOOGLE_OAUTH_CLIENT_ID_HERE";
const placeholderPersonaId = "PASTE_TAVUS_PERSONA_ID_HERE";

const authPanel = document.querySelector("#authPanel");
const homePanel = document.querySelector("#homePanel");
const welcomeTitle = document.querySelector("#welcomeTitle");
const signOutButton = document.querySelector("#signOutButton");
const previewButton = document.querySelector("#previewButton");
const configNote = document.querySelector("#configNote");
const interviewButton = document.querySelector("#interviewButton");
const interviewStatus = document.querySelector("#interviewStatus");
const conversationPanel = document.querySelector("#conversationPanel");
const tavusFrame = document.querySelector("#tavusFrame");
const endInterviewButton = document.querySelector("#endInterviewButton");
const leaveInterviewButton = document.querySelector("#leaveInterviewButton");
const stagePlaceholder = document.querySelector("#stagePlaceholder");
const dailyFrameContainer = document.querySelector("#dailyFrameContainer");
const sectionTabs = document.querySelectorAll("[data-section-tab]");
const sectionPanels = document.querySelectorAll("[data-section-panel]");
const profileForm = document.querySelector("#profileForm");
const firstNameInput = document.querySelector("#firstNameInput");
const lastNameInput = document.querySelector("#lastNameInput");
const linkedInInput = document.querySelector("#linkedInInput");
const domainInput = document.querySelector("#domainInput");
const resumeInput = document.querySelector("#resumeInput");
const resumeStatus = document.querySelector("#resumeStatus");
const personalContextInput = document.querySelector("#personalContextInput");
const futureDirectionInput = document.querySelector("#futureDirectionInput");
const profileStatus = document.querySelector("#profileStatus");
const startRequirement = document.querySelector("#startRequirement");
const trainingOfferTitle = document.querySelector("#trainingOfferTitle");
const trainingOfferSummary = document.querySelector("#trainingOfferSummary");
const careerPathCopy = document.querySelector("#careerPathCopy");
const domainPracticeCopy = document.querySelector("#domainPracticeCopy");
const aiPathRoleTitle = document.querySelector("#aiPathRoleTitle");
const aiPathOverview = document.querySelector("#aiPathOverview");
const aiPathSkills = document.querySelector("#aiPathSkills");
const aiPathActions = document.querySelector("#aiPathActions");
const bootcampTools = document.querySelector("#bootcampTools");
const toolStackGrid = document.querySelector("#toolStackGrid");
const aiLabSelect = document.querySelector("#aiLabSelect");
const aiLabScenarioInput = document.querySelector("#aiLabScenarioInput");
const runAiLabButton = document.querySelector("#runAiLabButton");
const aiLabOutput = document.querySelector("#aiLabOutput");
const agentTypeSelect = document.querySelector("#agentTypeSelect");
const agentProblemInput = document.querySelector("#agentProblemInput");
const buildAgentButton = document.querySelector("#buildAgentButton");
const agentBlueprintOutput = document.querySelector("#agentBlueprintOutput");
const aiPathSteps = document.querySelector("#aiPathSteps");
const aiPathProgress = document.querySelector("#aiPathProgress");
const aiPathVisionInput = document.querySelector("#aiPathVisionInput");
const aiPathVisionStatus = document.querySelector("#aiPathVisionStatus");
const aiPathObjectiveSummary = document.querySelector("#aiPathObjectiveSummary");
const aiPathContextSummary = document.querySelector("#aiPathContextSummary");
const domainToolsList = document.querySelector("#domainToolsList");
const toolUseGuide = document.querySelector("#toolUseGuide");
const recordingsList = document.querySelector("#recordingsList");
const recordingsStatus = document.querySelector("#recordingsStatus");
const knowledgeDomainInput = document.querySelector("#knowledgeDomainInput");
const knowledgeStatus = document.querySelector("#knowledgeStatus");
const knowledgeSummaryGrid = document.querySelector("#knowledgeSummaryGrid");
const knowledgeConcepts = document.querySelector("#knowledgeConcepts");
const knowledgeRelationships = document.querySelector("#knowledgeRelationships");
const knowledgeCases = document.querySelector("#knowledgeCases");
const testInterviewForm = document.querySelector("#testInterviewForm");
const testInterviewTitleInput = document.querySelector("#testInterviewTitleInput");
const testInterviewTurns = document.querySelector("#testInterviewTurns");
const addTestTurnButton = document.querySelector("#addTestTurnButton");
const testInterviewStatus = document.querySelector("#testInterviewStatus");

let activeConversationId = "";
let dailyCall = null;
let currentUser = null;
let selectedInterviewId = "";
let recordingsRefreshTimer = null;
let latestAiTrainingPath = null;
let latestAiPathTools = [];

initializeApp();
addTestInterviewTurn();

previewButton.addEventListener("click", () => {
  const user = {
    name: "Demo User",
    email: "demo@example.com",
    picture: ""
  };

  currentUser = user;
  localStorage.setItem("interviewMePreviewUser", JSON.stringify(user));
  showHome(user);
  populateProfileForm(user);
});

signOutButton.addEventListener("click", async () => {
  currentUser = null;
  localStorage.removeItem("interviewMePreviewUser");
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});

  if (window.google?.accounts?.id) {
    window.google.accounts.id.disableAutoSelect();
  }

  endActiveInterview();
  showAuth();
});

interviewButton.addEventListener("click", startInterview);
endInterviewButton.addEventListener("click", endActiveInterview);
leaveInterviewButton.addEventListener("click", endActiveInterview);
sectionTabs.forEach((tab) => {
  tab.addEventListener("click", () => showWorkspaceSection(tab.dataset.sectionTab));
});
profileForm.addEventListener("submit", saveProfile);
resumeInput.addEventListener("change", () => {
  const file = resumeInput.files?.[0];
  resumeStatus.textContent = file
    ? `Ready to save: ${file.name}`
    : currentUser?.resumeFileName || "Upload your resume before starting an interview.";
});
domainInput?.addEventListener("change", renderAiPathSteps);
recordingsList?.addEventListener("click", (event) => {
  const target = event.target;

  if (target instanceof HTMLElement && target.closest("[data-refresh-recordings]")) {
    loadInterviewHistory();
    return;
  }

  const recordingButton = target instanceof HTMLElement
    ? target.closest("[data-interview-id]")
    : null;

  if (recordingButton instanceof HTMLElement) {
    loadInterviewDetail(recordingButton.dataset.interviewId || "");
  }
});
knowledgeDomainInput?.addEventListener("change", () => loadDecisionKnowledge());
addTestTurnButton?.addEventListener("click", () => addTestInterviewTurn());
testInterviewForm?.addEventListener("submit", saveTestInterview);
runAiLabButton?.addEventListener("click", runAiProLab);
buildAgentButton?.addEventListener("click", buildAgentBlueprint);
aiPathSteps?.addEventListener("click", handleAiPathAction);
aiPathVisionInput?.addEventListener("input", saveAiPathVision);
domainToolsList?.addEventListener("click", handleToolUseClick);

async function initializeApp() {
  showAuth();

  try {
    const [remoteConfig, session] = await Promise.all([loadConfig(), loadSession()]);
    config = { ...config, ...remoteConfig };
    currentUser = session.user || null;
  } catch {
    configNote.textContent = "App configuration could not be loaded. Check the local server and reload.";
    configNote.hidden = false;
  }

  if (currentUser) {
    showHome(currentUser);
    populateProfileForm(currentUser);
    loadInterviewHistory();

    if (new URLSearchParams(window.location.search).get("previewInterview") === "1") {
      showInterviewConsole();
      setInterviewStatus("Creating your Tavus interview room...", false);
    }
  }

  initializeGoogleSignIn();
}

async function loadConfig() {
  const response = await fetch("/api/config");

  if (!response.ok) {
    throw new Error("Unable to load app config.");
  }

  return response.json();
}

async function loadSession() {
  const response = await fetch("/api/session");

  if (!response.ok) {
    throw new Error("Unable to load session.");
  }

  return response.json();
}

function initializeGoogleSignIn() {
  const clientId = config.googleClientId;
  const hasClientId = clientId && clientId !== placeholderClientId;

  if (!hasClientId) {
    configNote.hidden = false;
    previewButton.hidden = false;
    return;
  }

  if (!window.google?.accounts?.id) {
    configNote.textContent = "Google sign-in did not load. Check your network connection and reload.";
    configNote.hidden = false;
    return;
  }

  window.google.accounts.id.initialize({
    client_id: clientId,
    callback: handleGoogleCredential
  });

  window.google.accounts.id.renderButton(document.querySelector("#googleSignInButton"), {
    theme: "outline",
    size: "large",
    shape: "pill",
    text: "signin_with",
    width: 280
  });
}

async function handleGoogleCredential(response) {
  try {
    const authResponse = await fetch("/api/auth/google", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ credential: response.credential })
    });
    const data = await authResponse.json().catch(() => ({}));

    if (!authResponse.ok) {
      throw new Error(data.error || "Google sign-in failed.");
    }

    currentUser = data.user;
    localStorage.removeItem("interviewMePreviewUser");
    showHome(currentUser);
    populateProfileForm(currentUser);
    loadInterviewHistory();
  } catch (error) {
    configNote.textContent =
      error instanceof Error ? error.message : "Google sign-in failed. Please try again.";
    configNote.hidden = false;
  }
}

function showAuth() {
  authPanel.hidden = false;
  homePanel.hidden = true;
}

function showHome(user) {
  authPanel.hidden = true;
  homePanel.hidden = false;

  if (welcomeTitle) {
    welcomeTitle.textContent = user.name ? `Welcome, ${user.name}` : "Welcome";
  }

  if (user) {
    loadInterviewHistory();
  }
}

function showWorkspaceSection(sectionName) {
  sectionTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.sectionTab === sectionName);
  });

  sectionPanels.forEach((panel) => {
    const isActive = panel.dataset.sectionPanel === sectionName;
    panel.hidden = !isActive;
    panel.classList.toggle("active", isActive);
  });

  if (sectionName === "training") {
    loadAiTrainingPath();
    renderAiPathSteps();
  }

  if (sectionName === "interview") {
    loadInterviewHistory();
  }

  if (sectionName === "knowledge") {
    loadDecisionKnowledge();
  }
}

function populateProfileForm(user) {
  firstNameInput.value = user.firstName || splitName(user.name).firstName;
  lastNameInput.value = user.lastName || splitName(user.name).lastName;
  linkedInInput.value = user.linkedIn || "";
  domainInput.value = user.domain || "";
  personalContextInput.value = user.personalContext || "";
  futureDirectionInput.value = user.futureDirection || "";
  resumeInput.value = "";
  resumeStatus.textContent = user.resumeFileName
    ? `Saved resume: ${user.resumeFileName}`
    : "Upload your resume before starting an interview.";
  updateInterviewReadiness();
  updateTrainingOffer(user);
  renderAiPathSteps();
}

async function saveProfile(event) {
  event.preventDefault();
  setProfileStatus("Saving profile...", false);

  try {
    const resume = await readResumeUpload();
    const response = await fetch("/api/profile", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        firstName: firstNameInput.value,
        lastName: lastNameInput.value,
        linkedIn: linkedInInput.value,
        domain: domainInput.value,
        personalContext: personalContextInput.value,
        futureDirection: futureDirectionInput.value,
        resume
      })
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "Unable to save profile.");
    }

    currentUser = data.user;
    populateProfileForm(currentUser);
    showHome(currentUser);
    updateInterviewReadiness();
    loadAiTrainingPath();
    setProfileStatus("Profile saved.", false);
  } catch (error) {
    setProfileStatus(error instanceof Error ? error.message : "Unable to save profile.", true);
  }
}

function setProfileStatus(message, isError) {
  profileStatus.textContent = message;
  profileStatus.dataset.state = isError ? "error" : "info";
}

function splitName(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);

  return {
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" ")
  };
}

async function startInterview() {
  const user = getSavedUser();
  const personaId = normalizeConfigValue(config.tavusPersonaId, placeholderPersonaId);
  const replicaId = normalizeConfigValue(config.tavusReplicaId, "");

  if (!hasRequiredProfile(user)) {
    showWorkspaceSection("profile");
    setProfileStatus("Add LinkedIn, Domain, and Resume, then save your profile before starting an interview.", true);
    return;
  }

  if (!personaId && !replicaId) {
    setInterviewStatus("Add your Tavus Persona ID in config.js before starting an interview.", true);
    return;
  }

  interviewButton.disabled = true;
  showInterviewConsole();
  setInterviewStatus("Creating your Tavus interview room...", false);

  try {
    const response = await fetch("/api/tavus/conversations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        persona_id: personaId,
        replica_id: replicaId,
        conversation_name: user?.name ? `Interview Me - ${user.name}` : "Interview Me"
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || data.message || "Unable to start the Tavus interview.");
    }

    if (!data.conversation_url || !data.conversation_id) {
      throw new Error("Tavus did not return a conversation URL.");
    }

    activeConversationId = data.conversation_id;
    loadInterviewHistory();
    await joinDailyRoom(data.conversation_url);
    setInterviewStatus("", false);
  } catch (error) {
    stagePlaceholder.hidden = false;
    setInterviewStatus(error instanceof Error ? error.message : "Unable to start the Tavus interview.", true);
  } finally {
    interviewButton.disabled = false;
  }
}

function hasRequiredProfile(user) {
  return Boolean(user?.linkedIn && user?.domain && user?.resumeFileName);
}

function updateInterviewReadiness() {
  const isReady = hasRequiredProfile(currentUser);
  interviewButton.disabled = !isReady;
  startRequirement.textContent = isReady
    ? ""
    : "Profile required: add LinkedIn, Domain, and Resume before starting.";
  startRequirement.dataset.state = isReady ? "info" : "error";
}

async function endActiveInterview() {
  if (!activeConversationId) {
    resetInterviewFrame();
    return;
  }

  const conversationId = activeConversationId;
  resetInterviewFrame();

  try {
    await fetch(`/api/tavus/conversations/${encodeURIComponent(conversationId)}/end`, {
      method: "POST"
    });
    loadInterviewHistory();
    startRecordingsRefreshLoop();
  } catch {
    setInterviewStatus("Interview closed locally. Tavus cleanup may need a retry.", true);
    startRecordingsRefreshLoop();
  }
}

async function loadInterviewHistory(options = {}) {
  if (!recordingsList) {
    return;
  }

  if (!currentUser) {
    renderInterviewHistory([]);
    return;
  }

  if (!options.silent) {
    recordingsList.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "recordings-empty";
    loading.textContent = "Loading previous interviews...";
    recordingsList.append(loading);
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch("/api/interviews", {
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "Unable to load previous interviews.");
    }

    renderInterviewHistory(data.interviews || [], data);

    if (options.preserveDetail && selectedInterviewId) {
      await loadInterviewDetail(selectedInterviewId, { silent: true });
    }
  } catch (error) {
    recordingsList.replaceChildren();
    const message = document.createElement("p");
    message.className = "recordings-empty error";
    message.textContent =
      error instanceof DOMException && error.name === "AbortError"
        ? "Previous interviews are taking too long to load. Refresh or try again after redeploy."
        : error instanceof Error
          ? error.message
          : "Unable to load previous interviews.";
    const retry = createRefreshRecordingsButton();
    recordingsList.append(message, retry);
  } finally {
    window.clearTimeout(timeout);
  }
}

function renderInterviewHistory(interviews, meta = {}) {
  if (!recordingsList) {
    return;
  }

  recordingsList.replaceChildren();

  if (!interviews.length) {
    const empty = document.createElement("p");
    empty.className = "recordings-empty";
    empty.textContent =
      meta.userId
        ? `No previous recordings found for signed-in user ${meta.userId}.`
        : "No previous recordings yet. Start your first interview to create one.";
    const hint = document.createElement("p");
    hint.className = "recordings-hint";
    hint.textContent = "If you recorded interviews already, sign out and sign in with the same Google account used for those sessions.";
    recordingsList.append(empty, hint, createRefreshRecordingsButton());
    return;
  }

  const summary = document.createElement("p");
  summary.className = "recordings-hint";
  summary.textContent = `${interviews.length} previous interview${interviews.length === 1 ? "" : "s"} found.`;

  recordingsList.replaceChildren(
    summary,
    ...interviews.map((interview) => {
      const item = document.createElement("button");
      item.className = "recording-item";
      item.type = "button";
      item.dataset.interviewId = String(interview.id || "");
      const date = interview.startedAt || interview.createdAt;
      const transcriptLabel =
        interview.transcriptCount === 1
          ? "1 transcript turn"
          : `${interview.transcriptCount || 0} transcript turns`;

      item.innerHTML = `
        <div>
          <strong>${escapeHtml(formatInterviewDate(date))}</strong>
          <span>${escapeHtml(interview.domain || "No domain")}</span>
        </div>
        <div>
          <span class="recording-status">${escapeHtml(interview.status || "unknown")}</span>
          <span>${escapeHtml(transcriptLabel)}</span>
        </div>
      `;

      return item;
    })
  );
}

async function loadInterviewDetail(interviewId, options = {}) {
  if (!recordingsList || !interviewId) {
    return;
  }

  selectedInterviewId = interviewId;
  const existingPanel = recordingsList.querySelector("[data-interview-detail]");
  if (!options.silent) {
    existingPanel?.remove();
  }

  const loading = existingPanel || document.createElement("section");
  loading.className = "recording-detail";
  loading.dataset.interviewDetail = "true";

  if (!options.silent || !existingPanel) {
    loading.innerHTML = `<p class="recordings-hint">Loading transcript...</p>`;
    recordingsList.append(loading);
  }

  try {
    const response = await fetch(`/api/interviews/${encodeURIComponent(interviewId)}`);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "Unable to load interview transcript.");
    }

    renderInterviewDetail(data);
  } catch (error) {
    loading.innerHTML = `
      <p class="recordings-empty error">${escapeHtml(error instanceof Error ? error.message : "Unable to load interview transcript.")}</p>
    `;
  }
}

function startRecordingsRefreshLoop() {
  window.clearInterval(recordingsRefreshTimer);
  let attempts = 0;

  recordingsRefreshTimer = window.setInterval(async () => {
    attempts += 1;
    await loadInterviewHistory({ silent: true, preserveDetail: true });

    if (attempts >= 12) {
      window.clearInterval(recordingsRefreshTimer);
      recordingsRefreshTimer = null;
    }
  }, 5000);
}

function renderInterviewDetail(data) {
  const existingPanel = recordingsList.querySelector("[data-interview-detail]");
  const panel = existingPanel || document.createElement("section");
  const interview = data.interview || {};
  const transcript = (data.transcript || []).filter(isDisplayableTranscriptTurn);

  panel.className = "recording-detail";
  panel.dataset.interviewDetail = "true";
  panel.innerHTML = `
    <div class="recording-detail-head">
      <div>
        <span>Transcript</span>
        <strong>${escapeHtml(formatInterviewDate(interview.startedAt || interview.createdAt))}</strong>
      </div>
      <span>${escapeHtml(interview.status || "unknown")}</span>
    </div>
  `;

  if (!transcript.length) {
    const empty = document.createElement("p");
    empty.className = "recordings-empty";
    empty.textContent = "No transcript turns were captured for this interview yet.";
    panel.append(empty);
  } else {
    const turns = document.createElement("div");
    turns.className = "transcript-turns";
    turns.replaceChildren(
      ...transcript.map((turn) => {
        const item = document.createElement("article");
        item.className = "transcript-turn";
        const speaker = turn.speaker || turn.speakerRole || "Speaker";
        const time = turn.startedAt || turn.createdAt || "";

        item.innerHTML = `
          <div>
            <strong>${escapeHtml(speaker)}</strong>
            <span>${escapeHtml(formatTranscriptTime(time))}</span>
          </div>
          <p>${escapeHtml(turn.text || "")}</p>
        `;
        return item;
      })
    );
    panel.append(turns);
  }

  if (!existingPanel) {
    recordingsList.append(panel);
  }
}

function isDisplayableTranscriptTurn(turn) {
  const speaker = String(turn.speaker || turn.speakerRole || "").trim().toLowerCase();
  const text = String(turn.text || "").trim().toLowerCase();

  if (!text || speaker === "system") {
    return false;
  }

  return !(
    text.startsWith("you are an interviewer") ||
    text.includes("this is a my choice decision capture session") ||
    text.includes("the signed-in user's email") ||
    text.includes("conversation context")
  );
}

function createRefreshRecordingsButton() {
  const button = document.createElement("button");
  button.className = "recordings-refresh";
  button.type = "button";
  button.dataset.refreshRecordings = "true";
  button.textContent = "Refresh recordings";
  return button;
}

function formatTranscriptTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatInterviewDate(value) {
  if (!value) {
    return "Interview";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function resetInterviewFrame() {
  activeConversationId = "";
  destroyDailyCall();
  tavusFrame.removeAttribute("src");
  conversationPanel.classList.remove("has-live-frame");
  conversationPanel.hidden = true;
  stagePlaceholder.hidden = false;
  homePanel.classList.remove("is-interviewing");
  setInterviewStatus("", false);
}

function showInterviewConsole() {
  homePanel.classList.add("is-interviewing");
  conversationPanel.classList.remove("has-live-frame");
  conversationPanel.hidden = false;
  stagePlaceholder.hidden = false;
}

async function joinDailyRoom(conversationUrl) {
  if (!window.Daily?.createFrame) {
    tavusFrame.src = conversationUrl;
    conversationPanel.classList.add("has-live-frame");
    stagePlaceholder.hidden = true;
    return;
  }

  destroyDailyCall();

  dailyCall = window.Daily.createFrame(dailyFrameContainer, {
    url: conversationUrl,
    userName: getSavedUser()?.name || "Yuri",
    activeSpeakerMode: false,
    showUserNameChangeUI: false,
    layoutConfig: {
      grid: {
        minTilesPerPage: 2,
        maxTilesPerPage: 2
      }
    },
    showLeaveButton: true,
    showFullscreenButton: true,
    iframeStyle: {
      width: "100%",
      height: "100%",
      border: "0"
    },
    theme: {
      colors: {
        accent: "#24b7a8",
        background: "#ffffff",
        baseText: "#111827"
      }
    }
  });

  conversationPanel.classList.add("has-live-frame");
  stagePlaceholder.hidden = true;
  await dailyCall.join();
  await dailyCall.setActiveSpeakerMode(false).catch(() => {});
}

function destroyDailyCall() {
  if (!dailyCall) {
    return;
  }

  try {
    dailyCall.destroy();
  } catch {
    dailyFrameContainer.replaceChildren();
  }

  dailyCall = null;
}

function setInterviewStatus(message, isError) {
  interviewStatus.textContent = message;
  interviewStatus.dataset.state = isError ? "error" : "info";
}

function normalizeConfigValue(value, placeholder) {
  if (!value || value === placeholder) {
    return "";
  }

  return value.trim();
}

async function readResumeUpload() {
  const file = resumeInput.files?.[0];

  if (!file) {
    return null;
  }

  if (file.size > 4 * 1024 * 1024) {
    throw new Error("Resume file is too large. Upload a file under 4 MB.");
  }

  const base64 = await readFileAsBase64(file);
  const text = await readFileAsTextIfSupported(file);

  return {
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    contentBase64: base64,
    extractedText: text
  };
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").pop() : result);
    });
    reader.addEventListener("error", () => reject(new Error("Unable to read resume file.")));
    reader.readAsDataURL(file);
  });
}

function readFileAsTextIfSupported(file) {
  const isTextFile =
    file.type.startsWith("text/") || /\.(txt|md)$/i.test(file.name || "");

  if (!isTextFile) {
    return Promise.resolve("");
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "").slice(0, 12000)));
    reader.addEventListener("error", () => resolve(""));
    reader.readAsText(file);
  });
}

function getAiPathStorageKey() {
  const userKey = currentUser?.id || currentUser?.email || "preview";
  return `myChoiceAiPath:${userKey}`;
}

function loadAiPathState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(getAiPathStorageKey()) || "{}");
    return {
      vision: parsed.vision || "",
      steps: {
        vision: parsed.steps?.vision || "pending",
        tools: parsed.steps?.tools || "pending"
      }
    };
  } catch {
    return {
      vision: "",
      steps: {
        vision: "pending",
        tools: "pending"
      }
    };
  }
}

function saveAiPathState(state) {
  localStorage.setItem(getAiPathStorageKey(), JSON.stringify(state));
}

function saveAiPathVision() {
  const state = loadAiPathState();
  const nextVision = aiPathVisionInput?.value || "";
  const changed = state.vision !== nextVision;
  state.vision = nextVision;

  if (changed) {
    state.steps.vision = "pending";
    state.steps.tools = "pending";
  }

  saveAiPathState(state);

  if (aiPathVisionStatus) {
    aiPathVisionStatus.textContent = state.vision.trim()
      ? "Saved. Complete this step to lock in the current objective."
      : "";
    aiPathVisionStatus.dataset.state = "info";
  }

  renderAiPathSteps();
}

function handleAiPathAction(event) {
  const actionButton = event.target instanceof HTMLElement
    ? event.target.closest("[data-ai-step-action]")
    : null;

  if (!(actionButton instanceof HTMLElement)) {
    return;
  }

  const stepId = actionButton.dataset.stepId || "";
  const action = actionButton.dataset.aiStepAction || "";
  const state = loadAiPathState();

  if (stepId === "vision") {
    state.vision = aiPathVisionInput?.value || "";
  }

  if (stepId && (action === "complete" || action === "skip")) {
    state.steps[stepId] = action === "complete" ? "complete" : "skipped";
    saveAiPathState(state);
    renderAiPathSteps();

    if (stepId === "vision" && action === "complete") {
      if (aiPathVisionStatus) {
        aiPathVisionStatus.textContent = "Training tools generated below.";
        aiPathVisionStatus.dataset.state = "info";
      }

      setTimeout(() => {
        aiPathSteps?.querySelector("[data-ai-step='tools']")?.scrollIntoView({
          behavior: "smooth",
          block: "start"
        });
      }, 80);
    }
  }
}

function renderAiPathSteps() {
  if (!aiPathSteps) {
    return;
  }

  const state = loadAiPathState();
  const statuses = aiPathSteps.querySelectorAll("[data-step-status]");
  statuses.forEach((statusNode) => {
    const stepId = statusNode.dataset.stepStatus || "";
    const status = state.steps[stepId] || "pending";
    statusNode.textContent = status === "complete"
      ? "Complete"
      : status === "skipped"
        ? "Skipped"
        : "Not started";
    statusNode.dataset.state = status;
  });

  if (aiPathVisionInput && aiPathVisionInput.value !== state.vision) {
    aiPathVisionInput.value = state.vision;
  }

  if (aiPathProgress) {
    const finishedSteps = Object.values(state.steps).filter((status) => status === "complete" || status === "skipped").length;
    aiPathProgress.textContent = `${finishedSteps} of 2 steps finished`;
  }

  renderDomainToolsForPath();
}

function renderDomainToolsForPath() {
  if (!domainToolsList) {
    return;
  }

  const state = loadAiPathState();
  const domain = currentUser?.domain || domainInput?.value || "";
  const objective = state.vision || "";
  const recommendation = getAiPathRecommendation(domain, objective);
  const tools = personalizeToolsForObjective(getDomainToolsForPath(domain, recommendation.focus), objective, recommendation);
  latestAiPathTools = tools;

  if (aiPathObjectiveSummary) {
    aiPathObjectiveSummary.innerHTML = `
      <span>Recommended focus</span>
      <strong>${escapeHtml(recommendation.title)}</strong>
      ${objective.trim() ? `<blockquote>${escapeHtml(objective.trim())}</blockquote>` : ""}
      <p>${escapeHtml(recommendation.summary)}</p>
    `;
  }

  renderAiPathContextSummary(objective);

  domainToolsList.replaceChildren(
    ...tools.map((tool, index) => {
      const card = document.createElement("article");
      card.className = "domain-tool-card";
      card.innerHTML = `
        <span>${escapeHtml(tool.type)}</span>
        <strong>${escapeHtml(tool.name)}</strong>
        <p class="tool-fit">${escapeHtml(tool.fit)}</p>
        <p>${escapeHtml(tool.learn)}</p>
        <div><b>Practice</b><em>${escapeHtml(tool.practice)}</em></div>
        <div><b>Interview proof</b><em>${escapeHtml(tool.proof)}</em></div>
        <button class="primary-action compact-action tool-use-button" type="button" data-tool-index="${index}">Use it</button>
      `;
      return card;
    })
  );
}

function personalizeToolsForObjective(tools, objective, recommendation) {
  const cleanObjective = objective.trim();
  const focus = recommendation.title.toLowerCase();
  const profileAnchor = buildClientProfileAnchor(currentUser);

  return tools.map((tool, index) => {
    const fit = cleanObjective
      ? `${tool.name} is recommended because your goal is "${cleanObjective}" and this tool supports ${focus}.`
      : `${tool.name} is recommended as a starting point for ${focus}. Add a business objective to make this more specific.`;

    return {
      ...tool,
      fit,
      useSteps: buildToolUseSteps(tool, cleanObjective, profileAnchor, index),
      starterPrompt: buildToolStarterPrompt(tool, cleanObjective, profileAnchor)
    };
  });
}

function renderAiPathContextSummary(objective) {
  if (!aiPathContextSummary) {
    return;
  }

  const sources = [];
  if (currentUser?.domain) sources.push(`Domain: ${currentUser.domain}`);
  if (currentUser?.linkedIn) sources.push("LinkedIn saved");
  if (currentUser?.resumeFileName) sources.push(`Resume: ${currentUser.resumeFileName}`);
  if (currentUser?.personalContext) sources.push("Profile notes saved");
  if (currentUser?.futureDirection) sources.push("Future direction saved");

  const pathSources = latestAiTrainingPath?.contextSources || {};
  if (pathSources.interviewTranscriptTurns) {
    sources.push(`${pathSources.interviewTranscriptTurns} interview transcript turns`);
  }

  if (!sources.length && !objective.trim()) {
    aiPathContextSummary.hidden = true;
    aiPathContextSummary.replaceChildren();
    return;
  }

  aiPathContextSummary.hidden = false;
  aiPathContextSummary.innerHTML = `
    <span>Context used</span>
    <p>${escapeHtml(sources.length ? sources.join(" · ") : "Only the business objective is available right now. Add LinkedIn, resume, profile notes, and interviews for stronger recommendations.")}</p>
  `;
}

function handleToolUseClick(event) {
  const button = event.target instanceof HTMLElement
    ? event.target.closest("[data-tool-index]")
    : null;

  if (!(button instanceof HTMLElement)) {
    return;
  }

  const tool = latestAiPathTools[Number(button.dataset.toolIndex || -1)];
  if (!tool || !toolUseGuide) {
    return;
  }

  toolUseGuide.hidden = false;
  toolUseGuide.innerHTML = `
    <div class="tool-use-head">
      <span>Use it</span>
      <strong>${escapeHtml(tool.name)}</strong>
    </div>
    <ol>
      ${tool.useSteps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}
    </ol>
    <label class="tool-use-prompt">
      <span>Starter prompt</span>
      <textarea rows="7" readonly>${escapeHtml(tool.starterPrompt)}</textarea>
    </label>
  `;
  toolUseGuide.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function buildToolUseSteps(tool, objective, profileAnchor, index) {
  const target = objective || "your business objective";
  const steps = [
    `Open ${tool.name} and start with the starter prompt below.`,
    `Add your domain context: ${profileAnchor}.`,
    `Ask the tool to create a first draft for: ${target}.`,
    `Improve the output by asking for a version that is more specific, measurable, and usable by your organization.`,
    `Save the final output as proof: ${tool.proof}`
  ];

  if (index === 0) {
    steps.splice(3, 0, "Ask it to define the audience, business problem, desired outcome, and success metrics.");
  }

  return steps;
}

function buildToolStarterPrompt(tool, objective, profileAnchor) {
  return [
    `Act as an AI coach for my domain.`,
    `My objective: ${objective || "I want to use AI to improve my organization."}`,
    `My context: ${profileAnchor}.`,
    `Tool I am learning: ${tool.name}.`,
    `Help me use this tool for my objective.`,
    `Give me:`,
    `1. the exact first task I should do,`,
    `2. the inputs I need to collect,`,
    `3. a draft output I can create,`,
    `4. how to measure whether it helps the business,`,
    `5. what I should show my boss or interviewer as proof.`
  ].join("\n");
}

function getAiPathRecommendation(domain, objective) {
  const text = String(objective || "").toLowerCase();
  const has = (words) => words.some((word) => text.includes(word));
  const domainName = domain || "your domain";

  if (!text.trim()) {
    return {
      focus: "foundation",
      title: `AI foundation for ${domainName}`,
      summary: "Write your business objective in Step 1, and this path will prioritize the tools that fit it."
    };
  }

  if (
    has(["automate", "automation", "workflow", "campaign", "nurture", "follow-up", "follow up", "funnel", "end to end"]) &&
    has(["marketing", "client", "lead", "sales", "customer", "prospect", "revenue"])
  ) {
    return {
      focus: "marketingAutomation",
      title: "AI marketing automation",
      summary: "Your objective is to automate marketing. Start with lead capture, audience research, message generation, campaign workflows, and CRM follow-up."
    };
  }

  if (has(["automate", "automation", "workflow", "process", "manual", "operation", "efficiency", "save time"])) {
    return {
      focus: "automation",
      title: "Workflow automation and operational leverage",
      summary: "Your objective is about removing manual work. Start with automation tools, structured prompts, and lightweight agents for repeatable business workflows."
    };
  }

  if (has(["client", "lead", "sales", "revenue", "customer", "prospect", "marketing", "growth"])) {
    return {
      focus: "growth",
      title: "Client growth and revenue enablement",
      summary: "Your objective is about winning more clients. Start with tools for targeting, messaging, outreach, proposals, and simple growth automations."
    };
  }

  if (has(["report", "dashboard", "forecast", "variance", "kpi", "analysis", "analytics", "insight"])) {
    return {
      focus: "analytics",
      title: "AI analytics and executive reporting",
      summary: "Your objective is about turning business data into clearer decisions. Start with tools for analysis, dashboard narratives, and decision-ready summaries."
    };
  }

  if (has(["tenant", "resident", "maintenance", "vendor", "property", "lease", "renewal"])) {
    return {
      focus: "operations",
      title: "Domain operations improvement",
      summary: "Your objective is operational. Start with tools that triage requests, summarize documents, route work, and improve communication quality."
    };
  }

  return {
    focus: "foundation",
    title: `AI business impact for ${domainName}`,
    summary: "This path starts with practical tools you can use to explain, prototype, and prove AI value for the business objective you described."
  };
}

function getDomainToolsForPath(domain, focus = "foundation") {
  const financialTools = [
      {
        type: "Model",
        name: "ChatGPT or OpenAI API",
        learn: "Use structured prompts to explain variance, risk, forecast movement, and executive summaries.",
        practice: "Turn a messy finance update into a CFO-ready summary with assumptions and next actions.",
        proof: "Show a before-and-after finance memo and explain the prompt pattern."
      },
      {
        type: "Model",
        name: "Claude",
        learn: "Analyze long reports, policies, audit notes, investment commentary, and operating narratives.",
        practice: "Extract risks, decisions, and open questions from a long quarterly report.",
        proof: "Show how you compressed a complex document into decision-ready insight."
      },
      {
        type: "Tool",
        name: "Excel Copilot or Google Sheets AI",
        learn: "Use AI to clean spreadsheets, write formulas, explain drivers, and build repeatable analysis.",
        practice: "Create a variance analysis template with commentary for actuals versus forecast.",
        proof: "Bring a spreadsheet plus a short explanation of how AI improved speed and quality."
      },
      {
        type: "Automation",
        name: "Power Automate, Zapier, Make, or n8n",
        learn: "Automate recurring reporting, approvals, alerts, and data handoffs.",
        practice: "Design a workflow that sends a variance alert and drafts the first management note.",
        proof: "Describe the workflow, trigger, data source, and control points."
      },
      {
        type: "Analytics",
        name: "Power BI or Looker Studio",
        learn: "Connect AI-assisted narratives to dashboards and decision meetings.",
        practice: "Create an executive dashboard brief that explains what changed and what to do next.",
        proof: "Show a dashboard plus the AI-generated decision summary."
      }
    ];

  const propertyTools = [
    {
      type: "Model",
      name: "ChatGPT or OpenAI API",
      learn: "Use AI to triage maintenance, summarize resident issues, draft owner updates, and prototype agents.",
      practice: "Turn a resident maintenance request into priority, likely cause, vendor route, and response draft.",
      proof: "Show a prompt that converts raw operational text into a clear action plan."
    },
    {
      type: "Model",
      name: "Claude",
      learn: "Review leases, standard operating procedures, vendor scopes, and long operational documents.",
      practice: "Extract obligations, risks, missing details, and follow-up questions from a lease or vendor scope.",
      proof: "Show an annotated document summary with decisions and risks."
    },
    {
      type: "Productivity",
      name: "Microsoft Copilot or Google Gemini",
      learn: "Create email drafts, meeting summaries, owner packets, and team updates inside daily tools.",
      practice: "Convert a property operations meeting into follow-ups, owners, due dates, and an executive update.",
      proof: "Show a meeting-to-action workflow that saves time for property teams."
    },
    {
      type: "Automation",
      name: "Zapier, Make, or n8n",
      learn: "Connect forms, email, spreadsheets, work orders, and notifications into simple automations.",
      practice: "Design an intake flow that routes maintenance requests to the right vendor and notifies stakeholders.",
      proof: "Explain the trigger, routing logic, exception handling, and business value."
    },
    {
      type: "Operations",
      name: "Airtable or Google Sheets",
      learn: "Build lightweight AI-enabled trackers for work orders, vendors, renewals, and portfolio status.",
      practice: "Create a property operations tracker with AI-generated status notes and escalation flags.",
      proof: "Show the tracker and how it helps managers make faster decisions."
    }
  ];

  const growthTools = [
    {
      type: "Research",
      name: "ChatGPT Deep Research or Perplexity",
      learn: "Research target customer segments, competitors, buying triggers, and outreach angles.",
      practice: "Create a ranked list of target client types and the problems your organization can solve for each.",
      proof: "Bring a one-page target customer brief with pain points, messages, and proof points."
    },
    {
      type: "Messaging",
      name: "ChatGPT, Claude, or Gemini",
      learn: "Turn your domain expertise into client-facing messages, proposals, follow-ups, and objection handling.",
      practice: "Draft three outreach messages for different client types and one proposal outline.",
      proof: "Show the message variants and explain why each fits the buyer."
    },
    {
      type: "CRM",
      name: "HubSpot AI or Salesforce Einstein",
      learn: "Use AI to organize leads, score opportunities, summarize calls, and suggest next actions.",
      practice: "Build a simple pipeline with lead source, buyer need, next action, and AI-written follow-up.",
      proof: "Show how AI improves follow-up speed and consistency."
    },
    {
      type: "Content",
      name: "Canva AI or Microsoft Designer",
      learn: "Create simple sales assets, one-pagers, social posts, and visuals that explain your offer.",
      practice: "Create a one-page business case for your boss showing how AI can bring more clients.",
      proof: "Use the asset as your portfolio example in interviews."
    },
    {
      type: "Automation",
      name: "Zapier, Make, or n8n",
      learn: "Automate lead capture, email follow-up, calendar routing, and activity tracking.",
      practice: "Design a lead workflow from form submission to CRM entry to follow-up draft.",
      proof: "Explain the workflow and how it reduces missed opportunities."
    }
  ];

  const marketingAutomationTools = [
    {
      type: "Strategy",
      name: "ChatGPT or Claude",
      learn: "Turn the business objective into a clear marketing funnel: audience, pain points, offer, messages, channels, and next actions.",
      practice: "Ask AI to create a campaign brief for one target customer segment in your domain.",
      proof: "Show your boss the funnel map and explain how each step creates more qualified opportunities."
    },
    {
      type: "Research",
      name: "Perplexity or ChatGPT Deep Research",
      learn: "Find target customer profiles, buying triggers, competitor language, and market objections.",
      practice: "Research 20 potential customer types and rank them by urgency, budget, and fit.",
      proof: "Bring a target account or target segment list with evidence-backed reasons."
    },
    {
      type: "CRM",
      name: "HubSpot AI",
      learn: "Capture leads, score contacts, summarize activity, draft follow-ups, and manage pipeline stages.",
      practice: "Build a simple CRM workflow for new lead, qualified lead, proposal sent, and follow-up due.",
      proof: "Show a lead pipeline and explain how AI reduces missed follow-ups."
    },
    {
      type: "Campaigns",
      name: "Mailchimp, Brevo, or HubSpot Marketing Hub",
      learn: "Create email sequences, segment audiences, personalize messages, and measure engagement.",
      practice: "Create a three-email nurture sequence for one customer segment.",
      proof: "Show the sequence, subject lines, audience segment, and success metrics."
    },
    {
      type: "Automation",
      name: "Zapier, Make, or n8n",
      learn: "Connect forms, landing pages, CRM, email, spreadsheets, and notifications into one marketing workflow.",
      practice: "Design an automation where a new lead creates a CRM record, drafts a reply, and alerts the owner.",
      proof: "Show the workflow diagram and explain time saved plus revenue impact."
    },
    {
      type: "Creative",
      name: "Canva AI or Microsoft Designer",
      learn: "Produce simple campaign assets, one-pagers, landing page visuals, and social posts.",
      practice: "Create a one-page campaign asset that explains your AI-powered business improvement.",
      proof: "Use the asset as a portfolio example of AI-enabled marketing execution."
    }
  ];

  const automationTools = [
    {
      type: "Automation",
      name: "Zapier, Make, or n8n",
      learn: "Build no-code workflows that connect forms, email, spreadsheets, databases, and notifications.",
      practice: "Map one manual process and design the trigger, actions, exceptions, and owner alerts.",
      proof: "Show the automation map and expected time savings."
    },
    {
      type: "Agent",
      name: "OpenAI Assistants or custom GPTs",
      learn: "Create an assistant that uses instructions, examples, and domain context to handle repeatable tasks.",
      practice: "Write instructions for an assistant that drafts first-pass responses or summaries.",
      proof: "Show the assistant prompt, sample input, and sample output."
    },
    {
      type: "Data",
      name: "Airtable or Google Sheets",
      learn: "Use simple databases as the control center for AI workflows.",
      practice: "Create a tracker with status, owner, next action, and AI-generated summary fields.",
      proof: "Show how the tracker makes work visible and repeatable."
    },
    {
      type: "Productivity",
      name: "Microsoft Copilot or Google Gemini",
      learn: "Automate everyday documents, email summaries, action items, and meeting follow-ups.",
      practice: "Turn a meeting transcript into decisions, action items, and stakeholder updates.",
      proof: "Show the before-and-after meeting workflow."
    }
  ];

  const analyticsTools = [
    {
      type: "Analysis",
      name: "ChatGPT Advanced Data Analysis",
      learn: "Use AI to inspect spreadsheets, find patterns, explain drivers, and write decision summaries.",
      practice: "Analyze a small sample report and produce three insights plus recommended actions.",
      proof: "Show the analysis prompt, chart, and executive summary."
    },
    {
      type: "Spreadsheet",
      name: "Excel Copilot or Google Sheets AI",
      learn: "Generate formulas, clean data, summarize tables, and create analysis narratives.",
      practice: "Build a KPI table with AI-generated commentary for each metric.",
      proof: "Show the spreadsheet and explain how AI improved the workflow."
    },
    {
      type: "Dashboard",
      name: "Power BI or Looker Studio",
      learn: "Connect metrics to visual dashboards and concise business narratives.",
      practice: "Create a dashboard brief that explains what changed, why it matters, and what to do.",
      proof: "Show a dashboard screenshot plus the decision narrative."
    },
    {
      type: "Document",
      name: "Claude",
      learn: "Summarize long reports and extract risks, open questions, and recommendations.",
      practice: "Turn a long business document into an executive memo.",
      proof: "Show the memo structure and the source evidence used."
    }
  ];

  if (focus === "growth") {
    return growthTools;
  }

  if (focus === "marketingAutomation") {
    return marketingAutomationTools;
  }

  if (focus === "automation") {
    return automationTools;
  }

  if (focus === "analytics") {
    return analyticsTools;
  }

  return domain === "Financial" ? financialTools : propertyTools;
}

function updateTrainingOffer(user) {
  if (!trainingOfferTitle || !trainingOfferSummary) {
    return;
  }

  const firstName = user?.firstName || splitName(user?.name).firstName || "your";
  const domain = user?.domain || "your selected domain";
  const futureDirection = user?.futureDirection
    ? `your stated future direction (${user.futureDirection.slice(0, 90)})`
    : "your future direction once added";
  const resumePart = user?.resumeFileName
    ? `resume (${user.resumeFileName})`
    : "resume once uploaded";
  const linkedInPart = user?.linkedIn ? "LinkedIn profile" : "LinkedIn profile once added";

  trainingOfferTitle.textContent = `${firstName}'s Career Recovery Plan`;
  trainingOfferSummary.textContent =
    `A paid, personalized plan based on your ${linkedInPart}, ${resumePart}, ${domain} context, ${futureDirection}, saved profile notes, and interview history.`;

  if (careerPathCopy) {
    careerPathCopy.textContent =
      `Reposition your ${domain} experience into AI-ready roles, skill gaps, and a practical weekly plan.`;
  }

  if (domainPracticeCopy) {
    domainPracticeCopy.textContent =
      `Build portfolio exercises and job-search assets designed for ${domain}.`;
  }
}

async function loadAiTrainingPath() {
  if (!currentUser) {
    latestAiTrainingPath = null;
    if (aiPathRoleTitle) {
      renderAiTrainingPath(null);
    }
    renderAiPathSteps();
    return;
  }

  if (aiPathRoleTitle) {
    aiPathRoleTitle.textContent = "Generating your AI path...";
    aiPathOverview.textContent = "Reading your saved LinkedIn, resume, profile context, and interview records.";
    aiPathSkills.replaceChildren();
    aiPathActions.replaceChildren();
  }

  try {
    const response = await fetch("/api/ai-training/path");
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "Unable to generate AI path.");
    }

    latestAiTrainingPath = data.path || null;
    if (aiPathRoleTitle) {
      renderAiTrainingPath(data.path);
    }
    renderAiPathSteps();
  } catch (error) {
    latestAiTrainingPath = null;
    if (aiPathRoleTitle) {
      aiPathRoleTitle.textContent = "AI path needs profile context";
      aiPathOverview.textContent =
        error instanceof Error ? error.message : "Complete your profile and try again.";
    }
    renderAiPathSteps();
  }
}

function renderAiTrainingPath(path) {
  if (!path) {
    aiPathRoleTitle.textContent = "Complete your profile to generate your path";
    aiPathOverview.textContent = "Your path will use LinkedIn, resume, future direction, profile context, and recorded interviews.";
    aiPathSkills.replaceChildren();
    aiPathActions.replaceChildren();
    renderBootcampTools([]);
    renderAiProTraining(getAiProProgram(currentUser, null));
    return;
  }

  aiPathRoleTitle.textContent = path.roleTarget || "AI-enabled career path";
  aiPathOverview.textContent = path.overview || "";
  aiPathSkills.replaceChildren(
    ...(path.prioritySkills || []).map((skill) => {
      const pill = document.createElement("span");
      pill.textContent = skill;
      return pill;
    })
  );
  aiPathActions.replaceChildren(
    ...(path.nextActions || []).map((action) => {
      const item = document.createElement("li");
      item.textContent = action;
      return item;
    })
  );

  if (careerPathCopy) {
    careerPathCopy.textContent = path.moduleSummary || careerPathCopy.textContent;
  }

  if (domainPracticeCopy) {
    domainPracticeCopy.textContent = path.practiceLab || domainPracticeCopy.textContent;
  }

  renderBootcampTools(path.bootcampTools || []);
  renderAiProTraining(getAiProProgram(currentUser, path));
}

function renderBootcampTools(tools) {
  if (!bootcampTools) {
    return;
  }

  if (!tools.length) {
    const emptyState = document.createElement("article");
    emptyState.className = "bootcamp-tool-card";
    emptyState.innerHTML = `
      <span>Bootcamp</span>
      <strong>Complete your profile to generate tools</strong>
      <p>Add LinkedIn, resume, domain, and future direction to personalize the practice tools.</p>
    `;
    bootcampTools.replaceChildren(emptyState);
    return;
  }

  bootcampTools.replaceChildren(
    ...tools.map((tool) => {
      const card = document.createElement("article");
      card.className = "bootcamp-tool-card";

      const eyebrow = document.createElement("span");
      eyebrow.textContent = tool.category || "Tool";

      const title = document.createElement("strong");
      title.textContent = tool.name;

      const useCase = document.createElement("p");
      useCase.textContent = tool.useCase;

      const prompt = document.createElement("pre");
      prompt.textContent = tool.promptStarter;

      const exercise = document.createElement("p");
      exercise.className = "tool-exercise";
      exercise.textContent = `Exercise: ${tool.exercise}`;

      const output = document.createElement("p");
      output.className = "tool-output";
      output.textContent = `Output: ${tool.outputArtifact}`;

      card.replaceChildren(eyebrow, title, useCase, prompt, exercise, output);
      return card;
    })
  );
}

function renderAiProTraining(program) {
  renderToolStack(program.toolStack);
  renderLabOptions(program.labs);
  renderAgentOptions(program.agents);

  if (aiLabOutput && !aiLabOutput.children.length) {
    aiLabOutput.replaceChildren(createTrainingOutputEmpty("Choose a lab, describe a scenario, and generate a practice exercise."));
  }

  if (agentBlueprintOutput && !agentBlueprintOutput.children.length) {
    agentBlueprintOutput.replaceChildren(createTrainingOutputEmpty("Choose an agent type and describe a business problem to generate a blueprint."));
  }
}

function renderToolStack(tools) {
  if (!toolStackGrid) {
    return;
  }

  toolStackGrid.replaceChildren(
    ...tools.map((tool) => {
      const card = document.createElement("article");
      card.className = "tool-stack-card";
      card.innerHTML = `
        <span>${escapeHtml(tool.category)}</span>
        <strong>${escapeHtml(tool.name)}</strong>
        <p>${escapeHtml(tool.useFor)}</p>
        <div class="tool-meta-row"><b>Best for</b><em>${escapeHtml(tool.bestFor)}</em></div>
        <div class="tool-meta-row"><b>Practice</b><em>${escapeHtml(tool.practice)}</em></div>
        <div class="tool-meta-row"><b>Interview proof</b><em>${escapeHtml(tool.interviewProof)}</em></div>
      `;
      return card;
    })
  );
}

function renderLabOptions(labs) {
  if (!aiLabSelect) {
    return;
  }

  aiLabSelect.replaceChildren(
    ...labs.map((lab) => {
      const option = document.createElement("option");
      option.value = lab.id;
      option.textContent = lab.title;
      return option;
    })
  );
}

function renderAgentOptions(agents) {
  if (!agentTypeSelect) {
    return;
  }

  agentTypeSelect.replaceChildren(
    ...agents.map((agent) => {
      const option = document.createElement("option");
      option.value = agent.id;
      option.textContent = agent.name;
      return option;
    })
  );
}

function runAiProLab() {
  const program = getAiProProgram(currentUser, null);
  const lab = program.labs.find((item) => item.id === aiLabSelect?.value) || program.labs[0];
  const scenario = cleanInput(aiLabScenarioInput?.value) || lab.defaultScenario;
  const domain = normalizeClientDomain(currentUser?.domain);
  const profileAnchor = buildClientProfileAnchor(currentUser);

  aiLabOutput?.replaceChildren(createTrainingOutputCard({
    title: `${lab.title}: Training Exercise`,
    sections: [
      { heading: "Skill you are building", body: lab.skill },
      { heading: "Your domain scenario", body: scenario },
      {
        heading: "Prompt to practice",
        body: [
          `Act as an AI-enabled ${domain} professional.`,
          `My background/context: ${profileAnchor}.`,
          `Task: ${lab.task}`,
          `Scenario: ${scenario}`,
          `Constraints: ${lab.constraints.join("; ")}.`,
          `Return: ${lab.outputFormat}.`,
          "Before finalizing, identify missing information, risks, and how a human should validate the result."
        ].join("\n")
      },
      { heading: "How to judge the AI output", list: lab.evaluation },
      { heading: "Business value story", body: lab.businessValue },
      { heading: "Portfolio artifact", body: lab.artifact }
    ]
  }));
}

function buildAgentBlueprint() {
  const program = getAiProProgram(currentUser, null);
  const agent = program.agents.find((item) => item.id === agentTypeSelect?.value) || program.agents[0];
  const problem = cleanInput(agentProblemInput?.value) || agent.defaultProblem;
  const domain = normalizeClientDomain(currentUser?.domain);
  const profileAnchor = buildClientProfileAnchor(currentUser);

  agentBlueprintOutput?.replaceChildren(createTrainingOutputCard({
    title: `${agent.name} Blueprint`,
    sections: [
      { heading: "Business problem", body: problem },
      { heading: "Agent goal", body: agent.goal },
      {
        heading: "Instructions",
        body: [
          `You are a ${agent.name} for ${domain}.`,
          `Use this professional context when tailoring recommendations: ${profileAnchor}.`,
          `Primary objective: ${agent.goal}`,
          `When given an input, produce ${agent.output}.`,
          "Ask for missing information when risk, cost, compliance, or customer impact is unclear.",
          "Keep a human-in-the-loop for final decisions."
        ].join("\n")
      },
      { heading: "Knowledge this agent needs", list: agent.knowledge },
      { heading: "Inputs", list: agent.inputs },
      { heading: "Workflow", list: agent.workflow },
      { heading: "Tools/software to connect", list: agent.tools },
      { heading: "Guardrails", list: agent.guardrails },
      { heading: "Success metrics", list: agent.metrics },
      {
        heading: "Interview story",
        body: `I designed a ${agent.name} that improves ${problem}. It uses domain knowledge, structured prompts, and human review to create faster, more consistent decisions while reducing operational risk.`
      }
    ]
  }));
}

function createTrainingOutputCard({ title, sections }) {
  const card = document.createElement("article");
  card.className = "training-output-card";
  card.innerHTML = `<h4>${escapeHtml(title)}</h4>`;

  sections.forEach((section) => {
    const block = document.createElement("section");
    block.innerHTML = `<strong>${escapeHtml(section.heading)}</strong>`;

    if (section.list) {
      const list = document.createElement("ul");
      list.replaceChildren(...section.list.map((item) => {
        const li = document.createElement("li");
        li.textContent = item;
        return li;
      }));
      block.append(list);
    } else {
      const node = section.body?.includes("\n") ? document.createElement("pre") : document.createElement("p");
      node.textContent = section.body || "";
      block.append(node);
    }

    card.append(block);
  });

  return card;
}

function createTrainingOutputEmpty(message) {
  const item = document.createElement("p");
  item.className = "training-output-empty";
  item.textContent = message;
  return item;
}

function getAiProProgram(user, path) {
  const domain = normalizeClientDomain(user?.domain);
  const roleTarget = path?.roleTarget || (domain === "Financial Management"
    ? "AI-Enabled Financial Management Professional"
    : "AI-Enabled Property Management Professional");

  return domain === "Financial Management"
    ? getFinancialAiProProgram(roleTarget)
    : getPropertyAiProProgram(roleTarget);
}

function getPropertyAiProProgram(roleTarget) {
  return {
    toolStack: [
      createTool("Reasoning + Agents", "ChatGPT / OpenAI", "Build property operations prompts, analyze messy requests, create structured outputs, and prototype agents.", "Maintenance triage, tenant response, owner summaries, workflow design.", "Classify a maintenance request by urgency, vendor, owner approval, risk, and next action.", `Show a before/after workflow for ${roleTarget}.`),
      createTool("Document Reasoning", "Claude", "Review leases, SOPs, policies, vendor scopes, owner packets, and long documents.", "Lease issue summaries, policy comparison, SOP rewrite, owner packet review.", "Summarize a vendor scope and identify missing cost/risk details.", "Explain how long-document AI review reduces missed details."),
      createTool("Workspace AI", "Microsoft Copilot / Google Gemini", "Draft emails, summarize meetings, analyze Sheets/Excel data, and create presentations.", "Owner updates, vacancy reports, renewal summaries, KPI narratives.", "Turn operational notes into an owner-ready update with decision needed.", "Show how AI improves communication speed and consistency."),
      createTool("Automation", "Zapier / Make / n8n", "Connect intake forms, email, spreadsheets, task tools, and notifications into workflows.", "Tenant request intake, vendor routing, escalation alerts, weekly owner reporting.", "Map a trigger-action workflow for new maintenance requests.", "Describe a human-reviewed automation that saves coordinator time."),
      createTool("Operations Database", "Airtable / Notion / Google Sheets", "Track requests, vendors, properties, approval status, and AI-generated summaries.", "Lightweight property ops dashboards and portfolio demos.", "Design a maintenance triage table with status, urgency, vendor, risk, and recommendation.", "Show a simple AI-enabled operating system prototype.")
    ],
    labs: [
      createLab("maintenance_triage", "Maintenance Triage With AI", "Classify requests and recommend next action.", "Classify the issue by urgency, likely trade/vendor, resident impact, owner approval need, compliance/safety risk, and next action.", ["Do not overstate certainty", "Escalate safety/compliance risk", "Separate tenant message from internal recommendation"], "A table with urgency, vendor, risk, approval need, next action, tenant message, and manager note", ["Urgency is justified", "Risk is explicit", "Vendor/trade is plausible", "Human approval is clear", "Tenant tone is professional"], "Reduces misrouting, speeds response, and creates consistent maintenance decisions.", "Maintenance triage prompt + sample output", "A tenant reports water leaking under the kitchen sink on a Friday afternoon."),
      createLab("tenant_communication", "Tenant Communication Coach", "Use AI to draft clear, empathetic, policy-safe tenant messages.", "Draft a tenant-facing response and an internal note for the property manager.", ["Keep tone calm and professional", "Avoid legal promises", "Include next steps and timing"], "Tenant message, internal note, follow-up checklist", ["Tone matches situation", "Next steps are concrete", "No unsafe promises", "Escalation is clear"], "Improves tenant experience and reduces inconsistent communication.", "Tenant message prompt library", "A resident is upset that a repair has been delayed twice."),
      createLab("owner_reporting", "Owner Reporting With AI", "Turn operations facts into owner-ready decisions.", "Summarize the issue, business impact, options, recommendation, and decision needed.", ["Be concise", "Separate facts from recommendations", "Include cost/risk if known"], "Owner update with issue, impact, options, recommendation, and approval request", ["Decision needed is clear", "Tradeoffs are visible", "Owner economics are addressed"], "Turns operational noise into decision-ready owner communication.", "Owner update template", "A roof repair bid came in higher than expected and needs owner approval."),
      createLab("vendor_bid", "Vendor Bid Comparison", "Use AI to compare vendor proposals and expose tradeoffs.", "Compare vendors by scope, cost, timing, risk, missing information, and recommendation.", ["Do not choose purely on price", "Flag missing scope details", "Recommend human verification"], "Vendor comparison table and recommendation", ["Scope differences are visible", "Risk is explained", "Recommendation is defensible"], "Improves vendor decisions and reduces avoidable cost/risk.", "Vendor comparison worksheet", "Three vendors submitted different bids for the same HVAC replacement.")
    ],
    agents: [
      createAgent("maintenance_agent", "Maintenance Triage Agent", "Classify maintenance requests and route them to the right next action.", "urgency, vendor/trade, resident impact, owner approval, risk, tenant message, manager note", ["Maintenance categories", "Vendor list", "Approval thresholds", "Property rules", "Emergency policy"], ["Tenant request", "Property/unit", "Issue description", "Photos if available", "Time sensitivity"], ["Intake request", "Classify urgency", "Identify vendor/trade", "Check approval/risk", "Draft tenant response", "Create manager task"], ["ChatGPT/OpenAI", "Airtable or Sheets", "Zapier/Make", "Email/SMS tool"], ["Escalate safety issues", "Require human approval for cost/legal issues", "Do not diagnose beyond evidence"], ["Response time", "Correct routing rate", "Escalation accuracy", "Tenant satisfaction"], "A property team receives many maintenance requests and needs consistent triage."),
      createAgent("owner_report_agent", "Owner Reporting Agent", "Convert property operations data into owner-ready updates and decisions.", "summary, key changes, risks, recommendation, decision needed", ["Owner reporting format", "Portfolio KPIs", "Budget/approval thresholds", "Recent maintenance/leasing events"], ["Operational notes", "KPIs", "Open issues", "Costs", "Recommendation needed"], ["Collect facts", "Summarize impact", "Identify options", "Recommend action", "Draft owner update"], ["Claude or ChatGPT", "Sheets/Excel", "Docs/Word", "Email"], ["Separate facts from recommendations", "Flag missing financials", "Human review before sending"], ["Report prep time", "Approval speed", "Owner clarity", "Fewer follow-up questions"], "Owners need concise updates and clear decisions, not raw operational noise."),
      createAgent("leasing_agent", "Vacancy Marketing Agent", "Create compliant, compelling listing and lead-response content.", "listing copy, channel variants, lead response, follow-up sequence", ["Property details", "Fair housing guardrails", "Amenities", "Pricing", "Local market notes"], ["Unit details", "Target renter", "Amenities", "Availability", "Policies"], ["Generate listing", "Create channel variants", "Draft lead response", "Suggest follow-up", "Flag compliance risk"], ["ChatGPT", "Canva", "CRM/email", "Listings platform"], ["Avoid discriminatory language", "Verify property facts", "Human review for compliance"], ["Lead response time", "Listing quality", "Conversion rate", "Vacancy days"], "A vacant unit needs faster, higher-quality marketing and lead follow-up.")
    ]
  };
}

function getFinancialAiProProgram(roleTarget) {
  return {
    toolStack: [
      createTool("Reasoning + Structured Outputs", "ChatGPT / OpenAI", "Analyze finance narratives, generate structured variance explanations, and prototype reporting agents.", "Variance review, executive summaries, forecast assumptions, risk flags.", "Explain actual vs budget and recommend follow-up actions.", `Show how ${roleTarget} uses AI to turn numbers into decisions.`),
      createTool("Long Document Analysis", "Claude", "Review policy docs, board materials, management commentary, controls, and long reports.", "Narrative quality, risk identification, management summary review.", "Critique a monthly report for missing drivers and weak assumptions.", "Explain how AI improves review quality without replacing judgment."),
      createTool("Spreadsheet + Workspace AI", "Excel Copilot / Gemini for Sheets", "Analyze spreadsheets, summarize trends, create charts, and draft finance narratives.", "KPI summaries, variance notes, forecast pack drafts.", "Turn KPI movements into an executive-ready narrative.", "Show how AI reduces manual reporting cycles."),
      createTool("Automation", "Power Automate / Zapier / Make", "Move reporting inputs, reminders, approvals, and recurring summaries across systems.", "Monthly close reminders, report routing, approval workflows.", "Design a workflow that collects variance comments and creates a draft summary.", "Describe controls-aware automation with human review."),
      createTool("BI + Dashboards", "Power BI / Looker Studio", "Create AI-supported KPI monitoring and decision dashboards.", "Variance dashboards, cash/risk monitors, performance summaries.", "Define metrics and alert thresholds for a finance dashboard.", "Show business impact through decision-ready visibility.")
    ],
    labs: [
      createLab("variance_analysis", "Variance Analysis With AI", "Explain budget vs actual movement and recommend next steps.", "Analyze the variance, identify likely drivers, business risk, questions to ask, and next action.", ["Do not invent causes", "Separate known facts from hypotheses", "Recommend validation steps"], "Variance explanation, driver hypotheses, risk level, questions, and action plan", ["Drivers are plausible", "Unknowns are labeled", "Action is clear", "Risk is quantified where possible"], "Improves reporting speed and decision quality.", "Variance analysis prompt + sample narrative", "Revenue is 8 percent below forecast while operating expenses are 5 percent above budget."),
      createLab("forecast_review", "Forecast Assumption Review", "Use AI to pressure-test assumptions.", "Review assumptions for optimism, missing risks, sensitivity, and validation needs.", ["Flag weak assumptions", "Suggest sensitivity checks", "Do not claim certainty"], "Assumption review table with risk, evidence needed, and recommended adjustment", ["Risks are specific", "Validation is actionable", "Sensitivity is included"], "Helps leaders make better planning decisions.", "Forecast review checklist", "Next quarter forecast assumes faster collections and flat labor cost."),
      createLab("executive_summary", "Executive Summary Builder", "Turn financial facts into leadership-ready narrative.", "Write an executive summary with what changed, why it matters, risks, and decisions needed.", ["Be concise", "Lead with business impact", "Separate facts and recommendations"], "Executive summary, risks, decisions needed, and follow-up questions", ["Narrative is decision-ready", "Risks are explicit", "Next steps are clear"], "Makes finance a stronger decision partner.", "Executive summary template", "Monthly results show mixed KPI performance and uncertain cash timing."),
      createLab("kpi_story", "KPI Narrative Coach", "Explain KPI movement in business language.", "Interpret KPI changes and write a clear business story for leaders.", ["Avoid jargon", "Connect metrics to operations", "Identify what to monitor next"], "KPI narrative with interpretation, causes to validate, and next action", ["Story is clear", "Operational drivers are included", "Monitoring plan is practical"], "Improves communication between finance and operations.", "KPI narrative prompt library", "Occupancy, revenue, margin, and collections all moved in different directions.")
    ],
    agents: [
      createAgent("variance_agent", "Variance Analysis Agent", "Explain budget vs actual movement and route follow-up questions.", "variance summary, likely drivers, risk, validation questions, recommended action", ["Chart of accounts", "Budget/forecast data", "Variance thresholds", "Business unit context"], ["Actuals", "Budget", "Forecast", "Comments", "Thresholds"], ["Load variance", "Classify materiality", "Draft explanation", "List validation questions", "Recommend action"], ["OpenAI/ChatGPT", "Excel/Sheets", "Power BI", "Power Automate"], ["Do not invent drivers", "Flag missing data", "Human approval before leadership report"], ["Report cycle time", "Comment quality", "Escalation accuracy", "Forecast adjustment quality"], "Finance teams need faster, better explanations for material variances."),
      createAgent("executive_summary_agent", "Executive Summary Agent", "Turn finance inputs into concise leadership-ready summaries.", "what changed, why it matters, risk, recommendation, decision needed", ["Reporting calendar", "Executive format", "KPI definitions", "Risk thresholds"], ["Monthly results", "KPI movement", "Variance notes", "Business context"], ["Collect inputs", "Find key changes", "Draft narrative", "Identify decisions", "Create follow-up questions"], ["Claude or ChatGPT", "Excel/Sheets", "Docs/Word", "PowerPoint"], ["Separate facts from interpretation", "Do not hide uncertainty", "Human review required"], ["Summary prep time", "Leadership clarity", "Fewer revision cycles"], "Leaders need the story behind the numbers, not spreadsheet dumps."),
      createAgent("forecast_agent", "Forecast Assumption Agent", "Review forecast assumptions and identify risk areas.", "assumption table, risk score, sensitivity suggestion, validation plan", ["Forecast model", "Assumption history", "Business drivers", "Risk policy"], ["Forecast assumptions", "Actual trends", "Known risks", "Business constraints"], ["Review assumptions", "Compare to trends", "Flag risk", "Suggest sensitivity", "Draft questions"], ["ChatGPT/OpenAI", "Excel", "Power BI", "Power Automate"], ["Do not change official forecast automatically", "Escalate high-risk assumptions", "Keep audit trail"], ["Forecast accuracy", "Risk detection", "Review time", "Assumption quality"], "Forecasts often fail because assumptions are not challenged early enough.")
    ]
  };
}

function createTool(category, name, useFor, bestFor, practice, interviewProof) {
  return { category, name, useFor, bestFor, practice, interviewProof };
}

function createLab(id, title, skill, task, constraints, outputFormat, evaluation, businessValue, artifact, defaultScenario) {
  return { id, title, skill, task, constraints, outputFormat, evaluation, businessValue, artifact, defaultScenario };
}

function createAgent(id, name, goal, output, knowledge, inputs, workflow, tools, guardrails, metrics, defaultProblem) {
  return { id, name, goal, output, knowledge, inputs, workflow, tools, guardrails, metrics, defaultProblem };
}

function normalizeClientDomain(domain) {
  return domain === "Financial" ? "Financial Management" : domain || "Property Management";
}

function buildClientProfileAnchor(user) {
  if (!user) {
    return "profile not completed yet";
  }

  return [
    user.name || "the learner",
    normalizeClientDomain(user.domain),
    user.resumeFileName ? `resume: ${user.resumeFileName}` : "resume not uploaded",
    user.linkedIn ? "LinkedIn profile available" : "LinkedIn not added",
    user.futureDirection ? `future direction: ${user.futureDirection}` : ""
  ].filter(Boolean).join("; ");
}

function cleanInput(value) {
  return String(value || "").trim();
}

async function loadDecisionKnowledge() {
  if (!knowledgeStatus || !knowledgeDomainInput) {
    return;
  }

  if (!currentUser) {
    renderDecisionKnowledge(null);
    return;
  }

  const domain = knowledgeDomainInput.value || currentUser.domain || "Property Management";
  knowledgeStatus.textContent = "Loading decision knowledge...";

  try {
    const response = await fetch(`/api/knowledge?domain=${encodeURIComponent(domain)}`);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "Unable to load decision knowledge.");
    }

    renderDecisionKnowledge(data);
  } catch (error) {
    knowledgeStatus.textContent =
      error instanceof Error ? error.message : "Unable to load decision knowledge.";
    knowledgeStatus.dataset.state = "error";
  }
}

function addTestInterviewTurn(values = {}) {
  if (!testInterviewTurns) {
    return;
  }

  const index = testInterviewTurns.children.length + 1;
  const row = document.createElement("article");
  row.className = "test-turn-row";
  row.dataset.testTurn = "true";
  row.innerHTML = `
    <div class="test-turn-head">
      <strong>Q/A ${index}</strong>
      <button type="button" aria-label="Remove Q/A">Remove</button>
    </div>
    <label>
      <span>Question</span>
      <textarea data-test-question rows="2" placeholder="What question would Alma ask?">${escapeHtml(values.question || "")}</textarea>
    </label>
    <label>
      <span>Answer</span>
      <textarea data-test-answer rows="3" placeholder="What would the interviewee answer?">${escapeHtml(values.answer || "")}</textarea>
    </label>
  `;
  row.querySelector("button")?.addEventListener("click", () => {
    row.remove();

    if (!testInterviewTurns.children.length) {
      addTestInterviewTurn();
    }
  });
  testInterviewTurns.append(row);
}

async function saveTestInterview(event) {
  event.preventDefault();

  if (!currentUser || !testInterviewForm || !testInterviewTurns || !knowledgeDomainInput) {
    return;
  }

  setTestInterviewStatus("Processing test interview...", false);

  const turns = [...testInterviewTurns.querySelectorAll("[data-test-turn]")].map((row) => ({
    question: row.querySelector("[data-test-question]")?.value || "",
    answer: row.querySelector("[data-test-answer]")?.value || ""
  }));

  try {
    const response = await fetch("/api/test-interviews", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title: testInterviewTitleInput?.value || "",
        domain: knowledgeDomainInput.value,
        turns
      })
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "Unable to process test interview.");
    }

    const created = data.interview || {};
    setTestInterviewStatus(
      `Saved test interview #${created.id}. Created ${created.decisionCases || 0} decision cases from ${created.transcriptTurns || 0} transcript turns.`,
      false
    );
    await loadDecisionKnowledge();
    await loadInterviewHistory({ silent: true });
  } catch (error) {
    setTestInterviewStatus(error instanceof Error ? error.message : "Unable to process test interview.", true);
  }
}

function setTestInterviewStatus(message, isError) {
  if (!testInterviewStatus) {
    return;
  }

  testInterviewStatus.textContent = message;
  testInterviewStatus.dataset.state = isError ? "error" : "info";
}

function renderDecisionKnowledge(data) {
  if (!knowledgeSummaryGrid || !knowledgeConcepts || !knowledgeRelationships || !knowledgeCases || !knowledgeStatus) {
    return;
  }

  knowledgeSummaryGrid.replaceChildren();
  knowledgeConcepts.replaceChildren();
  knowledgeRelationships.replaceChildren();
  knowledgeCases.replaceChildren();

  if (!data) {
    knowledgeStatus.textContent = "Sign in to view the Decisions Knowledge layer.";
    return;
  }

  const concepts = data.concepts || [];
  const relationships = data.relationships || [];
  const cases = data.decisionCases || [];

  knowledgeStatus.dataset.state = "info";
  knowledgeStatus.textContent =
    `${data.domain} uses a shared decision spine plus a domain-specific UDM module.`;

  knowledgeSummaryGrid.replaceChildren(
    createKnowledgeMetric("UDM concepts", concepts.length),
    createKnowledgeMetric("Graph links", relationships.length),
    createKnowledgeMetric("Decision cases", cases.length),
    createKnowledgeMetric("Model", "Shared + Domain")
  );

  knowledgeConcepts.replaceChildren(
    ...(concepts.length
      ? concepts.map((concept) => createKnowledgeListItem(
          concept.label,
          `${concept.domain} / ${concept.type}`,
          concept.description || concept.key
        ))
      : [createKnowledgeEmpty("No UDM concepts found for this domain yet.")])
  );

  knowledgeRelationships.replaceChildren(
    ...(relationships.length
      ? relationships.map((relationship) => createKnowledgeListItem(
          `${relationship.source} -> ${relationship.target}`,
          `${relationship.domain} / ${relationship.type}`,
          relationship.description || "Semantic relationship"
        ))
      : [createKnowledgeEmpty("No graph relationships found for this domain yet.")])
  );

  knowledgeCases.replaceChildren(
    ...(cases.length
      ? cases.map(createDecisionCaseCard)
      : [createKnowledgeEmpty("No decision cases extracted yet. Complete interviews to grow this domain layer.")])
  );
}

function createKnowledgeMetric(label, value) {
  const item = document.createElement("article");
  item.className = "knowledge-metric";
  item.innerHTML = `
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
  `;
  return item;
}

function createKnowledgeListItem(title, meta, body) {
  const item = document.createElement("article");
  item.className = "knowledge-list-item";
  item.innerHTML = `
    <div>
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(meta)}</span>
    </div>
    <p>${escapeHtml(body)}</p>
  `;
  return item;
}

function createDecisionCaseCard(item) {
  const card = document.createElement("article");
  card.className = "decision-case-card";
  const signals = (item.signals || []).slice(0, 4);
  const constraints = (item.constraints || []).slice(0, 4);
  const actions = (item.actions || []).slice(0, 4);

  card.innerHTML = `
    <div class="decision-case-head">
      <div>
        <span>${escapeHtml(item.useCase || "Decision case")}</span>
        <strong>${escapeHtml(item.title || item.decision || "Untitled decision")}</strong>
      </div>
      <span>${escapeHtml(item.confidence || "draft")}</span>
    </div>
    <p>${escapeHtml(item.pattern || item.context || item.decision || "")}</p>
    <div class="decision-chip-row">
      ${signals.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}
      ${constraints.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}
      ${actions.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}
    </div>
  `;
  return card;
}

function createKnowledgeEmpty(message) {
  const empty = document.createElement("p");
  empty.className = "recordings-empty";
  empty.textContent = message;
  return empty;
}

function getSavedUser() {
  if (currentUser) {
    return currentUser;
  }

  try {
    return JSON.parse(localStorage.getItem("interviewMePreviewUser"));
  } catch {
    return null;
  }
}
