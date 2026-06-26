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
  if (!aiPathRoleTitle) {
    return;
  }

  if (!currentUser) {
    renderAiTrainingPath(null);
    return;
  }

  aiPathRoleTitle.textContent = "Generating your AI path...";
  aiPathOverview.textContent = "Reading your saved LinkedIn, resume, profile context, and interview records.";
  aiPathSkills.replaceChildren();
  aiPathActions.replaceChildren();

  try {
    const response = await fetch("/api/ai-training/path");
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "Unable to generate AI path.");
    }

    renderAiTrainingPath(data.path);
  } catch (error) {
    aiPathRoleTitle.textContent = "AI path needs profile context";
    aiPathOverview.textContent =
      error instanceof Error ? error.message : "Complete your profile and try again.";
  }
}

function renderAiTrainingPath(path) {
  if (!path) {
    aiPathRoleTitle.textContent = "Complete your profile to generate your path";
    aiPathOverview.textContent = "Your path will use LinkedIn, resume, future direction, profile context, and recorded interviews.";
    aiPathSkills.replaceChildren();
    aiPathActions.replaceChildren();
    renderBootcampTools([]);
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
