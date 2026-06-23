const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

loadEnvFile(path.join(__dirname, ".env"));

const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "127.0.0.1";
const tavusApiKey = process.env.TAVUS_API_KEY || "";
const googleClientId = process.env.GOOGLE_CLIENT_ID || "";
const publicCallbackBaseUrl = cleanEnvValue(process.env.PUBLIC_CALLBACK_BASE_URL || "");
const publicDir = __dirname;
const databasePath = path.join(__dirname, "data", "interview-me.sqlite");
const db = openDatabase(databasePath);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/config") {
      sendJson(res, 200, {
        googleClientId,
        tavusPersonaId: "p68693404eba",
        tavusReplicaId: ""
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/session") {
      sendJson(res, 200, { user: getSessionUser(req) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/profile") {
      const user = getSessionUser(req);
      sendJson(res, user ? 200 : 401, user ? { user } : { error: "Sign in to view profile." });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ai-training/path") {
      getAiTrainingPath(req, res);
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/profile") {
      await updateProfile(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/google") {
      await authenticateGoogleUser(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      logoutUser(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/tavus/conversations") {
      await createTavusConversation(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/tavus/callback") {
      await handleTavusCallback(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/tavus/utterance") {
      await handleTavusUtterance(req, res);
      return;
    }

    const endMatch = url.pathname.match(/^\/api\/tavus\/conversations\/([^/]+)\/end$/);
    if (req.method === "POST" && endMatch) {
      await endTavusConversation(endMatch[1], res);
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    serveStatic(url.pathname, res);
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Unexpected server error"
    });
  }
});

server.listen(port, host, () => {
  console.log(`Interview Me app listening on http://${host}:${port}`);
});

async function createTavusConversation(req, res) {
  const sessionUser = getSessionUser(req);

  if (!sessionUser) {
    sendJson(res, 401, { error: "Sign in before starting an interview." });
    return;
  }

  if (!hasInterviewProfile(sessionUser)) {
    sendJson(res, 400, {
      error: "Complete your Profile first. LinkedIn, Domain, and Resume are required before starting an interview."
    });
    return;
  }

  if (!tavusApiKey) {
    sendJson(res, 500, {
      error: "Missing TAVUS_API_KEY. Add it to interview-me-app/.env and restart the server."
    });
    return;
  }

  const body = await readJsonBody(req);
  const personaId = cleanValue(body.persona_id);
  const replicaId = cleanValue(body.replica_id);
  const now = new Date().toISOString();
  const profileSnapshot = JSON.stringify({
    userId: sessionUser.id,
    name: sessionUser.name,
    email: sessionUser.email,
    firstName: sessionUser.firstName,
    lastName: sessionUser.lastName,
    linkedIn: sessionUser.linkedIn,
    domain: sessionUser.domain,
    resumeFileName: sessionUser.resumeFileName,
    personalContext: sessionUser.personalContext
  });

  if (!personaId && !replicaId) {
    sendJson(res, 400, { error: "Add a Tavus persona_id or replica_id." });
    return;
  }

  const localSession = db.prepare(`
    INSERT INTO interview_sessions (
      user_id, domain, status, persona_id, replica_id, profile_snapshot_json, started_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionUser.id,
    sessionUser.domain,
    "creating",
    personaId,
    replicaId,
    profileSnapshot,
    now,
    now,
    now
  );

  const localSessionId = Number(localSession.lastInsertRowid);
  const callbackUrl = publicCallbackBaseUrl
    ? `${publicCallbackBaseUrl.replace(/\/$/, "")}/api/tavus/callback`
    : "";
  const utteranceUrl = publicCallbackBaseUrl
    ? `${publicCallbackBaseUrl.replace(/\/$/, "")}/api/tavus/utterance`
    : "";

  const tavusResponse = await fetch("https://tavusapi.com/v2/conversations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": tavusApiKey
    },
    body: JSON.stringify({
      ...(personaId ? { persona_id: personaId } : {}),
      ...(replicaId ? { replica_id: replicaId } : {}),
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
      conversation_name: cleanValue(body.conversation_name) || "Interview Me",
      conversational_context: buildConversationContext(sessionUser)
    })
  });

  const data = await tavusResponse.json().catch(() => ({}));

  if (!tavusResponse.ok) {
    markInterviewSession(localSessionId, {
      status: "failed",
      metadata: { tavus_error: data }
    });
    sendJson(res, tavusResponse.status, normalizeTavusError(data));
    return;
  }

  markInterviewSession(localSessionId, {
    status: "active",
    tavusConversationId: data.conversation_id,
    metadata: {
      tavus_response: data,
      callback_url: callbackUrl,
      utterance_url: utteranceUrl
    }
  });

  sendJson(res, 200, {
    ...data,
    local_session_id: localSessionId,
    transcript_capture: callbackUrl ? "callback_and_utterance_routes" : "public_callback_base_url_not_configured"
  });
}

function getAiTrainingPath(req, res) {
  const sessionUser = getSessionUser(req);

  if (!sessionUser) {
    sendJson(res, 401, { error: "Sign in to generate your AI path." });
    return;
  }

  const transcripts = getUserTranscriptContext(sessionUser.id);
  const path = generateAiTrainingPath(sessionUser, transcripts);
  sendJson(res, 200, { path });
}

async function handleTavusCallback(req, res) {
  const payload = await readJsonBody(req);
  const eventType = cleanValue(payload.event_type);
  const conversationId = cleanValue(payload.conversation_id);
  const timestamp = cleanValue(payload.timestamp) || new Date().toISOString();
  const session = conversationId ? getInterviewSessionByConversationId(conversationId) : null;

  if (!session) {
    sendJson(res, 202, { ok: true, stored: false, reason: "Unknown conversation_id" });
    return;
  }

  if (eventType === "application.transcription_ready") {
    const transcript = Array.isArray(payload.properties?.transcript)
      ? payload.properties.transcript
      : [];

    storeTranscriptTurns(session.id, transcript, payload);
    storeStructuredOutput(session.id, session.domain, transcript);
    markInterviewSession(session.id, {
      status: "transcribed",
      endedAt: timestamp,
      metadata: { last_callback: payload }
    });

    sendJson(res, 200, { ok: true, stored: true, turns: transcript.length });
    return;
  }

  if (isUtteranceEvent(eventType)) {
    const stored = storeUtteranceEvent(session.id, payload);
    markInterviewSession(session.id, {
      status: "active",
      metadata: { last_utterance_event: payload }
    });

    sendJson(res, 200, { ok: true, stored: Boolean(stored), event_type: eventType });
    return;
  }

  if (eventType === "system.shutdown") {
    markInterviewSession(session.id, {
      status: "ended",
      endedAt: timestamp,
      metadata: { last_callback: payload }
    });
  }

  sendJson(res, 200, { ok: true, stored: true, event_type: eventType });
}

async function handleTavusUtterance(req, res) {
  const payload = await readJsonBody(req);
  const conversationId = cleanValue(payload.conversation_id);
  const session = conversationId ? getInterviewSessionByConversationId(conversationId) : null;

  if (!session) {
    sendJson(res, 202, { ok: true, stored: false, reason: "Unknown conversation_id" });
    return;
  }

  const stored = storeUtteranceEvent(session.id, payload);
  markInterviewSession(session.id, {
    status: "active",
    metadata: { last_utterance_event: payload }
  });
  sendJson(res, 200, { ok: true, stored: Boolean(stored) });
}

async function authenticateGoogleUser(req, res) {
  if (!googleClientId) {
    sendJson(res, 500, {
      error: "Missing GOOGLE_CLIENT_ID. Add it to interview-me-app/.env and restart the server."
    });
    return;
  }

  const body = await readJsonBody(req);
  const credential = cleanValue(body.credential);

  if (!credential) {
    sendJson(res, 400, { error: "Missing Google credential." });
    return;
  }

  const profile = await verifyGoogleCredential(credential);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO users (google_sub, email, name, picture, email_verified, created_at, updated_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(google_sub) DO UPDATE SET
      email = excluded.email,
      name = excluded.name,
      picture = excluded.picture,
      email_verified = excluded.email_verified,
      updated_at = excluded.updated_at,
      last_login_at = excluded.last_login_at
  `).run(
    profile.sub,
    profile.email,
    profile.name,
    profile.picture,
    profile.email_verified === "true" ? 1 : 0,
    now,
    now,
    now
  );

  const user = db.prepare(`
    SELECT id, google_sub, email, name, first_name, last_name, linkedin, domain,
           picture, email_verified, created_at, updated_at, last_login_at
    FROM users
    WHERE google_sub = ?
  `).get(profile.sub);

  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();

  db.prepare(`
    INSERT INTO sessions (session_token, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(token, user.id, now, expiresAt);

  res.setHeader("Set-Cookie", buildSessionCookie(token, expiresAt));
  sendJson(res, 200, { user: serializeUser(user) });
}

function logoutUser(req, res) {
  const token = getSessionToken(req);

  if (token) {
    db.prepare("DELETE FROM sessions WHERE session_token = ?").run(token);
  }

  res.setHeader(
    "Set-Cookie",
    "interview_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  );
  sendJson(res, 200, { ok: true });
}

async function updateProfile(req, res) {
  const sessionUser = getSessionUser(req);

  if (!sessionUser) {
    sendJson(res, 401, { error: "Sign in to update profile." });
    return;
  }

  const body = await readJsonBody(req);
  const domain = cleanValue(body.domain);
  const allowedDomains = new Set(["", "Property Management", "Financial"]);

  if (!allowedDomains.has(domain)) {
    sendJson(res, 400, { error: "Select a valid domain." });
    return;
  }

  const now = new Date().toISOString();
  const firstName = cleanValue(body.firstName);
  const lastName = cleanValue(body.lastName);
  const resume = normalizeResumePayload(body.resume);

  if (resume && resume.contentBase64.length > 5 * 1024 * 1024) {
    sendJson(res, 400, { error: "Resume file is too large. Upload a file under 4 MB." });
    return;
  }

  db.prepare(`
    UPDATE users
    SET first_name = ?,
        last_name = ?,
        linkedin = ?,
        domain = ?,
        resume_file_name = COALESCE(?, resume_file_name),
        resume_mime_type = COALESCE(?, resume_mime_type),
        resume_size_bytes = COALESCE(?, resume_size_bytes),
        resume_content_base64 = COALESCE(?, resume_content_base64),
        resume_text = COALESCE(?, resume_text),
        resume_uploaded_at = COALESCE(?, resume_uploaded_at),
        updated_at = ?
    WHERE id = ?
  `).run(
    firstName,
    lastName,
    cleanValue(body.linkedIn),
    domain,
    resume?.fileName || null,
    resume?.mimeType || null,
    resume?.sizeBytes ?? null,
    resume?.contentBase64 || null,
    resume?.extractedText || null,
    resume ? now : null,
    now,
    sessionUser.id
  );

  upsertPersonalContext(sessionUser.id, {
    linkedIn: cleanValue(body.linkedIn),
    domain,
    personalContext: cleanValue(body.personalContext),
    futureDirection: cleanValue(body.futureDirection),
    resume,
    updatedAt: now
  });

  const user = getUserById(sessionUser.id);
  sendJson(res, 200, { user });
}

async function endTavusConversation(conversationId, res) {
  if (!tavusApiKey) {
    sendJson(res, 204, {});
    return;
  }

  const tavusResponse = await fetch(
    `https://tavusapi.com/v2/conversations/${encodeURIComponent(conversationId)}/end`,
    {
      method: "POST",
      headers: {
        "x-api-key": tavusApiKey
      }
    }
  );

  if (tavusResponse.status === 204) {
    res.writeHead(204);
    res.end();
    return;
  }

  const data = await tavusResponse.json().catch(() => ({}));
  sendJson(res, tavusResponse.ok ? 200 : tavusResponse.status, data);
}

function serveStatic(pathname, res) {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, requestPath));

  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const contentType = mimeTypes[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let rawBody = "";

    req.on("data", (chunk) => {
      rawBody += chunk;

      if (rawBody.length > 6 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body is too large"));
      }
    });

    req.on("end", () => {
      if (!rawBody) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch {
        reject(new Error("Invalid JSON request body"));
      }
    });
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function normalizeTavusError(data) {
  return {
    error: data.error || data.message || "Tavus request failed",
    details: data
  };
}

function cleanValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeResumePayload(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const fileName = cleanValue(value.fileName);
  const mimeType = cleanValue(value.mimeType) || "application/octet-stream";
  const contentBase64 = cleanValue(value.contentBase64);
  const extractedText = cleanValue(value.extractedText).slice(0, 20000);
  const sizeBytes = Number(value.sizeBytes || 0);

  if (!fileName || !contentBase64 || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return null;
  }

  return {
    fileName,
    mimeType,
    sizeBytes,
    contentBase64,
    extractedText
  };
}

function buildConversationContext(user) {
  const name = cleanValue(user?.name);
  const email = cleanValue(user?.email);
  const parts = ["This is a My Choice decision capture session started from the local web app."];

  if (name) {
    parts.push(`The signed-in user's name is ${name}.`);
  }

  if (email) {
    parts.push(`The signed-in user's email is ${email}.`);
  }

  if (user?.linkedIn) {
    parts.push(`LinkedIn profile URL: ${user.linkedIn}.`);
  }

  if (user?.domain) {
    parts.push(`Business domain: ${user.domain}.`);
  }

  if (user?.resumeFileName) {
    parts.push(`Resume file on record: ${user.resumeFileName}.`);
  }

  if (user?.resumeText) {
    parts.push(`Resume context: ${user.resumeText.slice(0, 3000)}`);
  }

  if (user?.personalContext) {
    parts.push(`Personal context: ${user.personalContext}`);
  }

  if (user?.futureDirection) {
    parts.push(`Future career direction: ${user.futureDirection}`);
  }

  return parts.join(" ");
}

function hasInterviewProfile(user) {
  return Boolean(cleanValue(user?.linkedIn) && cleanValue(user?.domain) && cleanValue(user?.resumeFileName));
}

function getUserTranscriptContext(userId) {
  return db.prepare(`
    SELECT t.speaker, t.speaker_role, t.text, t.created_at, i.domain, i.tavus_conversation_id
    FROM conversation_transcripts t
    JOIN interview_sessions i ON i.id = t.session_id
    WHERE i.user_id = ?
    ORDER BY t.created_at ASC, t.id ASC
    LIMIT 80
  `).all(userId);
}

function generateAiTrainingPath(user, transcripts) {
  const domain = cleanValue(user.domain) || "your domain";
  const transcriptText = transcripts.map((turn) => turn.text).join(" ").slice(0, 6000);
  const resumeText = cleanValue(user.resumeText).slice(0, 6000);
  const personalContext = cleanValue(user.personalContext);
  const futureDirection = cleanValue(user.futureDirection);
  const contextSignals = `${domain} ${resumeText} ${personalContext} ${futureDirection} ${transcriptText}`.toLowerCase();
  const hasResumeText = Boolean(resumeText);
  const hasInterviews = transcripts.length > 0;
  const track = getDomainTrainingTrack(domain, contextSignals);

  return {
    generatedAt: new Date().toISOString(),
    contextSources: {
      linkedIn: Boolean(user.linkedIn),
      resume: Boolean(user.resumeFileName),
      resumeTextAvailable: hasResumeText,
      personalContext: Boolean(personalContext),
      futureDirection: Boolean(futureDirection),
      interviewTranscriptTurns: transcripts.length
    },
    roleTarget: track.roleTarget,
    overview: [
      `This career recovery plan is personalized for ${user.firstName || user.name || "you"} using ${domain} as the domain anchor.`,
      `It uses your LinkedIn URL, ${user.resumeFileName ? `resume (${user.resumeFileName})` : "resume once uploaded"}, future direction${futureDirection ? ` (${futureDirection.slice(0, 120)})` : ""}, profile notes, and ${hasInterviews ? "stored interview transcript context" : "future interview transcripts once recorded"}.`,
      hasResumeText
        ? "Your resume text is already available for deeper skill matching."
        : "For PDF/DOC resumes, the file is stored now; deeper text extraction can be added next."
    ].join(" "),
    repositioning: track.repositioning,
    skillGapDiagnosis: track.skillGapDiagnosis,
    prioritySkills: track.prioritySkills,
    nextActions: track.nextActions,
    moduleSummary: track.moduleSummary,
    practiceLab: track.practiceLab,
    bootcampTools: track.bootcampTools,
    paidOffer: {
      name: "My AI Path",
      includes: [
        "My AI Career Path",
        "AI Tools Bootcamp",
        "Domain Practice Lab",
        "Interview and portfolio readiness"
      ]
    }
  };
}

function getDomainTrainingTrack(domain, contextSignals) {
  if (domain === "Property Management") {
    return {
      roleTarget: "AI-Enabled Property Management Operator",
      prioritySkills: [
        "AI tenant communication",
        "Maintenance triage automation",
        "Listing and leasing prompts",
        "Owner reporting",
        "Workflow automation"
      ],
      nextActions: [
        "Convert your property management experience into 3 AI-ready resume bullets.",
        "Build a tenant-response prompt library for maintenance, rent, lease, and renewal scenarios.",
        "Create a sample maintenance request classifier as your first portfolio project.",
        "Practice interview answers that explain how you use AI to reduce manual operations work."
      ],
      moduleSummary:
        "Reposition property management experience into AI-enabled operations, tenant communication, reporting, and automation roles.",
      repositioning:
        "Position prior property management experience as evidence of operational judgment, customer communication, vendor coordination, and workflow improvement.",
      skillGapDiagnosis:
        "Primary gaps to close: AI prompting for tenant/owner workflows, automation mapping, portfolio project proof, and stronger AI-ready resume language.",
      practiceLab:
        "Build a property management AI portfolio project: tenant communication assistant, maintenance triage workflow, or owner-report summarizer.",
      bootcampTools: [
        {
          category: "Career",
          name: "AI Resume Repositioning Tool",
          useCase: "Turn prior property management experience into AI-ready resume bullets.",
          promptStarter: "Rewrite these resume bullets for an AI-enabled property management operations role. Emphasize tenant communication, vendor coordination, workflow automation, reporting, and measurable outcomes.",
          exercise: "Paste 3 resume bullets and generate 3 stronger AI-ready versions.",
          outputArtifact: "Updated resume bullet set"
        },
        {
          category: "Operations",
          name: "Maintenance Triage Prompt Builder",
          useCase: "Practice using AI to classify maintenance requests by urgency, trade, tenant impact, and next action.",
          promptStarter: "Classify this maintenance request. Return urgency, likely vendor/trade, tenant response, owner note, risk level, and next action.",
          exercise: "Create 5 sample maintenance requests and classify them consistently.",
          outputArtifact: "Maintenance triage workflow"
        },
        {
          category: "Communication",
          name: "Tenant + Owner Message Coach",
          useCase: "Draft professional tenant and owner updates with the right tone and clarity.",
          promptStarter: "Draft a concise message for this property management situation. Audience: [tenant/owner/vendor]. Tone: professional, calm, clear. Include next steps.",
          exercise: "Write 3 tenant updates and 2 owner updates for common scenarios.",
          outputArtifact: "Communication prompt library"
        },
        {
          category: "Portfolio",
          name: "Property AI Portfolio Builder",
          useCase: "Package one AI workflow as proof that you can apply AI in property operations.",
          promptStarter: "Help me turn this property management workflow into a portfolio project. Include problem, workflow, AI prompts, sample inputs, outputs, and business value.",
          exercise: "Build a one-page case study for a tenant assistant or maintenance triage workflow.",
          outputArtifact: "Portfolio case study"
        }
      ]
    };
  }

  if (domain === "Financial") {
    return {
      roleTarget: "AI-Enabled Financial Operations Analyst",
      prioritySkills: [
        "AI spreadsheet analysis",
        "Financial narrative writing",
        "Variance explanation",
        "Report automation",
        "Research prompting"
      ],
      nextActions: [
        "Convert your finance experience into AI-ready analysis and reporting bullets.",
        "Build prompt templates for variance analysis, monthly reporting, and executive summaries.",
        "Create a sample AI-assisted budget review as your first portfolio project.",
        "Practice interview answers that show how AI improves speed, accuracy, and business insight."
      ],
      moduleSummary:
        "Map finance experience into AI-enabled analysis, reporting, planning, and operations roles.",
      repositioning:
        "Position finance experience as analytical judgment plus AI-assisted reporting, variance explanation, and business communication.",
      skillGapDiagnosis:
        "Primary gaps to close: AI spreadsheet workflows, executive narrative writing, automated analysis prompts, and proof-of-skill examples.",
      practiceLab:
        "Build a financial AI portfolio project: variance explainer, monthly reporting assistant, or spreadsheet insight workflow.",
      bootcampTools: [
        {
          category: "Career",
          name: "Finance Resume Repositioning Tool",
          useCase: "Convert finance experience into AI-enabled analyst positioning.",
          promptStarter: "Rewrite these finance resume bullets for an AI-enabled financial operations analyst role. Emphasize analysis, reporting, automation, variance explanation, and decision support.",
          exercise: "Rewrite 3 resume bullets and identify missing metrics.",
          outputArtifact: "AI-ready finance resume bullets"
        },
        {
          category: "Analysis",
          name: "Variance Explanation Assistant",
          useCase: "Practice turning numbers into clear business narratives.",
          promptStarter: "Explain this variance for an executive audience. Include likely drivers, questions to investigate, business risk, and recommended next action.",
          exercise: "Write 3 variance explanations from sample budget vs actual data.",
          outputArtifact: "Variance narrative samples"
        },
        {
          category: "Reporting",
          name: "Monthly Report Summarizer",
          useCase: "Use AI to summarize financial reports into executive-ready notes.",
          promptStarter: "Summarize this monthly financial report. Return key changes, risks, opportunities, and 3 executive talking points.",
          exercise: "Create a one-page monthly summary from sample financial notes.",
          outputArtifact: "Executive finance summary"
        }
      ]
    };
  }

  const hasMarketingSignal = /marketing|campaign|brand|content|sales/.test(contextSignals);

  return {
    roleTarget: hasMarketingSignal ? "AI-Enabled Growth Operator" : "AI-Enabled Business Operator",
    prioritySkills: [
      "Prompting for work",
      "AI research",
      "Document automation",
      "Spreadsheet workflows",
      "Interview storytelling"
    ],
    nextActions: [
      "Turn your resume into an AI-ready positioning statement.",
      "Build a prompt library for your most common domain tasks.",
      "Create one portfolio project that proves you can use AI in a real business workflow.",
      "Practice interview answers that connect your previous experience to AI-enabled work."
    ],
    moduleSummary:
      "Translate existing experience into practical AI-enabled roles, tools, and proof-of-skill assets.",
    repositioning:
      "Position prior experience as practical domain judgment amplified by AI tools for research, communication, analysis, and execution.",
    skillGapDiagnosis:
      "Primary gaps to close: AI workflow fluency, role-specific portfolio proof, sharper interview story, and targeted resume positioning.",
    practiceLab:
      "Build a portfolio project based on your strongest prior work domain and the workflows in your profile context.",
    bootcampTools: [
      {
        category: "Career",
        name: "Resume Repositioning Tool",
        useCase: "Turn existing experience into AI-ready role positioning.",
        promptStarter: "Rewrite these resume bullets for an AI-enabled role. Emphasize domain judgment, AI tool use, measurable outcomes, and business value.",
        exercise: "Rewrite 3 resume bullets and produce a stronger summary statement.",
        outputArtifact: "AI-ready resume section"
      },
      {
        category: "Job Search",
        name: "Job Description Matcher",
        useCase: "Compare your background against a target job and identify the best positioning.",
        promptStarter: "Compare my resume/context to this job description. Return fit score, strongest matches, gaps, resume keywords, and interview talking points.",
        exercise: "Run this against 2 target jobs and save the strongest keywords.",
        outputArtifact: "Target job match notes"
      },
      {
        category: "Interview",
        name: "Interview Answer Coach",
        useCase: "Practice clear answers that connect past experience to AI-enabled work.",
        promptStarter: "Coach my answer to this interview question. Make it concise, specific, confident, and aligned to my target AI-enabled role.",
        exercise: "Draft answers for Tell me about yourself, Why this role, and How do you use AI.",
        outputArtifact: "Interview answer set"
      }
    ]
  };
}

function getInterviewSessionByConversationId(conversationId) {
  return db.prepare(`
    SELECT id, user_id, domain, status, tavus_conversation_id
    FROM interview_sessions
    WHERE tavus_conversation_id = ?
  `).get(conversationId);
}

function markInterviewSession(sessionId, updates) {
  const existing = db.prepare("SELECT metadata_json FROM interview_sessions WHERE id = ?").get(sessionId);
  const existingMetadata = parseJson(existing?.metadata_json, {});
  const metadata = updates.metadata
    ? JSON.stringify({ ...existingMetadata, ...updates.metadata })
    : JSON.stringify(existingMetadata);
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE interview_sessions
    SET status = COALESCE(?, status),
        tavus_conversation_id = COALESCE(?, tavus_conversation_id),
        ended_at = COALESCE(?, ended_at),
        metadata_json = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    updates.status || null,
    updates.tavusConversationId || null,
    updates.endedAt || null,
    metadata,
    now,
    sessionId
  );
}

function isUtteranceEvent(eventType) {
  return [
    "conversation.utterance",
    "conversation.utterance_streaming",
    "application.utterance",
    "application.utterance_streaming"
  ].includes(eventType);
}

function storeUtteranceEvent(sessionId, payload) {
  const turn = normalizeUtterancePayload(payload);

  if (!turn.text) {
    return false;
  }

  insertTranscriptTurn(sessionId, turn);
  return true;
}

function storeTranscriptTurns(sessionId, transcript, sourcePayload) {
  transcript.forEach((entry, index) => {
    insertTranscriptTurn(sessionId, normalizeTranscriptEntry(entry, index, sourcePayload));
  });
}

function insertTranscriptTurn(sessionId, turn) {
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO conversation_transcripts (
      session_id, speaker, speaker_role, turn_index, text, started_at, ended_at,
      tavus_event_id, source_event_type, metadata_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    turn.speaker,
    turn.speakerRole,
    turn.turnIndex,
    turn.text,
    turn.startedAt,
    turn.endedAt,
    turn.eventId,
    turn.eventType,
    JSON.stringify(turn.metadata || {}),
    now
  );
}

function normalizeUtterancePayload(payload) {
  const properties = payload.properties || {};
  const utterance = properties.utterance || properties;
  const role = cleanValue(utterance.role || utterance.speaker || payload.role || payload.speaker);

  return {
    speaker: role || "unknown",
    speakerRole: role,
    turnIndex: Number.isFinite(Number(utterance.turn_index)) ? Number(utterance.turn_index) : null,
    text: cleanValue(utterance.content || utterance.text || payload.text || payload.content),
    startedAt: cleanValue(utterance.start_time || utterance.started_at || payload.timestamp) || null,
    endedAt: cleanValue(utterance.end_time || utterance.ended_at) || null,
    eventId: cleanValue(payload.event_id || payload.message_id || utterance.id) || null,
    eventType: cleanValue(payload.event_type),
    metadata: payload
  };
}

function normalizeTranscriptEntry(entry, index, sourcePayload) {
  const role = cleanValue(entry.role || entry.speaker);

  return {
    speaker: role || "unknown",
    speakerRole: role,
    turnIndex: index,
    text: cleanValue(entry.content || entry.text),
    startedAt: cleanValue(entry.start_time || entry.started_at) || null,
    endedAt: cleanValue(entry.end_time || entry.ended_at) || null,
    eventId: cleanValue(entry.id) || null,
    eventType: cleanValue(sourcePayload.event_type),
    metadata: entry
  };
}

function storeStructuredOutput(sessionId, domain, transcript) {
  const normalizedTranscript = transcript.map((entry, index) => normalizeTranscriptEntry(entry, index, {
    event_type: "application.transcription_ready"
  }));
  const structured = buildStructuredDomainOutput(domain, normalizedTranscript);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO structured_interview_outputs (
      session_id, domain, schema_version, structured_json, confidence_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, domain, schema_version) DO UPDATE SET
      structured_json = excluded.structured_json,
      confidence_json = excluded.confidence_json,
      updated_at = excluded.updated_at
  `).run(
    sessionId,
    domain || "Unknown",
    getDomainSchemaVersion(domain),
    JSON.stringify(structured),
    JSON.stringify({ extraction: "rule_seeded_placeholder", confidence: "draft" }),
    now,
    now
  );
}

function buildStructuredDomainOutput(domain, turns) {
  const transcriptText = turns
    .map((turn) => `${turn.speaker}: ${turn.text}`)
    .join("\n");

  if (domain === "Property Management") {
    return {
      domain: "Property Management",
      property_profile: {
        property_type: "",
        number_of_units: null,
        locations: [],
        portfolio_size: null,
        ownership_model: ""
      },
      business_goals: {
        primary_goal: "",
        secondary_goals: [],
        growth_targets: "",
        time_horizon: ""
      },
      operations: {
        leasing_process: "",
        maintenance_process: "",
        tenant_screening_process: "",
        rent_collection_process: "",
        vendor_management: "",
        software_tools: []
      },
      pain_points: {
        vacancy: "",
        late_payments: "",
        maintenance_delays: "",
        tenant_communication: "",
        compliance: "",
        staffing: "",
        other: []
      },
      customer_segments: {
        tenant_types: [],
        owner_clients: [],
        investor_profiles: [],
        ideal_customer_profile: ""
      },
      marketing_context: {
        current_channels: [],
        lead_sources: [],
        website_status: "",
        social_media_presence: "",
        differentiators: [],
        local_market_positioning: ""
      },
      financial_context: {
        revenue_model: "",
        average_rent: null,
        management_fee_structure: "",
        budget_constraints: "",
        profitability_challenges: []
      },
      compliance_and_risk: {
        jurisdictions: [],
        fair_housing_concerns: "",
        lease_compliance: "",
        insurance_risk: "",
        eviction_process: ""
      },
      automation_opportunities: {
        candidate_workflows: [],
        manual_tasks_to_reduce: [],
        highest_roi_automation: "",
        ai_readiness: ""
      },
      recommended_next_actions: {
        marketing_agent_tasks: [],
        ai_training_agent_tasks: [],
        follow_up_questions: [],
        priority_level: ""
      },
      raw_transcript_text: transcriptText
    };
  }

  return {
    domain: domain || "Unknown",
    raw_transcript_text: transcriptText
  };
}

function getDomainSchemaVersion(domain) {
  return domain === "Property Management" ? "property_management_v1" : "generic_v1";
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

async function verifyGoogleCredential(credential) {
  const tokenInfoUrl = new URL("https://oauth2.googleapis.com/tokeninfo");
  tokenInfoUrl.searchParams.set("id_token", credential);

  const response = await fetch(tokenInfoUrl);
  const profile = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(profile.error_description || "Google credential verification failed.");
  }

  if (profile.aud !== googleClientId) {
    throw new Error("Google credential was issued for a different OAuth client.");
  }

  if (!["accounts.google.com", "https://accounts.google.com"].includes(profile.iss)) {
    throw new Error("Google credential has an invalid issuer.");
  }

  if (profile.email_verified !== "true") {
    throw new Error("Google account email is not verified.");
  }

  return profile;
}

function getSessionUser(req) {
  const token = getSessionToken(req);

  if (!token) {
    return null;
  }

  const user = db.prepare(`
    SELECT users.id, users.google_sub, users.email, users.name, users.first_name,
           users.last_name, users.linkedin, users.domain, users.picture,
           users.resume_file_name, users.resume_mime_type, users.resume_size_bytes,
           users.resume_text, users.resume_uploaded_at,
           personal_contexts.context_text AS personal_context,
           personal_contexts.future_direction,
           users.email_verified, users.created_at, users.updated_at, users.last_login_at
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    LEFT JOIN personal_contexts ON personal_contexts.user_id = users.id
    WHERE sessions.session_token = ? AND sessions.expires_at > ?
  `).get(token, new Date().toISOString());

  return user ? serializeUser(user) : null;
}

function getUserById(userId) {
  const user = db.prepare(`
    SELECT users.id, users.google_sub, users.email, users.name, users.first_name,
           users.last_name, users.linkedin, users.domain, users.picture,
           users.resume_file_name, users.resume_mime_type, users.resume_size_bytes,
           users.resume_text, users.resume_uploaded_at,
           users.email_verified, users.created_at, users.updated_at, users.last_login_at,
           personal_contexts.context_text AS personal_context,
           personal_contexts.future_direction
    FROM users
    LEFT JOIN personal_contexts ON personal_contexts.user_id = users.id
    WHERE users.id = ?
  `).get(userId);

  return user ? serializeUser(user) : null;
}

function getSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  return cookies.interview_session || "";
}

function parseCookies(cookieHeader) {
  return cookieHeader.split(";").reduce((cookies, item) => {
    const [key, ...valueParts] = item.trim().split("=");
    if (key) {
      cookies[key] = decodeURIComponent(valueParts.join("="));
    }
    return cookies;
  }, {});
}

function buildSessionCookie(token, expiresAt) {
  return [
    `interview_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${new Date(expiresAt).toUTCString()}`
  ].join("; ");
}

function serializeUser(user) {
  return {
    id: user.id,
    googleSub: user.google_sub,
    email: user.email,
    name: user.name,
    firstName: user.first_name || "",
    lastName: user.last_name || "",
    linkedIn: user.linkedin || "",
    domain: user.domain || "",
    resumeFileName: user.resume_file_name || "",
    resumeMimeType: user.resume_mime_type || "",
    resumeSizeBytes: user.resume_size_bytes || 0,
    resumeText: user.resume_text || "",
    resumeUploadedAt: user.resume_uploaded_at || "",
    personalContext: user.personal_context || "",
    futureDirection: user.future_direction || "",
    picture: user.picture,
    emailVerified: Boolean(user.email_verified),
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    lastLoginAt: user.last_login_at
  };
}

function openDatabase(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const database = new DatabaseSync(filePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_sub TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      linkedin TEXT,
      domain TEXT,
      resume_file_name TEXT,
      resume_mime_type TEXT,
      resume_size_bytes INTEGER,
      resume_content_base64 TEXT,
      resume_text TEXT,
      resume_uploaded_at TEXT,
      picture TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_token TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(session_token);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS personal_contexts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      linkedin_url TEXT,
      domain TEXT,
      context_text TEXT,
      future_direction TEXT,
      source_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS interview_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      domain TEXT,
      status TEXT NOT NULL,
      tavus_conversation_id TEXT UNIQUE,
      persona_id TEXT,
      replica_id TEXT,
      profile_snapshot_json TEXT,
      summary TEXT,
      metadata_json TEXT,
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_interview_sessions_user_id ON interview_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_interview_sessions_conversation_id ON interview_sessions(tavus_conversation_id);

    CREATE TABLE IF NOT EXISTS conversation_transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      speaker TEXT NOT NULL,
      speaker_role TEXT,
      turn_index INTEGER,
      text TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      tavus_event_id TEXT,
      source_event_type TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_transcripts_session_id ON conversation_transcripts(session_id);

    CREATE TABLE IF NOT EXISTS structured_interview_outputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      domain TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      structured_json TEXT NOT NULL,
      confidence_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, domain, schema_version),
      FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_structured_outputs_session_id ON structured_interview_outputs(session_id);
  `);
  ensureColumn(database, "users", "first_name", "TEXT");
  ensureColumn(database, "users", "last_name", "TEXT");
  ensureColumn(database, "users", "linkedin", "TEXT");
  ensureColumn(database, "users", "domain", "TEXT");
  ensureColumn(database, "users", "resume_file_name", "TEXT");
  ensureColumn(database, "users", "resume_mime_type", "TEXT");
  ensureColumn(database, "users", "resume_size_bytes", "INTEGER");
  ensureColumn(database, "users", "resume_content_base64", "TEXT");
  ensureColumn(database, "users", "resume_text", "TEXT");
  ensureColumn(database, "users", "resume_uploaded_at", "TEXT");
  ensureColumn(database, "personal_contexts", "future_direction", "TEXT");
  return database;
}

function upsertPersonalContext(userId, context) {
  const now = context.updatedAt || new Date().toISOString();
  const source = JSON.stringify({
    linkedIn: context.linkedIn,
    domain: context.domain,
    futureDirection: context.futureDirection,
    resumeFileName: context.resume?.fileName || undefined,
    resumeMimeType: context.resume?.mimeType || undefined,
    resumeSizeBytes: context.resume?.sizeBytes || undefined,
    source: "profile"
  });

  db.prepare(`
    INSERT INTO personal_contexts (
      user_id, linkedin_url, domain, context_text, future_direction, source_json, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      linkedin_url = excluded.linkedin_url,
      domain = excluded.domain,
      context_text = excluded.context_text,
      future_direction = excluded.future_direction,
      source_json = excluded.source_json,
      updated_at = excluded.updated_at
  `).run(
    userId,
    context.linkedIn,
    context.domain,
    context.personalContext,
    context.futureDirection,
    source,
    now,
    now
  );
}

function ensureColumn(database, tableName, columnName, columnType) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  const hasColumn = columns.some((column) => column.name === columnName);

  if (!hasColumn) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
}

function cleanEnvValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");

    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}
