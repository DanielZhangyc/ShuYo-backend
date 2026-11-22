const JWXT_IDENTITY_URL =
  'https://jwxt.shu.edu.cn/jwglxt/xtgl/index_initMenu.html?jsdm=xs&echarts=1';
const YJS_IDENTITY_URL =
  'https://yjs.shu.edu.cn/gsapp/sys/yjsemaphome/modules/pubWork/getUserInfo.do';
const YJS_PORTAL_URL = 'https://yjs.shu.edu.cn/gsapp/sys/yjsemaphome/portal/index.do';
const STUDENT_ID = /^[A-Za-z0-9]{6,24}$/;
const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

function normalizeStudentId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return STUDENT_ID.test(id) ? id.toUpperCase() : null;
}

function validCookieHeader(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 8192 || /[^\x20-\x7e]/.test(value)) {
    return false;
  }
  return value.split(';').every((part) =>
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+=/.test(part.trimStart())
  );
}

function selectSchoolCookies(source, value) {
  if (!validCookieHeader(value)) return null;
  const cookies = value.split(';').map((part) => part.trim());
  if (source === 'yjs') {
    // The YJS endpoint only needs the portal session, never the SSO session.
    const portal = cookies.filter((part) => part.startsWith('GS_SESSIONID='));
    return portal.length === 1 && portal[0].length > 'GS_SESSIONID='.length ? portal[0] : null;
  }
  const session = cookies.filter((part) => !/^(?:SHU_OAUTH2|webvpn-token|GS_SESSIONID)=/i.test(part));
  return session.length ? session.join('; ') : null;
}

function parseStudentId(html) {
  // JWXT renders this field for the current session. Ignore scripts/comments
  // and read only the actual hidden input, not text elsewhere on the page.
  const markup = html.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  let studentId = null;
  let seen = false;
  for (const [tag, element] of markup.matchAll(/<([a-z][\w:-]*)(?:[^<>"']|"[^"]*"|'[^']*')*>/gi)) {
    if (element.toLowerCase() !== 'input') continue;
    const attrs = new Map();
    for (const [, key, quoted, single, plain] of tag.slice('<input'.length, -1)
      .matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const name = key.toLowerCase();
      if (!attrs.has(name)) attrs.set(name, quoted ?? single ?? plain ?? '');
    }
    if (attrs.get('id') !== 'sessionUserKey') continue;
    if (seen || attrs.get('type')?.toLowerCase() !== 'hidden') return null;
    seen = true;
    studentId = normalizeStudentId(attrs.get('value'));
  }
  return studentId;
}

function parseYjsStudentId(body) {
  try {
    const json = JSON.parse(body);
    if (json?.code === 401 || json?.code === '401') return { status: 'session_expired' };
    if (json?.code === 403 || json?.code === '403') return { status: 'school_rejected' };
    const studentId = json?.code === '0' || json?.code === 0
      ? normalizeStudentId(json.data?.userId) : null;
    return studentId ? { status: 'verified', studentId } : { status: 'no_student_id' };
  } catch {
    return { status: 'no_student_id' };
  }
}

function maskedStudentId(studentId) {
  if (studentId.length <= 4) return '****';
  return `${studentId.slice(0, 2)}${'*'.repeat(studentId.length - 4)}${studentId.slice(-2)}`;
}

async function readSchoolIdentity(response, source) {
  const reader = response.body?.getReader();
  if (!reader) return { status: 'no_student_id' };
  const limit = source === 'yjs' ? 64 * 1024 : 512 * 1024;
  const decoder = new TextDecoder('utf-8');
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return { status: 'school_response_too_large' };
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
  chunks.push(decoder.decode());
  const body = chunks.join('');
  if (source === 'yjs') return parseYjsStudentId(body);
  const studentId = parseStudentId(body);
  return studentId ? { status: 'verified', studentId } : { status: 'no_student_id' };
}

async function fetchSchoolStudentId({ source = 'jwxt', cookieHeader, fetchImpl = fetch }) {
  if (source !== 'jwxt' && source !== 'yjs') return { status: 'invalid_school_source' };
  const cookie = selectSchoolCookies(source, cookieHeader);
  if (!cookie) return { status: 'invalid_cookie' };
  const yjs = source === 'yjs';
  try {
    const response = await fetchImpl(yjs ? YJS_IDENTITY_URL : JWXT_IDENTITY_URL, {
      method: yjs ? 'POST' : 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
      headers: {
        accept: yjs ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml',
        cookie,
        referer: yjs ? YJS_PORTAL_URL : JWXT_IDENTITY_URL,
        'user-agent': MOBILE_USER_AGENT,
        ...(yjs ? { origin: 'https://yjs.shu.edu.cn' } : {})
      }
    });
    if (response.status === 200) return await readSchoolIdentity(response, source);
    await response.body?.cancel().catch(() => {});
    if ((response.status >= 300 && response.status < 400) || response.status === 401) {
      return { status: 'session_expired' };
    }
    if (response.status === 403) return { status: 'school_rejected' };
    return { status: 'school_unavailable' };
  } catch {
    // School cookies and the upstream response must never reach error logs.
    return { status: 'network_error' };
  }
}

async function probeSchoolIdentity({ source, cookieHeader, expectedStudentId, fetchImpl = fetch }) {
  const expected = normalizeStudentId(expectedStudentId);
  if (!expected) return { status: 'invalid_student_id' };
  const identity = await fetchSchoolStudentId({ source, cookieHeader, fetchImpl });
  if (identity.status !== 'verified') return identity;
  return {
    status: 'verified',
    matchesLocal: identity.studentId === expected,
    maskedStudentId: maskedStudentId(identity.studentId)
  };
}

export { fetchSchoolStudentId, maskedStudentId, normalizeStudentId, parseStudentId, probeSchoolIdentity };
