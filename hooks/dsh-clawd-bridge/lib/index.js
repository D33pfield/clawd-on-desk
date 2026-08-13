// dsh-clawd-bridge — route DSH's interactive seams (ask_user_question and
// approval requests) to the Clawd desktop pet's permission bubbles.
//
// The web profile already registers a browser-backed user-questions provider
// (api-proxy) and an approval/request listener. This plugin:
//   1. takes over the userQuestions provider (Clawd bubble first, web UI as
//      fallback when Clawd is unreachable or declines),
//   2. prepends an approval/request listener (Clawd bubble first, the
//      browser answerer via next() otherwise).
//
// Wire contract with Clawd (src/server-route-permission.js): a POST to
// /permission carrying agent_id "deepseek-harness"; the HTTP response is the
// decision:
//   { decision: "allow" | "deny" }                          permission request
//   { decision: "allow", answers: [{ id, selected[], custom? }] }  question
// A dropped connection / non-JSON body means "no answerer" and the request
// falls back to DSH's native path (fail closed on approval).
//
// Erasable-only TS syntax (no enums/namespaces); zero runtime dependencies.

import { randomUUID } from 'node:crypto'
import http from 'node:http'

export const name = 'dsh-clawd-bridge'

/** Activate once the user-questions seam exists. */
export const inject = ['userQuestions']

export const DEFAULT_CLAWD_BASE_URL = 'http://127.0.0.1:23333'

export const DEFAULT_ANSWER_TIMEOUT_MS = 10 * 60 * 1000

/** POST one JSON body to Clawd's /permission; resolve null on any failure. */
function postToClawd(baseUrl, body, signal, timeoutMs) {
  return new Promise((resolve) => {
    let url
    try {
      url = new URL(`${baseUrl.replace(/\/$/, '')}/permission`)
    } catch {
      resolve(null)
      return
    }
    const payload = JSON.stringify(body)
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (response) => {
      let data = ''
      response.on('data', (chunk) => { data += chunk })
      response.on('end', () => {
        if (data.length === 0) {
          resolve(null)
          return
        }
        try {
          resolve(JSON.parse(data))
        } catch {
          resolve(null)
        }
      })
      response.on('error', () => resolve(null))
    })
    request.on('error', () => resolve(null))
    request.setTimeout(timeoutMs, () => {
      request.destroy()
      resolve(null)
    })
    const onAbort = () => {
      request.destroy()
      resolve(null)
    }
    if (signal !== undefined) {
      if (signal.aborted === true) {
        request.destroy()
        resolve(null)
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    request.end(payload)
  })
}

/** Map a userQuestions ask() request onto Clawd's /permission payload. */
function buildQuestionPayload(request) {
  const questions = (request.questions ?? []).map((question) => ({
    id: question.id,
    question: question.question,
    ...(question.header !== undefined ? { header: question.header } : {}),
    ...(Array.isArray(question.options) && question.options.length > 0
      ? { options: question.options }
      : {}),
    ...(question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {}),
  }))
  return {
    agent_id: 'deepseek-harness',
    hook_event_name: 'AskUserQuestion',
    session_id: request.agent?.id ?? '',
    tool_name: 'ask_user_question',
    tool_use_id: randomUUID(),
    tool_input: { questions },
    reason: 'ask_user_question',
  }
}

/** Map an approval request onto Clawd's /permission payload. */
function buildApprovalPayload(req) {
  return {
    agent_id: 'deepseek-harness',
    hook_event_name: 'PermissionRequest',
    session_id: req.agent?.id ?? '',
    tool_name: req.toolName ?? 'unknown',
    tool_use_id: req.callId ?? randomUUID(),
    tool_input: findToolCallArguments(req),
    reason: req.reason ?? '',
  }
}

/**
 * DSH's escalation ask carries only { toolName, callId, reason } — the tool
 * arguments live in the session's tool/call event. Recover them by callId so
 * the Clawd bubble can show what would actually run.
 */
function findToolCallArguments(req) {
  const events = req.agent?.session?.events
  if (!Array.isArray(events)) return {}
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'tool/call') continue
    if (event.data?.callId !== req.callId) continue
    const args = event.data.arguments
    if (typeof args === 'string') {
      try {
        return JSON.parse(args)
      } catch {
        return { raw: args }
      }
    }
    if (args !== null && typeof args === 'object') return args
    return {}
  }
  return {}
}

export function apply(ctx, config) {
  const baseUrl = config?.clawdBaseUrl ?? DEFAULT_CLAWD_BASE_URL
  const timeoutMs = config?.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS

  // ── 1) user-questions provider takeover ────────────────────────────────
  // The web profile's api-gateway registers the browser-backed provider
  // during ITS apply, which races this plugin's apply (activation is
  // service-availability driven, not row-order driven). Take over only once
  // the web provider has landed so it can be captured as the fallback;
  // poll because there is no "provider registered" event.
  const takeOverProvider = () => {
    const service = ctx.userQuestions
    const webProvider = service?.provider
    if (service === undefined || webProvider === undefined) {
      setTimeout(takeOverProvider, 100)
      return
    }
    service.provider = {
      ask: async (request) => {
        const response = await postToClawd(
          baseUrl,
          buildQuestionPayload(request),
          request.signal,
          timeoutMs,
        )
        if (response !== null
          && response.decision === 'allow'
          && Array.isArray(response.answers)) {
          return { answers: response.answers }
        }
        if (webProvider !== undefined && typeof webProvider.ask === 'function') {
          return webProvider.ask(request)
        }
        throw new Error('dsh-clawd-bridge: no answerer available for ask_user_question')
      },
    }
    ctx.effect(() => () => {
      service.provider = webProvider
    }, 'clawd-bridge: restore user-questions provider')
  }
  takeOverProvider()

  // ── 2) approval-request listener (Clawd first, web UI via next()) ──────
  // approval is another bundle row whose activation races this plugin; guard
  // the listener registration behind ctx.inject so it never silently misses.
  ctx.inject(['approval'], (approvalCtx) => {
    approvalCtx.on('approval/request', (req, next) => {
      if (req.signal?.aborted === true) return Promise.resolve('cancelled')
      return postToClawd(baseUrl, buildApprovalPayload(req), req.signal, timeoutMs)
        .then((response) => {
          if (response === null) return next()
          if (response.decision === 'allow') return 'allowed-once'
          if (response.decision === 'deny') return 'rejected'
          return next()
        })
    }, { prepend: true })
  })
}
