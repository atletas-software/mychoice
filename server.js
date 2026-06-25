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
const tavusDocumentIds = parseEnvList(process.env.TAVUS_DOCUMENT_IDS || "");
const tavusDocumentTags = parseEnvList(process.env.TAVUS_DOCUMENT_TAGS || "");
const tavusDocumentRetrievalStrategy = cleanEnvValue(process.env.TAVUS_DOCUMENT_RETRIEVAL_STRATEGY || "balanced");
const publicDir = __dirname;
const databasePath = path.join(__dirname, "data", "interview-me.sqlite");
let db;
let databaseKind = "starting";
let mysqlConfigured = false;

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

    if (req.method === "GET" && url.pathname === "/api/health") {
      await getHealthStatus(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/session") {
      sendJson(res, 200, { user: await getSessionUser(req) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/profile") {
      const user = await getSessionUser(req);
      sendJson(res, user ? 200 : 401, user ? { user } : { error: "Sign in to view profile." });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ai-training/path") {
      await getAiTrainingPath(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/knowledge") {
      await getDecisionKnowledge(req, res, url);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/tavus/document-syncs") {
      await getTavusDocumentSyncLogs(req, res);
      return;
    }

    const contextDocumentMatch = url.pathname.match(/^\/context-documents\/(domain|user|interview)\/([^/.]+)\.(txt|json)$/);
    if (req.method === "GET" && contextDocumentMatch) {
      await serveContextDocument(req, res, url, contextDocumentMatch[1], contextDocumentMatch[2]);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/interviews") {
      await listUserInterviews(req, res);
      return;
    }

    const interviewMatch = url.pathname.match(/^\/api\/interviews\/(\d+)$/);
    if (req.method === "GET" && interviewMatch) {
      await getUserInterviewDetail(req, res, Number(interviewMatch[1]));
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
      await logoutUser(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/tavus/conversations") {
      await createTavusConversation(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/tavus/sync-profile") {
      await syncTavusProfileContext(req, res);
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

async function bootstrap() {
  db = await openDatabase(databasePath);
  await seedDomainUdm();
  await rebuildDecisionKnowledgeForExistingSessions();
  server.listen(port, host, () => {
    console.log(`Interview Me app listening on http://${host}:${port}`);
  });
}

async function createTavusConversation(req, res) {
  const sessionUser = await getSessionUser(req);

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

  const localSession = await db.run(`
    INSERT INTO interview_sessions (
      user_id, domain, status, persona_id, replica_id, profile_snapshot_json, started_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    sessionUser.id,
    sessionUser.domain,
    "creating",
    personaId,
    replicaId,
    profileSnapshot,
    now,
    now,
    now
  ]);

  const localSessionId = Number(localSession.lastInsertRowid);
  const callbackUrl = publicCallbackBaseUrl
    ? `${publicCallbackBaseUrl.replace(/\/$/, "")}/api/tavus/callback`
    : "";
  const utteranceUrl = publicCallbackBaseUrl
    ? `${publicCallbackBaseUrl.replace(/\/$/, "")}/api/tavus/utterance`
    : "";

  await syncContextForTavus(sessionUser);
  const conversationContext = await buildConversationContext(sessionUser);
  const syncedDocumentIds = await getConversationTavusDocumentIds(sessionUser);
  const documentIds = [...new Set([...tavusDocumentIds, ...syncedDocumentIds])];
  const dynamicDocumentTags = [...new Set([...tavusDocumentTags, `domain:${slugify(sessionUser.domain)}`])];
  const customGreeting = buildInterviewOpeningQuestion(sessionUser);
  const tavusRequestBody = {
    ...(personaId ? { persona_id: personaId } : {}),
    ...(replicaId ? { replica_id: replicaId } : {}),
    ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    ...(documentIds.length ? { document_ids: documentIds } : {}),
    ...(dynamicDocumentTags.length ? { document_tags: dynamicDocumentTags } : {}),
    ...((documentIds.length || dynamicDocumentTags.length) && tavusDocumentRetrievalStrategy
      ? { document_retrieval_strategy: tavusDocumentRetrievalStrategy }
      : {}),
    conversation_name: cleanValue(body.conversation_name) || "Interview Me",
    custom_greeting: customGreeting,
    conversational_context: conversationContext
  };

  const tavusResponse = await fetch("https://tavusapi.com/v2/conversations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": tavusApiKey
    },
    body: JSON.stringify(tavusRequestBody)
  });

  const data = await tavusResponse.json().catch(() => ({}));

  if (!tavusResponse.ok) {
    await markInterviewSession(localSessionId, {
      status: "failed",
      metadata: { tavus_error: data }
    });
    sendJson(res, tavusResponse.status, normalizeTavusError(data));
    return;
  }

  await markInterviewSession(localSessionId, {
    status: "active",
    tavusConversationId: data.conversation_id,
    metadata: {
      tavus_response: data,
      callback_url: callbackUrl,
      utterance_url: utteranceUrl,
      tavus_document_ids: documentIds,
      tavus_document_tags: dynamicDocumentTags
    }
  });

  sendJson(res, 200, {
    ...data,
    local_session_id: localSessionId,
    transcript_capture: callbackUrl ? "callback_and_utterance_routes" : "public_callback_base_url_not_configured"
  });
}

async function getAiTrainingPath(req, res) {
  const sessionUser = await getSessionUser(req);

  if (!sessionUser) {
    sendJson(res, 401, { error: "Sign in to generate your AI path." });
    return;
  }

  const transcripts = await getUserTranscriptContext(sessionUser.id);
  const path = generateAiTrainingPath(sessionUser, transcripts);
  sendJson(res, 200, { path });
}

async function getDecisionKnowledge(req, res, url) {
  const sessionUser = await getSessionUser(req);

  if (!sessionUser) {
    sendJson(res, 401, { error: "Sign in to view decision knowledge." });
    return;
  }

  const requestedDomain = cleanValue(url.searchParams.get("domain"));
  const domain = requestedDomain || sessionUser.domain || "Property Management";
  const concepts = await db.all(`
    SELECT domain, concept_key, label, concept_type, description, shared_flag
    FROM domain_udm_concepts
    WHERE domain IN ('Core', ?)
    ORDER BY domain, concept_type, label
  `, [domain]);
  const relationships = await db.all(`
    SELECT domain, source_concept_key, relationship_type, target_concept_key, description
    FROM domain_udm_relationships
    WHERE domain IN ('Core', ?)
    ORDER BY domain, relationship_type, source_concept_key
  `, [domain]);
  const cases = await db.all(`
    SELECT id, session_id, domain, use_case, title, decision_statement,
           context_summary, signals_json, constraints_json, options_json,
           tradeoffs_json, actions_json, outcomes_json, pattern_summary,
           confidence, created_at, updated_at
    FROM decision_cases
    WHERE domain = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 50
  `, [domain]);

  sendJson(res, 200, {
    domain,
    architecture: {
      model: "Shared decision spine plus domain modules",
      sharedUdm:
        "Decision primitives are shared across domains: Context, Signal, Constraint, Option, Tradeoff, Action, Outcome, Pattern, Evidence.",
      domainModules:
        "Each domain adds its own vocabulary and relationships while mapping back to the shared decision spine."
    },
    concepts: concepts.map((concept) => ({
      domain: concept.domain,
      key: concept.concept_key,
      label: concept.label,
      type: concept.concept_type,
      description: concept.description,
      shared: Boolean(concept.shared_flag)
    })),
    relationships: relationships.map((relationship) => ({
      domain: relationship.domain,
      source: relationship.source_concept_key,
      type: relationship.relationship_type,
      target: relationship.target_concept_key,
      description: relationship.description
    })),
    decisionCases: cases.map((item) => ({
      id: item.id,
      sessionId: item.session_id,
      domain: item.domain,
      useCase: item.use_case,
      title: item.title,
      decision: item.decision_statement,
      context: item.context_summary,
      signals: parseJson(item.signals_json, []),
      constraints: parseJson(item.constraints_json, []),
      options: parseJson(item.options_json, []),
      tradeoffs: parseJson(item.tradeoffs_json, []),
      actions: parseJson(item.actions_json, []),
      outcomes: parseJson(item.outcomes_json, []),
      pattern: item.pattern_summary,
      confidence: item.confidence,
      createdAt: item.created_at,
      updatedAt: item.updated_at
    }))
  });
}

async function getTavusDocumentSyncLogs(req, res) {
  const sessionUser = await getSessionUser(req);

  if (!sessionUser) {
    sendJson(res, 401, { error: "Sign in to view Tavus sync logs." });
    return;
  }

  const interviews = await db.all(`
    SELECT id
    FROM interview_sessions
    WHERE user_id = ?
  `, [sessionUser.id]);
  const allowedInterviewIds = new Set(interviews.map((item) => String(item.id)));
  const rows = await db.all(`
    SELECT id, scope, scope_id, domain, document_name, document_url, document_id,
           tags_json, status, metadata_json, synced_at, created_at, updated_at
    FROM tavus_document_syncs
    WHERE (scope = 'user' AND scope_id = ?)
       OR scope = 'domain'
       OR scope = 'interview'
    ORDER BY id DESC
    LIMIT 30
  `, [String(sessionUser.id)]);

  const filteredRows = rows.filter((row) => {
    if (row.scope !== "interview") {
      return true;
    }

    return allowedInterviewIds.has(String(row.scope_id));
  });

  sendJson(res, 200, {
    count: filteredRows.length,
    logs: filteredRows.map((row) => {
      const metadata = parseJson(row.metadata_json, {});
      return {
        id: row.id,
        scope: row.scope,
        scopeId: row.scope_id,
        domain: row.domain,
        documentName: row.document_name,
        documentUrl: row.document_url,
        documentId: row.document_id,
        tags: parseJson(row.tags_json, []),
        status: row.status,
        httpStatus: metadata.http_status || 0,
        uploadPayload: metadata.upload_payload || {},
        tavusResponse: metadata.tavus_response || {},
        syncedAt: row.synced_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    })
  });
}

async function listUserInterviews(req, res) {
  const sessionUser = await getSessionUser(req);

  if (!sessionUser) {
    sendJson(res, 401, { error: "Sign in to view recordings." });
    return;
  }

  const interviews = await db.all(`
    SELECT i.id,
           i.domain,
           i.status,
           i.tavus_conversation_id,
           i.started_at,
           i.ended_at,
           i.created_at,
           i.updated_at,
           COALESCE(t.transcript_count, 0) AS transcript_count,
           t.last_transcript_at
    FROM interview_sessions i
    LEFT JOIN (
      SELECT session_id,
             COUNT(*) AS transcript_count,
             MAX(created_at) AS last_transcript_at
      FROM conversation_transcripts
      WHERE LOWER(COALESCE(speaker, '')) <> 'system'
        AND LOWER(COALESCE(speaker_role, '')) <> 'system'
      GROUP BY session_id
    ) t ON t.session_id = i.id
    WHERE i.user_id = ?
    ORDER BY COALESCE(i.started_at, i.created_at) DESC
    LIMIT 25
  `, [sessionUser.id]);

  sendJson(res, 200, {
    userId: sessionUser.id,
    count: interviews.length,
    interviews: interviews.map((interview) => ({
      id: interview.id,
      domain: interview.domain || "",
      status: interview.status || "",
      tavusConversationId: interview.tavus_conversation_id || "",
      startedAt: interview.started_at || "",
      endedAt: interview.ended_at || "",
      createdAt: interview.created_at || "",
      updatedAt: interview.updated_at || "",
      transcriptCount: Number(interview.transcript_count || 0),
      lastTranscriptAt: interview.last_transcript_at || ""
    }))
  });
}

async function getUserInterviewDetail(req, res, interviewId) {
  const sessionUser = await getSessionUser(req);

  if (!sessionUser) {
    sendJson(res, 401, { error: "Sign in to view recordings." });
    return;
  }

  const interview = await db.get(`
    SELECT id, user_id, domain, status, tavus_conversation_id, persona_id,
           started_at, ended_at, created_at, updated_at
    FROM interview_sessions
    WHERE id = ? AND user_id = ?
  `, [interviewId, sessionUser.id]);

  if (!interview) {
    sendJson(res, 404, { error: "Interview recording not found." });
    return;
  }

  const transcript = await db.all(`
    SELECT id, speaker, speaker_role, turn_index, text, started_at, ended_at,
           source_event_type, created_at
    FROM conversation_transcripts
    WHERE session_id = ?
      AND LOWER(COALESCE(speaker, '')) <> 'system'
      AND LOWER(COALESCE(speaker_role, '')) <> 'system'
    ORDER BY COALESCE(turn_index, id) ASC, id ASC
  `, [interview.id]);

  const structured = await db.get(`
    SELECT domain, schema_version, structured_json, confidence_json, created_at, updated_at
    FROM structured_interview_outputs
    WHERE session_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `, [interview.id]);

  sendJson(res, 200, {
    interview: {
      id: interview.id,
      domain: interview.domain || "",
      status: interview.status || "",
      tavusConversationId: interview.tavus_conversation_id || "",
      personaId: interview.persona_id || "",
      startedAt: interview.started_at || "",
      endedAt: interview.ended_at || "",
      createdAt: interview.created_at || "",
      updatedAt: interview.updated_at || ""
    },
    transcript: transcript.map((turn) => ({
      id: turn.id,
      speaker: turn.speaker || "",
      speakerRole: turn.speaker_role || "",
      turnIndex: turn.turn_index,
      text: turn.text || "",
      startedAt: turn.started_at || "",
      endedAt: turn.ended_at || "",
      eventType: turn.source_event_type || "",
      createdAt: turn.created_at || ""
    })),
    structured: structured
      ? {
          domain: structured.domain || "",
          schemaVersion: structured.schema_version || "",
          structured: parseJson(structured.structured_json, {}),
          confidence: parseJson(structured.confidence_json, {}),
          createdAt: structured.created_at || "",
          updatedAt: structured.updated_at || ""
        }
      : null
  });
}

async function getHealthStatus(res) {
  const status = {
    ok: true,
    database: databaseKind,
    mysqlConfigured,
    tables: {}
  };

  try {
    const tables = await db.getTableCounts();
    status.tables = tables;
  } catch (error) {
    status.ok = false;
    status.error = error instanceof Error ? error.message : "Unable to read database status.";
  }

  sendJson(res, status.ok ? 200 : 500, status);
}

async function handleTavusCallback(req, res) {
  const payload = await readJsonBody(req);
  const eventType = cleanValue(payload.event_type);
  const conversationId = cleanValue(payload.conversation_id);
  const timestamp = cleanValue(payload.timestamp) || new Date().toISOString();
  const session = conversationId ? await getInterviewSessionByConversationId(conversationId) : null;

  if (!session) {
    sendJson(res, 202, { ok: true, stored: false, reason: "Unknown conversation_id" });
    return;
  }

  if (eventType === "application.transcription_ready") {
    const transcript = Array.isArray(payload.properties?.transcript)
      ? payload.properties.transcript
      : [];

    await storeTranscriptTurns(session.id, transcript, payload);
    await storeStructuredOutput(session.id, session.domain, transcript);
    await extractDecisionKnowledgeForSession(session.id);
    await markInterviewSession(session.id, {
      status: "transcribed",
      endedAt: timestamp,
      metadata: { last_callback: payload }
    });

    sendJson(res, 200, { ok: true, stored: true, turns: transcript.length });
    return;
  }

  if (isUtteranceEvent(eventType)) {
    const stored = await storeUtteranceEvent(session.id, payload);
    await markInterviewSession(session.id, {
      status: "active",
      metadata: { last_utterance_event: payload }
    });

    sendJson(res, 200, { ok: true, stored: Boolean(stored), event_type: eventType });
    return;
  }

  if (eventType === "system.shutdown") {
    await extractDecisionKnowledgeForSession(session.id);
    await markInterviewSession(session.id, {
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
  const session = conversationId ? await getInterviewSessionByConversationId(conversationId) : null;

  if (!session) {
    sendJson(res, 202, { ok: true, stored: false, reason: "Unknown conversation_id" });
    return;
  }

  const stored = await storeUtteranceEvent(session.id, payload);
  await extractDecisionKnowledgeForSession(session.id);
  await markInterviewSession(session.id, {
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

  await db.upsertAuthenticatedUser({
    googleSub: profile.sub,
    email: profile.email,
    name: profile.name,
    picture: profile.picture,
    emailVerified: profile.email_verified === "true" ? 1 : 0,
    now
  });

  const user = await db.get(`
    SELECT id, google_sub, email, name, first_name, last_name, linkedin, domain,
           picture, email_verified, created_at, updated_at, last_login_at
    FROM users
    WHERE google_sub = ?
  `, [profile.sub]);

  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();

  await db.run(`
    INSERT INTO sessions (session_token, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `, [token, user.id, now, expiresAt]);

  const fullUser = await getUserById(user.id);

  res.setHeader("Set-Cookie", buildSessionCookie(token, expiresAt));
  sendJson(res, 200, { user: fullUser });
}

async function logoutUser(req, res) {
  const token = getSessionToken(req);

  if (token) {
    await db.run("DELETE FROM sessions WHERE session_token = ?", [token]);
  }

  res.setHeader(
    "Set-Cookie",
    "interview_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
  );
  sendJson(res, 200, { ok: true });
}

async function updateProfile(req, res) {
  const sessionUser = await getSessionUser(req);

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

  await db.run(`
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
  `, [
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
  ]);

  await upsertPersonalContext(sessionUser.id, {
    linkedIn: cleanValue(body.linkedIn),
    domain,
    personalContext: cleanValue(body.personalContext),
    futureDirection: cleanValue(body.futureDirection),
    firstName,
    lastName,
    resume,
    updatedAt: now
  });

  const user = await getUserById(sessionUser.id);
  await syncContextForTavus(user);
  sendJson(res, 200, { user });
}

async function syncTavusProfileContext(req, res) {
  const sessionUser = await getSessionUser(req);

  if (!sessionUser) {
    sendJson(res, 401, { error: "Sign in to sync Tavus profile context." });
    return;
  }

  await syncContextForTavus(sessionUser, { force: true });
  const logs = await db.all(`
    SELECT id, scope, scope_id, domain, document_name, document_id, status,
           tags_json, metadata_json, synced_at, updated_at
    FROM tavus_document_syncs
    WHERE (scope = 'user' AND scope_id = ?)
       OR (scope = 'domain' AND domain = ?)
    ORDER BY id DESC
    LIMIT 10
  `, [String(sessionUser.id), normalizeDomain(sessionUser.domain)]);

  sendJson(res, 200, {
    ok: true,
    logs: logs.map((row) => {
      const metadata = parseJson(row.metadata_json, {});
      return {
        id: row.id,
        scope: row.scope,
        scopeId: row.scope_id,
        domain: row.domain,
        documentName: row.document_name,
        documentId: row.document_id,
        status: row.status,
        tags: parseJson(row.tags_json, []),
        httpStatus: metadata.http_status || 0,
        uploadPayload: metadata.upload_payload || {},
        tavusResponse: metadata.tavus_response || {},
        syncedAt: row.synced_at,
        updatedAt: row.updated_at
      };
    })
  });
}

async function endTavusConversation(conversationId, res) {
  const session = await getInterviewSessionByConversationId(conversationId);

  if (!tavusApiKey) {
    if (session) {
      await finalizeInterviewKnowledge(session.id);
    }
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
    if (session) {
      await finalizeInterviewKnowledge(session.id);
    }
    res.writeHead(204);
    res.end();
    return;
  }

  const data = await tavusResponse.json().catch(() => ({}));
  if (tavusResponse.ok && session) {
    await finalizeInterviewKnowledge(session.id);
  }
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
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store, max-age=0"
    });
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

async function serveContextDocument(req, res, url, scope, rawScopeId) {
  const scopeId = decodeURIComponent(rawScopeId);
  const token = cleanValue(url.searchParams.get("token"));

  if (!token || token !== getTavusDocumentToken(scope, scopeId)) {
    sendJson(res, 403, { error: "Invalid context document token." });
    return;
  }

  const text = scope === "domain"
    ? await buildDomainContextDocument(scopeId)
    : scope === "interview"
      ? await buildInterviewContextDocument(Number(scopeId))
      : await buildUserContextDocument(Number(scopeId));

  if (!text) {
    sendJson(res, 404, { error: "Context document not found." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store, max-age=0"
  });
  res.end(text);
}

async function buildConversationContext(user) {
  const name = cleanValue(user?.name);
  const email = cleanValue(user?.email);
  const domain = normalizeDomain(user?.domain);
  const sharedContext = await getSharedDomainContext(domain);
  const knowledgeSummary = await getDomainKnowledgeSummaryForConversation(domain);
  const personalJsonContext = user?.id ? await buildUserContextDocument(user.id) : "";
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

  if (domain) {
    parts.push(`Business domain: ${domain}.`);
  }

  if (sharedContext) {
    parts.push(`Shared domain expertise for the interviewer: ${sharedContext.slice(0, 2200)}`);
  }

  if (knowledgeSummary) {
    parts.push(`Prior domain decision knowledge to use for better follow-up questions: ${knowledgeSummary}`);
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

  if (personalJsonContext) {
    parts.push(`Personal JSON context already loaded for this user: ${personalJsonContext.slice(0, 3500)}`);
  }

  parts.push(
    `Opening behavior: start the interview immediately. Do not wait for the user to speak first. Begin with this question: "${buildInterviewOpeningQuestion(user)}"`,
    "Interview objective: ask targeted questions that fill missing decision knowledge. Capture the user's real expertise, signals they use, constraints, options, tradeoffs, actions, outcomes, and examples. Ask concise follow-up questions when an answer is vague."
  );

  return parts.join(" ");
}

function buildInterviewOpeningQuestion(user) {
  const firstName = cleanValue(user?.firstName) || cleanValue(user?.name).split(/\s+/)[0] || "there";
  const domain = normalizeDomain(user?.domain);
  const anchor = buildPersonalOpeningAnchor(user);
  const useCase = getDomainDecisionModel(domain).useCases[0];

  return `Hi ${firstName}, I am Alma. I reviewed your ${anchor}. I will start with ${domain}. Thinking about ${useCase.name.toLowerCase()}, tell me about a real decision you made, what made it important, what information you used, and what tradeoffs you had to manage.`;
}

function buildPersonalOpeningAnchor(user) {
  const anchors = [];

  if (user?.linkedIn) {
    anchors.push("LinkedIn profile");
  }

  if (user?.resumeFileName || user?.resumeText) {
    anchors.push("resume");
  }

  if (user?.personalContext) {
    anchors.push("personal context");
  }

  if (user?.futureDirection) {
    anchors.push("future direction");
  }

  return anchors.length ? anchors.join(", ") : "saved profile context";
}

async function getSharedDomainContext(domain) {
  const row = await db.get(`
    SELECT context_text
    FROM domain_shared_contexts
    WHERE domain = ?
  `, [normalizeDomain(domain)]);

  return cleanValue(row?.context_text);
}

async function getDomainKnowledgeSummaryForConversation(domain) {
  const cases = await db.all(`
    SELECT use_case, pattern_summary, signals_json, constraints_json
    FROM decision_cases
    WHERE domain = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 8
  `, [normalizeDomain(domain)]);

  if (!cases.length) {
    return "";
  }

  return cases.map((item) => {
    const signals = parseJson(item.signals_json, []).slice(0, 3).join(", ");
    const constraints = parseJson(item.constraints_json, []).slice(0, 3).join(", ");
    return `${item.use_case}: ${item.pattern_summary || "pattern pending"} Signals: ${signals || "pending"}. Constraints: ${constraints || "pending"}.`;
  }).join(" ");
}

async function syncContextForTavus(user, options = {}) {
  if (!tavusApiKey || !publicCallbackBaseUrl || !user?.id) {
    return;
  }

  const domain = normalizeDomain(user.domain);

  try {
    await syncTavusContextDocument("domain", domain, domain, options);
    await syncTavusContextDocument("user", String(user.id), domain, options);
  } catch (error) {
    console.warn("Tavus context sync failed", error instanceof Error ? error.message : error);
  }
}

async function getConversationTavusDocumentIds(user) {
  if (!user?.id) {
    return [];
  }

  const domain = normalizeDomain(user.domain);
  return db.listLatestTavusDocumentIds([
    { scope: "domain", scopeId: domain },
    { scope: "user", scopeId: String(user.id) }
  ]);
}

async function syncTavusContextDocument(scope, scopeId, domain, options = {}) {
  const text = scope === "domain"
    ? await buildDomainContextDocument(scopeId)
    : scope === "interview"
      ? await buildInterviewContextDocument(Number(scopeId))
      : await buildUserContextDocument(Number(scopeId));

  if (!text) {
    return;
  }

  const contentHash = crypto.createHash("sha256").update(text).digest("hex");
  const previous = await db.getLatestTavusDocumentSync(scope, scopeId);

  if (!options.force && previous?.content_hash === contentHash && previous?.document_id) {
    return;
  }

  const now = new Date().toISOString();
  const documentUrl = buildPublicContextDocumentUrl(scope, scopeId);
  const documentName = scope === "domain"
    ? `My Choice Domain Context - ${scopeId}`
    : scope === "interview"
      ? `My Choice Interview Context - Session ${scopeId}`
      : `My Choice Personal Context - User ${scopeId}`;
  const tags = [
    "my-choice",
    scope,
    `domain:${slugify(domain || scopeId)}`
  ];

  let tavusResponse;
  let data = {};
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  const uploadPayload = {
    document_url: documentUrl,
    document_name: documentName,
    tags
  };

  try {
    tavusResponse = await fetch("https://tavusapi.com/v2/documents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": tavusApiKey
      },
      signal: controller.signal,
      body: JSON.stringify(uploadPayload)
    });
    data = await tavusResponse.json().catch(() => ({}));
  } catch (error) {
    data = { error: error instanceof Error ? error.message : "Tavus document upload failed" };
  } finally {
    clearTimeout(timeout);
  }

  const documentId = cleanValue(data.document_id || data.id);
  const ok = Boolean(tavusResponse?.ok);

  await db.upsertTavusDocumentSync({
    scope,
    scopeId,
    domain,
    documentName,
    documentUrl,
    documentId,
    tags,
    status: ok ? "uploaded" : "failed",
    contentHash,
    metadata: {
      tavus_response: data,
      http_status: tavusResponse?.status || 0,
      upload_payload: uploadPayload
    },
    syncedAt: now,
    now
  });
}

async function buildDomainContextDocument(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const sharedContext = await db.get(`
    SELECT context_text, source_json, updated_at
    FROM domain_shared_contexts
    WHERE domain = ?
  `, [normalizedDomain]);

  if (!sharedContext) {
    return "";
  }

  const concepts = await db.all(`
    SELECT domain, concept_key, label, concept_type, description
    FROM domain_udm_concepts
    WHERE domain IN ('Core', ?)
    ORDER BY domain, concept_type, label
  `, [normalizedDomain]);
  const relationships = await db.all(`
    SELECT domain, source_concept_key, relationship_type, target_concept_key, description
    FROM domain_udm_relationships
    WHERE domain IN ('Core', ?)
    ORDER BY domain, source_concept_key
  `, [normalizedDomain]);
  const cases = await db.all(`
    SELECT use_case, title, decision_statement, pattern_summary, signals_json,
           constraints_json, actions_json, outcomes_json
    FROM decision_cases
    WHERE domain = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 20
  `, [normalizedDomain]);

  return [
    `My Choice Shared Domain Context`,
    `Domain: ${normalizedDomain}`,
    `Updated: ${sharedContext.updated_at}`,
    ``,
    `Purpose`,
    sharedContext.context_text,
    ``,
    `Interviewer Guidance`,
    `Use this context to ask targeted questions that uncover real decision expertise. Ask for examples, signals, constraints, options, tradeoffs, actions, outcomes, and what the person learned.`,
    ``,
    `Core + Domain Concepts`,
    ...concepts.map((concept) => `- ${concept.label} (${concept.concept_type}): ${concept.description || concept.concept_key}`),
    ``,
    `Relationships`,
    ...relationships.map((relationship) => `- ${relationship.source_concept_key} ${relationship.relationship_type} ${relationship.target_concept_key}: ${relationship.description || ""}`),
    ``,
    `Extracted Decision Patterns`,
    ...(cases.length
      ? cases.map((item) => {
          const signals = parseJson(item.signals_json, []).join(", ");
          const constraints = parseJson(item.constraints_json, []).join(", ");
          const actions = parseJson(item.actions_json, []).join(", ");
          return `- ${item.use_case}: ${item.pattern_summary || item.decision_statement || item.title}. Signals: ${signals}. Constraints: ${constraints}. Actions: ${actions}.`;
        })
      : ["- No extracted interview patterns yet. Use the UDM and shared context to ask discovery questions."])
  ].join("\n");
}

async function buildUserContextDocument(userId) {
  const row = await db.get(`
    SELECT context_json
    FROM personal_contexts
    WHERE user_id = ?
  `, [userId]);

  if (row?.context_json) {
    return row.context_json;
  }

  const user = await getUserById(userId);

  if (!user) {
    return "";
  }

  return JSON.stringify(await buildPersonalContextJson(user), null, 2);
}

async function buildInterviewContextDocument(sessionId) {
  const session = await db.get(`
    SELECT i.id, i.user_id, i.domain, i.status, i.tavus_conversation_id,
           i.started_at, i.ended_at, i.created_at, i.updated_at,
           users.email, users.name, users.first_name, users.last_name, users.linkedin,
           users.resume_file_name, users.resume_text,
           personal_contexts.context_text AS personal_context,
           personal_contexts.future_direction
    FROM interview_sessions i
    JOIN users ON users.id = i.user_id
    LEFT JOIN personal_contexts ON personal_contexts.user_id = users.id
    WHERE i.id = ?
  `, [sessionId]);

  if (!session) {
    return "";
  }

  const transcript = await db.all(`
    SELECT id, speaker, speaker_role, turn_index, text, created_at
    FROM conversation_transcripts
    WHERE session_id = ?
      AND LOWER(COALESCE(speaker, '')) <> 'system'
      AND LOWER(COALESCE(speaker_role, '')) <> 'system'
    ORDER BY COALESCE(turn_index, id), id
  `, [sessionId]);
  const decisionCases = await db.all(`
    SELECT id, domain, use_case, title, decision_statement, context_summary,
           signals_json, constraints_json, options_json, tradeoffs_json,
           actions_json, outcomes_json, pattern_summary, confidence
    FROM decision_cases
    WHERE session_id = ?
    ORDER BY id ASC
  `, [sessionId]);
  const normalizedDomain = normalizeDomain(session.domain);
  const document = {
    documentType: "my_choice_interview_context",
    schemaVersion: "interview_context_v1",
    domain: normalizedDomain,
    user: {
      id: session.user_id,
      name: session.name,
      email: session.email,
      firstName: session.first_name,
      lastName: session.last_name,
      linkedIn: session.linkedin,
      resumeFileName: session.resume_file_name,
      personalContext: session.personal_context,
      futureDirection: session.future_direction
    },
    interview: {
      sessionId: session.id,
      status: session.status,
      tavusConversationId: session.tavus_conversation_id,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      createdAt: session.created_at,
      updatedAt: session.updated_at
    },
    interviewContext: {
      transcriptTurnCount: transcript.length,
      decisionCaseCount: decisionCases.length,
      keyValueSummary: decisionCases.reduce((summary, item) => {
        summary[item.use_case] = {
          title: item.title,
          decision: item.decision_statement,
          context: item.context_summary,
          signals: parseJson(item.signals_json, []),
          constraints: parseJson(item.constraints_json, []),
          options: parseJson(item.options_json, []),
          tradeoffs: parseJson(item.tradeoffs_json, []),
          actions: parseJson(item.actions_json, []),
          outcomes: parseJson(item.outcomes_json, []),
          pattern: item.pattern_summary,
          confidence: item.confidence
        };
        return summary;
      }, {})
    },
    transcript: transcript.filter((turn) => isKnowledgeEvidenceText(turn.text)).map((turn) => ({
      id: turn.id,
      speaker: turn.speaker || turn.speaker_role || "speaker",
      text: turn.text,
      createdAt: turn.created_at
    }))
  };

  return JSON.stringify(document, null, 2);
}

async function buildPersonalContextJson(user) {
  const domain = normalizeDomain(user.domain);
  const transcripts = await getUserTranscriptContext(user.id);
  const cases = await db.all(`
    SELECT domain, use_case, title, decision_statement, pattern_summary, context_summary,
           signals_json, constraints_json, actions_json, outcomes_json, updated_at
    FROM decision_cases
    WHERE user_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 20
  `, [user.id]);
  const model = getDomainDecisionModel(domain);

  return {
    documentType: "my_choice_personal_context",
    schemaVersion: "personal_context_v1",
    generatedAt: new Date().toISOString(),
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      linkedIn: user.linkedIn,
      domain,
      resume: {
        fileName: user.resumeFileName,
        mimeType: user.resumeMimeType,
        sizeBytes: user.resumeSizeBytes,
        uploadedAt: user.resumeUploadedAt,
        extractedText: cleanValue(user.resumeText).slice(0, 12000)
      },
      personalContext: user.personalContext,
      futureDirection: user.futureDirection
    },
    interviewerInstructions: {
      openingBehavior: "Start first. Do not wait for the user to speak before asking the first question.",
      openingQuestion: buildInterviewOpeningQuestion(user),
      usePersonalContext:
        "Use LinkedIn, resume, personal notes, future direction, and previous interview patterns to ask specific questions. Do not ask generic background questions when context already exists.",
      leadIntoDomainUseCases:
        "After opening, guide the interview toward domain use cases, asking for concrete examples, decision signals, constraints, options, tradeoffs, actions, outcomes, and lessons learned."
    },
    domainGuidance: {
      domain,
      useCases: model.useCases.map((useCase) => ({
        name: useCase.name,
        title: useCase.title,
        decision: useCase.decision,
        targetSignals: useCase.signals,
        targetConstraints: useCase.constraints,
        targetEntities: useCase.entities
      }))
    },
    previousDecisionKnowledge: cases.map((item) => ({
      domain: item.domain,
      useCase: item.use_case,
      title: item.title,
      decision: item.decision_statement,
      context: item.context_summary,
      pattern: item.pattern_summary,
      signals: parseJson(item.signals_json, []),
      constraints: parseJson(item.constraints_json, []),
      actions: parseJson(item.actions_json, []),
      outcomes: parseJson(item.outcomes_json, []),
      updatedAt: item.updated_at
    })),
    recentTranscriptEvidence: transcripts.slice(-30).map((turn) => ({
      speaker: turn.speaker || turn.speaker_role || "speaker",
      text: turn.text,
      domain: turn.domain,
      createdAt: turn.created_at
    }))
  };
}

function buildPublicContextDocumentUrl(scope, scopeId) {
  const base = publicCallbackBaseUrl.replace(/\/$/, "");
  const token = getTavusDocumentToken(scope, scopeId);
  return `${base}/context-documents/${scope}/${encodeURIComponent(scopeId)}.txt?token=${encodeURIComponent(token)}`;
}

function getTavusDocumentToken(scope, scopeId) {
  const secret = cleanEnvValue(process.env.TAVUS_DOCUMENT_ACCESS_TOKEN || tavusApiKey || googleClientId || "my-choice-local");
  return crypto
    .createHmac("sha256", secret)
    .update(`${scope}:${scopeId}`)
    .digest("hex");
}

function hasInterviewProfile(user) {
  return Boolean(cleanValue(user?.linkedIn) && cleanValue(user?.domain) && cleanValue(user?.resumeFileName));
}

async function getUserTranscriptContext(userId) {
  return db.all(`
    SELECT t.speaker, t.speaker_role, t.text, t.created_at, i.domain, i.tavus_conversation_id
    FROM conversation_transcripts t
    JOIN interview_sessions i ON i.id = t.session_id
    WHERE i.user_id = ?
      AND LOWER(COALESCE(t.speaker, '')) <> 'system'
      AND LOWER(COALESCE(t.speaker_role, '')) <> 'system'
    ORDER BY t.created_at ASC, t.id ASC
    LIMIT 80
  `, [userId]);
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

async function getInterviewSessionByConversationId(conversationId) {
  return db.get(`
    SELECT id, user_id, domain, status, tavus_conversation_id
    FROM interview_sessions
    WHERE tavus_conversation_id = ?
  `, [conversationId]);
}

async function markInterviewSession(sessionId, updates) {
  const existing = await db.get("SELECT metadata_json FROM interview_sessions WHERE id = ?", [sessionId]);
  const existingMetadata = parseJson(existing?.metadata_json, {});
  const metadata = updates.metadata
    ? JSON.stringify({ ...existingMetadata, ...updates.metadata })
    : JSON.stringify(existingMetadata);
  const now = new Date().toISOString();

  await db.run(`
    UPDATE interview_sessions
    SET status = COALESCE(?, status),
        tavus_conversation_id = COALESCE(?, tavus_conversation_id),
        ended_at = COALESCE(?, ended_at),
        metadata_json = ?,
        updated_at = ?
    WHERE id = ?
  `, [
    updates.status || null,
    updates.tavusConversationId || null,
    updates.endedAt || null,
    metadata,
    now,
    sessionId
  ]);
}

function isUtteranceEvent(eventType) {
  return [
    "conversation.utterance",
    "conversation.utterance_streaming",
    "application.utterance",
    "application.utterance_streaming"
  ].includes(eventType);
}

async function storeUtteranceEvent(sessionId, payload) {
  const turn = normalizeUtterancePayload(payload);

  if (!turn.text) {
    return false;
  }

  await insertTranscriptTurn(sessionId, turn);
  return true;
}

async function storeTranscriptTurns(sessionId, transcript, sourcePayload) {
  for (const [index, entry] of transcript.entries()) {
    await insertTranscriptTurn(sessionId, normalizeTranscriptEntry(entry, index, sourcePayload));
  }
}

async function insertTranscriptTurn(sessionId, turn) {
  const now = new Date().toISOString();

  await db.run(`
    INSERT INTO conversation_transcripts (
      session_id, speaker, speaker_role, turn_index, text, started_at, ended_at,
      tavus_event_id, source_event_type, metadata_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
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
  ]);
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

async function storeStructuredOutput(sessionId, domain, transcript) {
  const normalizedTranscript = transcript.map((entry, index) => normalizeTranscriptEntry(entry, index, {
    event_type: "application.transcription_ready"
  }));
  const structured = buildStructuredDomainOutput(domain, normalizedTranscript);
  const now = new Date().toISOString();

  await db.upsertStructuredOutput(
    sessionId,
    domain || "Unknown",
    getDomainSchemaVersion(domain),
    JSON.stringify(structured),
    JSON.stringify({ extraction: "rule_seeded_placeholder", confidence: "draft" }),
    now,
    now
  );
}

async function seedDomainUdm() {
  const now = new Date().toISOString();
  const sharedContexts = getSeedSharedDomainContexts(now);
  const concepts = getSeedDomainConcepts(now);
  const relationships = getSeedDomainRelationships(now);

  for (const context of sharedContexts) {
    await db.upsertSharedDomainContext(context);
  }

  for (const concept of concepts) {
    await db.upsertDomainConcept(concept);
  }

  for (const relationship of relationships) {
    await db.upsertDomainRelationship(relationship);
  }
}

async function rebuildDecisionKnowledgeForExistingSessions() {
  const sessions = await db.all(`
    SELECT id
    FROM interview_sessions
    WHERE status IN ('active', 'ended', 'transcribed')
    ORDER BY id DESC
    LIMIT 100
  `);

  for (const session of sessions) {
    await extractDecisionKnowledgeForSession(session.id, { syncTavus: false });
  }
}

async function extractDecisionKnowledgeForSession(sessionId, options = {}) {
  const session = await db.get(`
    SELECT id, user_id, domain, created_at
    FROM interview_sessions
    WHERE id = ?
  `, [sessionId]);

  if (!session) {
    return;
  }

  const turns = await db.all(`
    SELECT id, speaker, speaker_role, text, created_at
    FROM conversation_transcripts
    WHERE session_id = ?
      AND LOWER(COALESCE(speaker, '')) <> 'system'
      AND LOWER(COALESCE(speaker_role, '')) <> 'system'
    ORDER BY COALESCE(turn_index, id), id
  `, [sessionId]);
  const displayTurns = turns.filter((turn) => isKnowledgeEvidenceText(turn.text));

  if (!displayTurns.length) {
    return;
  }

  const cases = buildDecisionCasesFromTranscript(session, displayTurns);

  for (const decisionCase of cases) {
    const result = await db.upsertDecisionCase(decisionCase);
    const caseId = result.lastInsertRowid || await db.getDecisionCaseId(
      decisionCase.sessionId,
      decisionCase.domain,
      decisionCase.useCase
    );

    if (caseId) {
      await db.replaceDecisionEvidence(caseId, decisionCase.evidenceTurnIds);
      await db.replaceDecisionEntities(caseId, decisionCase.entities);
    }
  }

  if (options.syncTavus === false) {
    return;
  }

  const user = await getUserById(session.user_id);

  if (user) {
    await syncContextForTavus(user);
    await syncTavusContextDocument("interview", String(session.id), domain);
  }
}

async function finalizeInterviewKnowledge(sessionId) {
  await extractDecisionKnowledgeForSession(sessionId);

  const session = await db.get(`
    SELECT id, user_id, domain
    FROM interview_sessions
    WHERE id = ?
  `, [sessionId]);

  if (!session) {
    return;
  }

  await markInterviewSession(session.id, {
    status: "ended",
    endedAt: new Date().toISOString()
  });

  const user = await getUserById(session.user_id);

  if (user) {
    await syncContextForTavus(user);
    await syncTavusContextDocument("interview", String(session.id), normalizeDomain(session.domain));
  }
}

function isKnowledgeEvidenceText(value) {
  const text = cleanValue(value).toLowerCase();

  if (!text) {
    return false;
  }

  return !(
    text.startsWith("you are an interviewer") ||
    text.includes("this is a my choice decision capture session") ||
    text.includes("the signed-in user's email") ||
    text.includes("conversation context")
  );
}

function buildDecisionCasesFromTranscript(session, turns) {
  const domain = normalizeDomain(session.domain);
  const domainModel = getDomainDecisionModel(domain);
  const transcriptText = turns.map((turn) => turn.text).join(" ");
  const normalizedText = transcriptText.toLowerCase();
  const matchedUseCases = domainModel.useCases
    .filter((useCase) => useCase.keywords.some((keyword) => normalizedText.includes(keyword)))
    .slice(0, 4);
  const selectedUseCases = matchedUseCases.length ? matchedUseCases : domainModel.useCases.slice(0, 2);
  const evidenceTurnIds = turns.slice(0, 12).map((turn) => turn.id);

  return selectedUseCases.map((useCase) => {
    const evidence = turns
      .filter((turn) => useCase.keywords.some((keyword) => turn.text.toLowerCase().includes(keyword)))
      .slice(0, 4);
    const selectedEvidence = evidence.length ? evidence : turns.slice(0, 4);
    const evidenceText = selectedEvidence.map((turn) => turn.text).join(" ").slice(0, 1200);
    const signals = pickSignals(evidenceText, useCase.signals);
    const constraints = pickSignals(evidenceText, useCase.constraints);
    const actions = pickSignals(evidenceText, useCase.actions);

    return {
      sessionId: session.id,
      userId: session.user_id,
      domain,
      useCase: useCase.name,
      title: useCase.title,
      decisionStatement: useCase.decision,
      contextSummary: evidenceText || `Decision context captured for ${useCase.name}.`,
      signals,
      constraints,
      options: useCase.options,
      tradeoffs: useCase.tradeoffs,
      actions,
      outcomes: useCase.outcomes,
      patternSummary: useCase.pattern,
      confidence: evidence.length ? "medium" : "draft",
      evidenceTurnIds: selectedEvidence.map((turn) => turn.id).length
        ? selectedEvidence.map((turn) => turn.id)
        : evidenceTurnIds,
      entities: useCase.entities
    };
  });
}

function pickSignals(text, fallback) {
  const normalized = cleanValue(text).toLowerCase();
  const matches = fallback.filter((item) => {
    const words = item.toLowerCase().split(/\W+/).filter((word) => word.length > 4);
    return words.some((word) => normalized.includes(word));
  });

  return matches.length ? matches : fallback.slice(0, 3);
}

function normalizeDomain(domain) {
  if (domain === "Financial") {
    return "Financial Management";
  }

  return domain || "Property Management";
}

function getDomainDecisionModel(domain) {
  if (domain === "Financial Management") {
    return {
      useCases: [
        {
          name: "Budget Variance Review",
          title: "Explain and respond to budget variance",
          decision: "Decide which variance drivers require investigation, escalation, or corrective action.",
          keywords: ["budget", "variance", "forecast", "actual", "expense", "revenue", "margin"],
          signals: ["Budget versus actual movement", "Forecast accuracy", "Expense trend", "Revenue change"],
          constraints: ["Reporting deadline", "Data quality", "Business risk", "Cash impact"],
          options: ["Investigate driver", "Adjust forecast", "Escalate to owner", "Monitor next period"],
          tradeoffs: ["Speed versus accuracy", "Cost control versus growth investment"],
          actions: ["Create variance narrative", "Request supporting data", "Update forecast assumptions"],
          outcomes: ["Clearer executive decision support", "Earlier risk detection", "Improved planning discipline"],
          pattern: "Experienced financial operators convert variance signals into a clear driver, risk, and next action.",
          entities: ["Budget", "Forecast", "Variance", "Revenue", "Expense"]
        },
        {
          name: "Management Reporting",
          title: "Turn financial data into executive narrative",
          decision: "Decide what leaders need to know from financial performance and what action should follow.",
          keywords: ["report", "monthly", "dashboard", "executive", "kpi", "performance", "summary"],
          signals: ["KPI movement", "Trend direction", "Threshold breach", "Stakeholder concern"],
          constraints: ["Executive attention", "Materiality", "Timeliness", "Confidence in source data"],
          options: ["Summarize performance", "Highlight risk", "Recommend action", "Request deeper analysis"],
          tradeoffs: ["Completeness versus readability", "Precision versus speed"],
          actions: ["Prepare executive summary", "Call out risks", "Define follow-up questions"],
          outcomes: ["Faster leadership alignment", "Better prioritization", "Reusable report pattern"],
          pattern: "Strong finance reporting compresses complex data into decision-ready signals and actions.",
          entities: ["Report", "KPI", "ExecutiveSummary", "Risk", "Action"]
        }
      ]
    };
  }

  return {
    useCases: [
      {
        name: "Maintenance Triage",
        title: "Prioritize and route maintenance requests",
        decision: "Decide whether a maintenance issue is emergency, urgent, routine, or owner-approved work.",
        keywords: ["maintenance", "repair", "vendor", "tenant", "emergency", "plumber", "hvac", "leak"],
        signals: ["Tenant impact", "Property damage risk", "Urgency", "Vendor availability"],
        constraints: ["Owner approval threshold", "Response time", "Cost", "Liability"],
        options: ["Dispatch emergency vendor", "Schedule routine repair", "Request owner approval", "Ask tenant for more detail"],
        tradeoffs: ["Fast response versus cost control", "Tenant satisfaction versus owner budget"],
        actions: ["Classify request", "Notify tenant", "Assign vendor", "Document owner communication"],
        outcomes: ["Reduced escalation", "Lower property damage risk", "Clear vendor workflow"],
        pattern: "Expert operators triage maintenance by impact, risk, authority, and speed before choosing the next action.",
        entities: ["MaintenanceRequest", "Tenant", "Vendor", "Owner", "Property"]
      },
      {
        name: "Tenant Communication",
        title: "Resolve tenant issues with clear communication",
        decision: "Decide what message, tone, and next step should be sent to the tenant.",
        keywords: ["tenant", "communication", "message", "complaint", "renewal", "lease", "notice"],
        signals: ["Tenant sentiment", "Lease status", "Issue severity", "Response history"],
        constraints: ["Fair housing compliance", "Tone", "Documentation", "Response time"],
        options: ["Send update", "Escalate to manager", "Request documentation", "Offer resolution path"],
        tradeoffs: ["Empathy versus policy enforcement", "Speed versus completeness"],
        actions: ["Draft tenant response", "Log communication", "Set follow-up date"],
        outcomes: ["Better tenant trust", "Lower confusion", "Reduced repeated contacts"],
        pattern: "Strong property teams communicate next steps clearly while preserving compliance and documentation.",
        entities: ["Tenant", "Lease", "Communication", "ComplianceIssue", "FollowUp"]
      },
      {
        name: "Owner Reporting",
        title: "Translate operations into owner decisions",
        decision: "Decide what operational facts owners need to approve spend, understand risk, or evaluate performance.",
        keywords: ["owner", "report", "investor", "approval", "expense", "rent", "vacancy"],
        signals: ["Vacancy rate", "Repair cost", "Rent collection", "Portfolio performance"],
        constraints: ["Owner budget", "Approval threshold", "Profitability", "Market conditions"],
        options: ["Recommend approval", "Delay spend", "Provide alternatives", "Escalate risk"],
        tradeoffs: ["Asset protection versus short-term cash", "Occupancy versus rent growth"],
        actions: ["Summarize facts", "Recommend decision", "Attach evidence"],
        outcomes: ["Faster owner approval", "Improved transparency", "Reusable reporting pattern"],
        pattern: "Owner-ready reporting connects operational events to investment decisions and risk.",
        entities: ["Owner", "Property", "Expense", "Vacancy", "Report"]
      }
    ]
  };
}

function getSeedSharedDomainContexts(now) {
  return [
    {
      domain: "Property Management",
      contextText:
        "Property Management shared context covers tenant communication, maintenance triage, owner reporting, leasing, rent collection, vendor coordination, compliance, vacancy, marketing, and operational decision-making. Interviews should discover how experienced operators prioritize urgent issues, balance tenant satisfaction with owner economics, evaluate vendors, communicate risk, and decide when to escalate.",
      sourceJson: JSON.stringify({
        source: "seed",
        interviewUse:
          "Ask targeted questions about maintenance workflows, owner approvals, tenant communication, vacancy, compliance, software, and operational tradeoffs.",
        graphUse:
          "Map transcript evidence into decisions, signals, constraints, options, tradeoffs, actions, outcomes, and reusable property-management patterns."
      }),
      now
    },
    {
      domain: "Financial Management",
      contextText:
        "Financial Management shared context covers budget versus actuals, variance explanation, forecasting, reporting, cash flow, risk, approvals, KPI interpretation, executive summaries, and decision support. Interviews should discover how finance operators decide what matters, explain drivers, manage uncertainty, escalate risks, and turn data into recommendations.",
      sourceJson: JSON.stringify({
        source: "seed",
        interviewUse:
          "Ask targeted questions about variance drivers, reporting cadence, forecast assumptions, risk thresholds, stakeholder decisions, and financial narratives.",
        graphUse:
          "Map transcript evidence into finance decisions, signals, constraints, options, tradeoffs, actions, outcomes, and reusable financial-management patterns."
      }),
      now
    }
  ];
}

function getSeedDomainConcepts(now) {
  const core = [
    ["decision", "Decision", "primitive", "A judgment or choice made under business context.", true],
    ["context", "Context", "primitive", "The surrounding facts, goals, constraints, and background.", true],
    ["signal", "Signal", "primitive", "An observed indicator used to guide a decision.", true],
    ["constraint", "Constraint", "primitive", "A limitation, rule, resource boundary, deadline, or risk.", true],
    ["option", "Option", "primitive", "A possible path or response.", true],
    ["tradeoff", "Tradeoff", "primitive", "The cost, benefit, or tension between options.", true],
    ["action", "Action", "primitive", "The operational step taken after a decision.", true],
    ["outcome", "Outcome", "primitive", "The result or expected result of the action.", true],
    ["pattern", "Pattern", "primitive", "A reusable decision-making lesson extracted across interviews.", true],
    ["evidence", "Evidence", "primitive", "A raw transcript turn or artifact supporting a structured object.", true]
  ].map(([key, label, type, description, shared]) => ({
    domain: "Core",
    key,
    label,
    type,
    description,
    shared,
    now
  }));

  const property = [
    ["property", "Property", "entity", "A managed building, unit, or portfolio asset."],
    ["tenant", "Tenant", "entity", "Resident or renter who creates communication and service needs."],
    ["owner", "Owner", "entity", "Property owner or investor who approves spend and evaluates performance."],
    ["vendor", "Vendor", "entity", "External trade or service provider."],
    ["maintenance_request", "Maintenance Request", "workflow", "Repair or service issue requiring triage and routing."],
    ["lease", "Lease", "entity", "Contract governing tenant obligations, renewals, notices, and compliance."],
    ["rent_payment", "Rent Payment", "workflow", "Rent collection, delinquency, late payment, and escalation process."],
    ["vacancy", "Vacancy", "signal", "Unoccupied unit or portfolio gap affecting revenue and marketing."],
    ["inspection", "Inspection", "workflow", "Property condition review and risk detection process."],
    ["compliance_issue", "Compliance Issue", "constraint", "Legal, fair housing, notice, eviction, or jurisdictional requirement."],
    ["lead", "Lead", "entity", "Potential tenant or owner customer."],
    ["marketing_channel", "Marketing Channel", "entity", "Source of demand for tenants, owners, or investors."]
  ].map(([key, label, type, description]) => ({
    domain: "Property Management",
    key,
    label,
    type,
    description,
    shared: false,
    now
  }));

  const financial = [
    ["budget", "Budget", "entity", "Planned financial baseline."],
    ["forecast", "Forecast", "entity", "Expected future financial performance."],
    ["variance", "Variance", "signal", "Difference between actuals and plan or forecast."],
    ["revenue", "Revenue", "metric", "Income generated by the business."],
    ["expense", "Expense", "metric", "Cost category affecting profitability and cash."],
    ["cash_flow", "Cash Flow", "metric", "Timing and availability of cash."],
    ["kpi", "KPI", "metric", "Key performance indicator used to guide decisions."],
    ["report", "Report", "artifact", "Recurring financial analysis or dashboard."],
    ["risk", "Risk", "constraint", "Potential negative financial or operational exposure."],
    ["executive_summary", "Executive Summary", "artifact", "Decision-ready narrative for leadership."],
    ["scenario", "Scenario", "option", "Potential forecast, plan, or business case."],
    ["approval", "Approval", "workflow", "Authorization step for spend, forecast, budget, or action."]
  ].map(([key, label, type, description]) => ({
    domain: "Financial Management",
    key,
    label,
    type,
    description,
    shared: false,
    now
  }));

  return [...core, ...property, ...financial];
}

function getSeedDomainRelationships(now) {
  const rows = [
    ["Core", "decision", "has_context", "context", "Every decision is interpreted inside business context."],
    ["Core", "decision", "uses_signal", "signal", "Signals help determine the right decision path."],
    ["Core", "decision", "constrained_by", "constraint", "Constraints shape which options are realistic."],
    ["Core", "decision", "considers", "option", "Decisions compare possible options."],
    ["Core", "decision", "requires_tradeoff", "tradeoff", "Expert decisions expose tradeoffs."],
    ["Core", "decision", "produces", "outcome", "Decisions create measurable or expected outcomes."],
    ["Core", "action", "supported_by", "evidence", "Actions should link back to transcript evidence."],
    ["Core", "pattern", "supported_by", "evidence", "Patterns are only trusted when evidence-backed."],
    ["Property Management", "tenant", "reports", "maintenance_request", "Tenants often initiate maintenance workflows."],
    ["Property Management", "maintenance_request", "assigned_to", "vendor", "Maintenance requests are routed to vendors."],
    ["Property Management", "owner", "approves", "expense", "Owners may approve cost-sensitive decisions."],
    ["Property Management", "property", "has_signal", "vacancy", "Vacancy is a portfolio performance signal."],
    ["Property Management", "lease", "constrained_by", "compliance_issue", "Lease decisions must respect compliance."],
    ["Property Management", "marketing_channel", "generates", "lead", "Marketing channels create tenant or owner leads."],
    ["Financial Management", "budget", "compared_to", "forecast", "Budget and forecast create planning context."],
    ["Financial Management", "variance", "affects", "kpi", "Variance movement changes KPIs and narratives."],
    ["Financial Management", "report", "summarizes", "kpi", "Reports translate KPIs into decisions."],
    ["Financial Management", "risk", "constrained_by", "cash_flow", "Cash position changes risk decisions."],
    ["Financial Management", "executive_summary", "recommends", "action", "Executive summaries should drive next action."],
    ["Financial Management", "scenario", "requires", "approval", "Scenario choices can require authorization."]
  ];

  return rows.map(([domain, source, type, target, description]) => ({
    domain,
    source,
    type,
    target,
    description,
    now
  }));
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

async function getSessionUser(req) {
  const token = getSessionToken(req);

  if (!token) {
    return null;
  }

  const user = await db.get(`
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
  `, [token, new Date().toISOString()]);

  return user ? serializeUser(user) : null;
}

async function getUserById(userId) {
  const user = await db.get(`
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
  `, [userId]);

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

async function openDatabase(filePath) {
  mysqlConfigured = hasMySqlConfig();

  if (hasMySqlConfig()) {
    const mysqlDatabase = await openMySqlDatabase();
    databaseKind = "mysql";
    return mysqlDatabase;
  }

  databaseKind = "sqlite";
  return openSqliteDatabase(filePath);
}

function hasMySqlConfig() {
  return Boolean(process.env.DATABASE_URL || process.env.MYSQL_HOST);
}

function openSqliteDatabase(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const database = new DatabaseSync(filePath);
  const adapter = new SqliteAdapter(database);
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
      context_json TEXT,
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

    CREATE TABLE IF NOT EXISTS domain_shared_contexts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL UNIQUE,
      context_text TEXT NOT NULL,
      source_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS domain_udm_concepts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      concept_key TEXT NOT NULL,
      label TEXT NOT NULL,
      concept_type TEXT NOT NULL,
      description TEXT,
      shared_flag INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(domain, concept_key)
    );

    CREATE TABLE IF NOT EXISTS domain_udm_relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      source_concept_key TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      target_concept_key TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(domain, source_concept_key, relationship_type, target_concept_key)
    );

    CREATE TABLE IF NOT EXISTS decision_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      domain TEXT NOT NULL,
      use_case TEXT NOT NULL,
      title TEXT NOT NULL,
      decision_statement TEXT,
      context_summary TEXT,
      signals_json TEXT,
      constraints_json TEXT,
      options_json TEXT,
      tradeoffs_json TEXT,
      actions_json TEXT,
      outcomes_json TEXT,
      pattern_summary TEXT,
      confidence TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, domain, use_case),
      FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS decision_case_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_case_id INTEGER NOT NULL,
      entity_key TEXT NOT NULL,
      role TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (decision_case_id) REFERENCES decision_cases(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS evidence_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_case_id INTEGER NOT NULL,
      transcript_turn_id INTEGER NOT NULL,
      evidence_type TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(decision_case_id, transcript_turn_id),
      FOREIGN KEY (decision_case_id) REFERENCES decision_cases(id) ON DELETE CASCADE,
      FOREIGN KEY (transcript_turn_id) REFERENCES conversation_transcripts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_decision_cases_domain ON decision_cases(domain);
    CREATE INDEX IF NOT EXISTS idx_decision_cases_user_id ON decision_cases(user_id);

    CREATE TABLE IF NOT EXISTS tavus_document_syncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      domain TEXT,
      document_name TEXT NOT NULL,
      document_url TEXT NOT NULL,
      document_id TEXT,
      tags_json TEXT,
      status TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      metadata_json TEXT,
      synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(scope, scope_id, content_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_tavus_document_syncs_scope ON tavus_document_syncs(scope, scope_id);
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
  ensureColumn(database, "personal_contexts", "context_json", "TEXT");
  return adapter;
}

async function openMySqlDatabase() {
  let mysql;

  try {
    mysql = require("mysql2/promise");
  } catch (error) {
    throw new Error("MySQL is configured, but the mysql2 package is not installed. Run npm install before deploying.");
  }

  const pool = process.env.DATABASE_URL
    ? mysql.createPool(process.env.DATABASE_URL)
    : mysql.createPool({
        host: process.env.MYSQL_HOST,
        port: Number(process.env.MYSQL_PORT || 3306),
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        database: process.env.MYSQL_DATABASE,
        waitForConnections: true,
        connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
        namedPlaceholders: false
      });
  const adapter = new MySqlAdapter(pool);
  await adapter.migrate();
  return adapter;
}

async function upsertPersonalContext(userId, context) {
  const now = context.updatedAt || new Date().toISOString();
  const existingUser = await getUserById(userId);
  const contextUser = {
    ...(existingUser || {}),
    firstName: context.firstName || existingUser?.firstName || "",
    lastName: context.lastName || existingUser?.lastName || "",
    linkedIn: context.linkedIn || "",
    domain: context.domain || "",
    resumeFileName: context.resume?.fileName || existingUser?.resumeFileName || "",
    resumeMimeType: context.resume?.mimeType || existingUser?.resumeMimeType || "",
    resumeSizeBytes: context.resume?.sizeBytes || existingUser?.resumeSizeBytes || 0,
    resumeText: context.resume?.extractedText || existingUser?.resumeText || "",
    resumeUploadedAt: context.resume ? now : existingUser?.resumeUploadedAt || "",
    personalContext: context.personalContext || "",
    futureDirection: context.futureDirection || ""
  };
  const personalContextJson = JSON.stringify(await buildPersonalContextJson(contextUser), null, 2);
  const source = JSON.stringify({
    linkedIn: context.linkedIn,
    domain: context.domain,
    futureDirection: context.futureDirection,
    resumeFileName: contextUser.resumeFileName || undefined,
    resumeMimeType: contextUser.resumeMimeType || undefined,
    resumeSizeBytes: contextUser.resumeSizeBytes || undefined,
    resumeUploadedAt: contextUser.resumeUploadedAt || undefined,
    resumeTextAvailable: Boolean(contextUser.resumeText),
    source: "profile"
  });

  await db.upsertPersonalContext(
    userId,
    context.linkedIn,
    context.domain,
    context.personalContext,
    context.futureDirection,
    personalContextJson,
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

class SqliteAdapter {
  constructor(database) {
    this.database = database;
    this.kind = "sqlite";
  }

  run(sql, params = []) {
    const result = this.database.prepare(sql).run(...params);
    return {
      changes: result.changes,
      lastInsertRowid: Number(result.lastInsertRowid || 0)
    };
  }

  get(sql, params = []) {
    return this.database.prepare(sql).get(...params);
  }

  all(sql, params = []) {
    return this.database.prepare(sql).all(...params);
  }

  upsertAuthenticatedUser(user) {
    return this.run(`
      INSERT INTO users (google_sub, email, name, picture, email_verified, created_at, updated_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(google_sub) DO UPDATE SET
        email = excluded.email,
        name = excluded.name,
        picture = excluded.picture,
        email_verified = excluded.email_verified,
        updated_at = excluded.updated_at,
        last_login_at = excluded.last_login_at
    `, [
      user.googleSub,
      user.email,
      user.name,
      user.picture,
      user.emailVerified,
      user.now,
      user.now,
      user.now
    ]);
  }

  upsertPersonalContext(userId, linkedIn, domain, contextText, futureDirection, contextJson, source, createdAt, updatedAt) {
    return this.run(`
      INSERT INTO personal_contexts (
        user_id, linkedin_url, domain, context_text, future_direction, context_json, source_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        linkedin_url = excluded.linkedin_url,
        domain = excluded.domain,
        context_text = excluded.context_text,
        future_direction = excluded.future_direction,
        context_json = excluded.context_json,
        source_json = excluded.source_json,
        updated_at = excluded.updated_at
    `, [userId, linkedIn, domain, contextText, futureDirection, contextJson, source, createdAt, updatedAt]);
  }

  upsertStructuredOutput(sessionId, domain, schemaVersion, structuredJson, confidenceJson, createdAt, updatedAt) {
    return this.run(`
      INSERT INTO structured_interview_outputs (
        session_id, domain, schema_version, structured_json, confidence_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, domain, schema_version) DO UPDATE SET
        structured_json = excluded.structured_json,
        confidence_json = excluded.confidence_json,
        updated_at = excluded.updated_at
    `, [sessionId, domain, schemaVersion, structuredJson, confidenceJson, createdAt, updatedAt]);
  }

  upsertSharedDomainContext(context) {
    return this.run(`
      INSERT INTO domain_shared_contexts (domain, context_text, source_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        context_text = excluded.context_text,
        source_json = excluded.source_json,
        updated_at = excluded.updated_at
    `, [context.domain, context.contextText, context.sourceJson, context.now, context.now]);
  }

  upsertDomainConcept(concept) {
    return this.run(`
      INSERT INTO domain_udm_concepts (
        domain, concept_key, label, concept_type, description, shared_flag, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain, concept_key) DO UPDATE SET
        label = excluded.label,
        concept_type = excluded.concept_type,
        description = excluded.description,
        shared_flag = excluded.shared_flag,
        updated_at = excluded.updated_at
    `, [
      concept.domain,
      concept.key,
      concept.label,
      concept.type,
      concept.description,
      concept.shared ? 1 : 0,
      concept.now,
      concept.now
    ]);
  }

  upsertDomainRelationship(relationship) {
    return this.run(`
      INSERT INTO domain_udm_relationships (
        domain, source_concept_key, relationship_type, target_concept_key, description, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain, source_concept_key, relationship_type, target_concept_key) DO UPDATE SET
        description = excluded.description,
        updated_at = excluded.updated_at
    `, [
      relationship.domain,
      relationship.source,
      relationship.type,
      relationship.target,
      relationship.description,
      relationship.now,
      relationship.now
    ]);
  }

  upsertDecisionCase(decisionCase) {
    const now = new Date().toISOString();

    return this.run(`
      INSERT INTO decision_cases (
        session_id, user_id, domain, use_case, title, decision_statement,
        context_summary, signals_json, constraints_json, options_json,
        tradeoffs_json, actions_json, outcomes_json, pattern_summary,
        confidence, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, domain, use_case) DO UPDATE SET
        title = excluded.title,
        decision_statement = excluded.decision_statement,
        context_summary = excluded.context_summary,
        signals_json = excluded.signals_json,
        constraints_json = excluded.constraints_json,
        options_json = excluded.options_json,
        tradeoffs_json = excluded.tradeoffs_json,
        actions_json = excluded.actions_json,
        outcomes_json = excluded.outcomes_json,
        pattern_summary = excluded.pattern_summary,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at
    `, [
      decisionCase.sessionId,
      decisionCase.userId,
      decisionCase.domain,
      decisionCase.useCase,
      decisionCase.title,
      decisionCase.decisionStatement,
      decisionCase.contextSummary,
      JSON.stringify(decisionCase.signals || []),
      JSON.stringify(decisionCase.constraints || []),
      JSON.stringify(decisionCase.options || []),
      JSON.stringify(decisionCase.tradeoffs || []),
      JSON.stringify(decisionCase.actions || []),
      JSON.stringify(decisionCase.outcomes || []),
      decisionCase.patternSummary,
      decisionCase.confidence,
      now,
      now
    ]);
  }

  getDecisionCaseId(sessionId, domain, useCase) {
    const row = this.get(`
      SELECT id
      FROM decision_cases
      WHERE session_id = ? AND domain = ? AND use_case = ?
    `, [sessionId, domain, useCase]);

    return row?.id || 0;
  }

  replaceDecisionEvidence(decisionCaseId, transcriptTurnIds) {
    const now = new Date().toISOString();

    this.run("DELETE FROM evidence_links WHERE decision_case_id = ?", [decisionCaseId]);

    for (const turnId of transcriptTurnIds || []) {
      this.run(`
        INSERT OR IGNORE INTO evidence_links (
          decision_case_id, transcript_turn_id, evidence_type, created_at
        )
        VALUES (?, ?, ?, ?)
      `, [decisionCaseId, turnId, "transcript_turn", now]);
    }
  }

  replaceDecisionEntities(decisionCaseId, entities) {
    const now = new Date().toISOString();

    this.run("DELETE FROM decision_case_entities WHERE decision_case_id = ?", [decisionCaseId]);

    for (const entity of entities || []) {
      const entityKey = typeof entity === "string" ? entity : entity.key;
      const role = typeof entity === "string" ? "domain_entity" : entity.role || "domain_entity";

      this.run(`
        INSERT INTO decision_case_entities (decision_case_id, entity_key, role, created_at)
        VALUES (?, ?, ?, ?)
      `, [decisionCaseId, entityKey, role, now]);
    }
  }

  upsertTavusDocumentSync(sync) {
    return this.run(`
      INSERT INTO tavus_document_syncs (
        scope, scope_id, domain, document_name, document_url, document_id,
        tags_json, status, content_hash, metadata_json, synced_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, scope_id, content_hash) DO UPDATE SET
        domain = excluded.domain,
        document_name = excluded.document_name,
        document_url = excluded.document_url,
        document_id = excluded.document_id,
        tags_json = excluded.tags_json,
        status = excluded.status,
        metadata_json = excluded.metadata_json,
        synced_at = excluded.synced_at,
        updated_at = excluded.updated_at
    `, [
      sync.scope,
      sync.scopeId,
      sync.domain,
      sync.documentName,
      sync.documentUrl,
      sync.documentId,
      JSON.stringify(sync.tags || []),
      sync.status,
      sync.contentHash,
      JSON.stringify(sync.metadata || {}),
      sync.syncedAt,
      sync.now,
      sync.now
    ]);
  }

  getLatestTavusDocumentSync(scope, scopeId) {
    return this.get(`
      SELECT *
      FROM tavus_document_syncs
      WHERE scope = ? AND scope_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `, [scope, scopeId]);
  }

  listLatestTavusDocumentIds(scopePairs) {
    const ids = [];

    for (const pair of scopePairs) {
      const row = this.getLatestTavusDocumentSync(pair.scope, pair.scopeId);

      if (row?.document_id) {
        ids.push(row.document_id);
      }
    }

    return ids;
  }

  getTableCounts() {
    return {
      users: Number(this.get("SELECT COUNT(*) AS count FROM users").count || 0),
      interviewSessions: Number(this.get("SELECT COUNT(*) AS count FROM interview_sessions").count || 0),
      transcriptTurns: Number(this.get("SELECT COUNT(*) AS count FROM conversation_transcripts").count || 0),
      structuredOutputs: Number(this.get("SELECT COUNT(*) AS count FROM structured_interview_outputs").count || 0),
      udmConcepts: Number(this.get("SELECT COUNT(*) AS count FROM domain_udm_concepts").count || 0),
      decisionCases: Number(this.get("SELECT COUNT(*) AS count FROM decision_cases").count || 0),
      tavusDocumentSyncs: Number(this.get("SELECT COUNT(*) AS count FROM tavus_document_syncs").count || 0)
    };
  }
}

class MySqlAdapter {
  constructor(pool) {
    this.pool = pool;
    this.kind = "mysql";
  }

  async run(sql, params = []) {
    const [result] = await this.pool.execute(sql, params);
    return {
      changes: result.affectedRows || 0,
      lastInsertRowid: result.insertId || 0
    };
  }

  async get(sql, params = []) {
    const [rows] = await this.pool.execute(sql, params);
    return rows[0] || null;
  }

  async all(sql, params = []) {
    const [rows] = await this.pool.execute(sql, params);
    return rows;
  }

  async migrate() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS users (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        google_sub VARCHAR(255) NOT NULL UNIQUE,
        email VARCHAR(320) NOT NULL,
        name VARCHAR(255) NOT NULL,
        first_name VARCHAR(255),
        last_name VARCHAR(255),
        linkedin TEXT,
        domain VARCHAR(120),
        resume_file_name TEXT,
        resume_mime_type VARCHAR(255),
        resume_size_bytes INT,
        resume_content_base64 LONGTEXT,
        resume_text LONGTEXT,
        resume_uploaded_at VARCHAR(40),
        picture TEXT,
        email_verified TINYINT NOT NULL DEFAULT 0,
        created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL,
        last_login_at VARCHAR(40),
        INDEX idx_users_email (email)
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        session_token VARCHAR(255) NOT NULL UNIQUE,
        user_id INT NOT NULL,
        created_at VARCHAR(40) NOT NULL,
        expires_at VARCHAR(40) NOT NULL,
        INDEX idx_sessions_token (session_token),
        INDEX idx_sessions_expires_at (expires_at),
        CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS personal_contexts (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL UNIQUE,
        linkedin_url TEXT,
        domain VARCHAR(120),
        context_text LONGTEXT,
        future_direction LONGTEXT,
        context_json LONGTEXT,
        source_json LONGTEXT,
        created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL,
        CONSTRAINT fk_personal_contexts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS interview_sessions (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        domain VARCHAR(120),
        status VARCHAR(80) NOT NULL,
        tavus_conversation_id VARCHAR(255) UNIQUE,
        persona_id VARCHAR(255),
        replica_id VARCHAR(255),
        profile_snapshot_json LONGTEXT,
        summary LONGTEXT,
        metadata_json LONGTEXT,
        started_at VARCHAR(40),
        ended_at VARCHAR(40),
        created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL,
        INDEX idx_interview_sessions_user_id (user_id),
        INDEX idx_interview_sessions_conversation_id (tavus_conversation_id),
        CONSTRAINT fk_interview_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS conversation_transcripts (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        session_id INT NOT NULL,
        speaker VARCHAR(255) NOT NULL,
        speaker_role VARCHAR(255),
        turn_index INT,
        text LONGTEXT NOT NULL,
        started_at VARCHAR(40),
        ended_at VARCHAR(40),
        tavus_event_id VARCHAR(255),
        source_event_type VARCHAR(255),
        metadata_json LONGTEXT,
        created_at VARCHAR(40) NOT NULL,
        INDEX idx_conversation_transcripts_session_id (session_id),
        CONSTRAINT fk_conversation_transcripts_session FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS structured_interview_outputs (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        session_id INT NOT NULL,
        domain VARCHAR(120) NOT NULL,
        schema_version VARCHAR(120) NOT NULL,
        structured_json LONGTEXT NOT NULL,
        confidence_json LONGTEXT,
        created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL,
        UNIQUE KEY unique_structured_output (session_id, domain, schema_version),
        INDEX idx_structured_outputs_session_id (session_id),
        CONSTRAINT fk_structured_outputs_session FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS domain_shared_contexts (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        domain VARCHAR(120) NOT NULL UNIQUE,
        context_text LONGTEXT NOT NULL,
        source_json LONGTEXT,
        created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS domain_udm_concepts (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        domain VARCHAR(120) NOT NULL,
        concept_key VARCHAR(160) NOT NULL,
        label VARCHAR(255) NOT NULL,
        concept_type VARCHAR(120) NOT NULL,
        description LONGTEXT,
        shared_flag TINYINT NOT NULL DEFAULT 0,
        created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL,
        UNIQUE KEY unique_domain_concept (domain, concept_key),
        INDEX idx_domain_udm_concepts_domain (domain)
      )`,
      `CREATE TABLE IF NOT EXISTS domain_udm_relationships (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        domain VARCHAR(120) NOT NULL,
        source_concept_key VARCHAR(160) NOT NULL,
        relationship_type VARCHAR(160) NOT NULL,
        target_concept_key VARCHAR(160) NOT NULL,
        description LONGTEXT,
        created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL,
        UNIQUE KEY unique_domain_relationship (domain, source_concept_key, relationship_type, target_concept_key),
        INDEX idx_domain_udm_relationships_domain (domain)
      )`,
      `CREATE TABLE IF NOT EXISTS decision_cases (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        session_id INT NOT NULL,
        user_id INT NOT NULL,
        domain VARCHAR(120) NOT NULL,
        use_case VARCHAR(160) NOT NULL,
        title VARCHAR(255) NOT NULL,
        decision_statement LONGTEXT,
        context_summary LONGTEXT,
        signals_json LONGTEXT,
        constraints_json LONGTEXT,
        options_json LONGTEXT,
        tradeoffs_json LONGTEXT,
        actions_json LONGTEXT,
        outcomes_json LONGTEXT,
        pattern_summary LONGTEXT,
        confidence VARCHAR(80),
        created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL,
        UNIQUE KEY unique_decision_case (session_id, domain, use_case),
        INDEX idx_decision_cases_domain (domain),
        INDEX idx_decision_cases_user_id (user_id),
        CONSTRAINT fk_decision_cases_session FOREIGN KEY (session_id) REFERENCES interview_sessions(id) ON DELETE CASCADE,
        CONSTRAINT fk_decision_cases_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS decision_case_entities (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        decision_case_id INT NOT NULL,
        entity_key VARCHAR(160) NOT NULL,
        role VARCHAR(120),
        created_at VARCHAR(40) NOT NULL,
        INDEX idx_decision_case_entities_case (decision_case_id),
        CONSTRAINT fk_decision_case_entities_case FOREIGN KEY (decision_case_id) REFERENCES decision_cases(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS evidence_links (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        decision_case_id INT NOT NULL,
        transcript_turn_id INT NOT NULL,
        evidence_type VARCHAR(80),
        created_at VARCHAR(40) NOT NULL,
        UNIQUE KEY unique_evidence_link (decision_case_id, transcript_turn_id),
        INDEX idx_evidence_links_case (decision_case_id),
        INDEX idx_evidence_links_turn (transcript_turn_id),
        CONSTRAINT fk_evidence_links_case FOREIGN KEY (decision_case_id) REFERENCES decision_cases(id) ON DELETE CASCADE,
        CONSTRAINT fk_evidence_links_turn FOREIGN KEY (transcript_turn_id) REFERENCES conversation_transcripts(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS tavus_document_syncs (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        scope VARCHAR(80) NOT NULL,
        scope_id VARCHAR(160) NOT NULL,
        domain VARCHAR(120),
        document_name VARCHAR(255) NOT NULL,
        document_url TEXT NOT NULL,
        document_id VARCHAR(255),
        tags_json LONGTEXT,
        status VARCHAR(80) NOT NULL,
        content_hash VARCHAR(128) NOT NULL,
        metadata_json LONGTEXT,
        synced_at VARCHAR(40),
        created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL,
        UNIQUE KEY unique_tavus_document_sync (scope, scope_id, content_hash),
        INDEX idx_tavus_document_syncs_scope (scope, scope_id)
      )`
    ];

    for (const statement of statements) {
      await this.pool.execute(statement);
    }

    await this.ensureColumn("personal_contexts", "context_json", "LONGTEXT");
  }

  async ensureColumn(tableName, columnName, columnType) {
    const [rows] = await this.pool.execute(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
    `, [tableName, columnName]);

    if (!rows.length) {
      await this.pool.execute(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
    }
  }

  upsertAuthenticatedUser(user) {
    return this.run(`
      INSERT INTO users (google_sub, email, name, picture, email_verified, created_at, updated_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        email = VALUES(email),
        name = VALUES(name),
        picture = VALUES(picture),
        email_verified = VALUES(email_verified),
        updated_at = VALUES(updated_at),
        last_login_at = VALUES(last_login_at)
    `, [
      user.googleSub,
      user.email,
      user.name,
      user.picture,
      user.emailVerified,
      user.now,
      user.now,
      user.now
    ]);
  }

  upsertPersonalContext(userId, linkedIn, domain, contextText, futureDirection, contextJson, source, createdAt, updatedAt) {
    return this.run(`
      INSERT INTO personal_contexts (
        user_id, linkedin_url, domain, context_text, future_direction, context_json, source_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        linkedin_url = VALUES(linkedin_url),
        domain = VALUES(domain),
        context_text = VALUES(context_text),
        future_direction = VALUES(future_direction),
        context_json = VALUES(context_json),
        source_json = VALUES(source_json),
        updated_at = VALUES(updated_at)
    `, [userId, linkedIn, domain, contextText, futureDirection, contextJson, source, createdAt, updatedAt]);
  }

  upsertStructuredOutput(sessionId, domain, schemaVersion, structuredJson, confidenceJson, createdAt, updatedAt) {
    return this.run(`
      INSERT INTO structured_interview_outputs (
        session_id, domain, schema_version, structured_json, confidence_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        structured_json = VALUES(structured_json),
        confidence_json = VALUES(confidence_json),
        updated_at = VALUES(updated_at)
    `, [sessionId, domain, schemaVersion, structuredJson, confidenceJson, createdAt, updatedAt]);
  }

  upsertSharedDomainContext(context) {
    return this.run(`
      INSERT INTO domain_shared_contexts (domain, context_text, source_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        context_text = VALUES(context_text),
        source_json = VALUES(source_json),
        updated_at = VALUES(updated_at)
    `, [context.domain, context.contextText, context.sourceJson, context.now, context.now]);
  }

  upsertDomainConcept(concept) {
    return this.run(`
      INSERT INTO domain_udm_concepts (
        domain, concept_key, label, concept_type, description, shared_flag, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        label = VALUES(label),
        concept_type = VALUES(concept_type),
        description = VALUES(description),
        shared_flag = VALUES(shared_flag),
        updated_at = VALUES(updated_at)
    `, [
      concept.domain,
      concept.key,
      concept.label,
      concept.type,
      concept.description,
      concept.shared ? 1 : 0,
      concept.now,
      concept.now
    ]);
  }

  upsertDomainRelationship(relationship) {
    return this.run(`
      INSERT INTO domain_udm_relationships (
        domain, source_concept_key, relationship_type, target_concept_key, description, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        description = VALUES(description),
        updated_at = VALUES(updated_at)
    `, [
      relationship.domain,
      relationship.source,
      relationship.type,
      relationship.target,
      relationship.description,
      relationship.now,
      relationship.now
    ]);
  }

  upsertDecisionCase(decisionCase) {
    const now = new Date().toISOString();

    return this.run(`
      INSERT INTO decision_cases (
        session_id, user_id, domain, use_case, title, decision_statement,
        context_summary, signals_json, constraints_json, options_json,
        tradeoffs_json, actions_json, outcomes_json, pattern_summary,
        confidence, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        title = VALUES(title),
        decision_statement = VALUES(decision_statement),
        context_summary = VALUES(context_summary),
        signals_json = VALUES(signals_json),
        constraints_json = VALUES(constraints_json),
        options_json = VALUES(options_json),
        tradeoffs_json = VALUES(tradeoffs_json),
        actions_json = VALUES(actions_json),
        outcomes_json = VALUES(outcomes_json),
        pattern_summary = VALUES(pattern_summary),
        confidence = VALUES(confidence),
        updated_at = VALUES(updated_at)
    `, [
      decisionCase.sessionId,
      decisionCase.userId,
      decisionCase.domain,
      decisionCase.useCase,
      decisionCase.title,
      decisionCase.decisionStatement,
      decisionCase.contextSummary,
      JSON.stringify(decisionCase.signals || []),
      JSON.stringify(decisionCase.constraints || []),
      JSON.stringify(decisionCase.options || []),
      JSON.stringify(decisionCase.tradeoffs || []),
      JSON.stringify(decisionCase.actions || []),
      JSON.stringify(decisionCase.outcomes || []),
      decisionCase.patternSummary,
      decisionCase.confidence,
      now,
      now
    ]);
  }

  async getDecisionCaseId(sessionId, domain, useCase) {
    const row = await this.get(`
      SELECT id
      FROM decision_cases
      WHERE session_id = ? AND domain = ? AND use_case = ?
    `, [sessionId, domain, useCase]);

    return row?.id || 0;
  }

  async replaceDecisionEvidence(decisionCaseId, transcriptTurnIds) {
    const now = new Date().toISOString();

    await this.run("DELETE FROM evidence_links WHERE decision_case_id = ?", [decisionCaseId]);

    for (const turnId of transcriptTurnIds || []) {
      await this.run(`
        INSERT IGNORE INTO evidence_links (
          decision_case_id, transcript_turn_id, evidence_type, created_at
        )
        VALUES (?, ?, ?, ?)
      `, [decisionCaseId, turnId, "transcript_turn", now]);
    }
  }

  async replaceDecisionEntities(decisionCaseId, entities) {
    const now = new Date().toISOString();

    await this.run("DELETE FROM decision_case_entities WHERE decision_case_id = ?", [decisionCaseId]);

    for (const entity of entities || []) {
      const entityKey = typeof entity === "string" ? entity : entity.key;
      const role = typeof entity === "string" ? "domain_entity" : entity.role || "domain_entity";

      await this.run(`
        INSERT INTO decision_case_entities (decision_case_id, entity_key, role, created_at)
        VALUES (?, ?, ?, ?)
      `, [decisionCaseId, entityKey, role, now]);
    }
  }

  upsertTavusDocumentSync(sync) {
    return this.run(`
      INSERT INTO tavus_document_syncs (
        scope, scope_id, domain, document_name, document_url, document_id,
        tags_json, status, content_hash, metadata_json, synced_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        domain = VALUES(domain),
        document_name = VALUES(document_name),
        document_url = VALUES(document_url),
        document_id = VALUES(document_id),
        tags_json = VALUES(tags_json),
        status = VALUES(status),
        metadata_json = VALUES(metadata_json),
        synced_at = VALUES(synced_at),
        updated_at = VALUES(updated_at)
    `, [
      sync.scope,
      sync.scopeId,
      sync.domain,
      sync.documentName,
      sync.documentUrl,
      sync.documentId,
      JSON.stringify(sync.tags || []),
      sync.status,
      sync.contentHash,
      JSON.stringify(sync.metadata || {}),
      sync.syncedAt,
      sync.now,
      sync.now
    ]);
  }

  async getLatestTavusDocumentSync(scope, scopeId) {
    return this.get(`
      SELECT *
      FROM tavus_document_syncs
      WHERE scope = ? AND scope_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `, [scope, scopeId]);
  }

  async listLatestTavusDocumentIds(scopePairs) {
    const ids = [];

    for (const pair of scopePairs) {
      const row = await this.getLatestTavusDocumentSync(pair.scope, pair.scopeId);

      if (row?.document_id) {
        ids.push(row.document_id);
      }
    }

    return ids;
  }

  async getTableCounts() {
    const [
      users,
      interviewSessions,
      transcriptTurns,
      structuredOutputs,
      udmConcepts,
      decisionCases,
      tavusDocumentSyncs
    ] = await Promise.all([
      this.get("SELECT COUNT(*) AS count FROM users"),
      this.get("SELECT COUNT(*) AS count FROM interview_sessions"),
      this.get("SELECT COUNT(*) AS count FROM conversation_transcripts"),
      this.get("SELECT COUNT(*) AS count FROM structured_interview_outputs"),
      this.get("SELECT COUNT(*) AS count FROM domain_udm_concepts"),
      this.get("SELECT COUNT(*) AS count FROM decision_cases"),
      this.get("SELECT COUNT(*) AS count FROM tavus_document_syncs")
    ]);

    return {
      users: Number(users?.count || 0),
      interviewSessions: Number(interviewSessions?.count || 0),
      transcriptTurns: Number(transcriptTurns?.count || 0),
      structuredOutputs: Number(structuredOutputs?.count || 0),
      udmConcepts: Number(udmConcepts?.count || 0),
      decisionCases: Number(decisionCases?.count || 0),
      tavusDocumentSyncs: Number(tavusDocumentSyncs?.count || 0)
    };
  }
}

function cleanEnvValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseEnvList(value) {
  return cleanEnvValue(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function slugify(value) {
  return cleanValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "general";
}

bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

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
