import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchSchoolStudentId, probeSchoolIdentity } from '../src/identityProbe.js';

const expectedStudentId = '23123456';
const cookieHeader = 'JSESSIONID=fixture-session';
const home = '<input type="hidden" id="sessionUserKey" value="23123456" />';

test('JWXT reads the logged-in identity from the homepage, not academic progress', async () => {
  const result = await probeSchoolIdentity({
    cookieHeader: `${cookieHeader}; route=node-a; SHU_OAUTH2=not-for-jwxt; GS_SESSIONID=not-for-jwxt`,
    expectedStudentId,
    fetchImpl: async (url, request) => {
      assert.equal(url, 'https://jwxt.shu.edu.cn/jwglxt/xtgl/index_initMenu.html?jsdm=xs&echarts=1');
      assert.equal(request.method, 'GET');
      assert.equal(request.redirect, 'manual');
      assert.equal(request.headers.cookie, `${cookieHeader}; route=node-a`);
      assert.equal(request.body, undefined);
      return new Response(home);
    }
  });
  assert.deepEqual(result, { status: 'verified', matchesLocal: true, maskedStudentId: '23****56' });
  assert.equal(JSON.stringify(result).includes(expectedStudentId), false);
});

for (const code of ['0', 0]) {
  test(`YJS reads data.userId with success code ${JSON.stringify(code)} and only the portal cookie`, async () => {
    const result = await probeSchoolIdentity({
      source: 'yjs',
      cookieHeader: 'GS_SESSIONID=fixture-portal; SHU_OAUTH2=not-for-yjs; JSESSIONID=not-for-yjs',
      expectedStudentId: '23ABC456',
      fetchImpl: async (url, request) => {
        assert.equal(url, 'https://yjs.shu.edu.cn/gsapp/sys/yjsemaphome/modules/pubWork/getUserInfo.do');
        assert.equal(request.method, 'POST');
        assert.equal(request.redirect, 'manual');
        assert.equal(request.headers.cookie, 'GS_SESSIONID=fixture-portal');
        assert.equal(request.body, undefined);
        return Response.json({ code, data: { userId: ' 23abc456 ' } });
      }
    });
    assert.deepEqual(result, { status: 'verified', matchesLocal: true, maskedStudentId: '23****56' });
  });
}

test('rejects unsupported sources and missing or malformed school cookies without contacting upstream', async () => {
  const fetchImpl = async () => assert.fail('must not contact school');
  for (const [source, cookie, status] of [
    [null, cookieHeader, 'invalid_school_source'],
    ['unsupported', cookieHeader, 'invalid_school_source'],
    ['jwxt', 'JSESSIONID=ok\r\n', 'invalid_cookie'],
    ['yjs', 'SHU_OAUTH2=sso-only', 'invalid_cookie'],
    ['yjs', 'GS_SESSIONID=fixture-a; GS_SESSIONID=fixture-b', 'invalid_cookie']
  ]) {
    assert.deepEqual(await fetchSchoolStudentId({ source, cookieHeader: cookie, fetchImpl }), { status });
  }
});

for (const source of ['jwxt', 'yjs']) {
  test(`${source} does not follow an expired-session redirect`, async () => {
    const calls = [];
    const result = await fetchSchoolStudentId({
      source,
      cookieHeader: source === 'yjs' ? 'GS_SESSIONID=fixture-portal' : cookieHeader,
      fetchImpl: async (url, options) => {
        calls.push(new URL(url).hostname);
        assert.equal(options.redirect, 'manual');
        return new Response(null, {
          status: 302,
          headers: { location: 'https://newsso.shu.edu.cn/oauth2/login/' }
        });
      }
    });
    assert.deepEqual(calls, [`${source}.shu.edu.cn`]);
    assert.deepEqual(result, { status: 'session_expired' });
  });
}

test('success requires an unambiguous school-owned identity, not other fields or an HTML login page', async () => {
  for (const body of [`<!-- ${home} -->`, `<script>${JSON.stringify(home)}</script>`, home + home,
    '<form id="form"><input name="xh_id" value="23123456"></form>']) {
    const result = await fetchSchoolStudentId({ cookieHeader, fetchImpl: async () => new Response(body) });
    assert.equal(result.status, 'no_student_id');
  }
  for (const body of ['<html>请登录</html>', '{"code":"0","userId":"23123456"}',
    '{"code":"1","data":{"userId":"23123456"}}', '{"code":"0","data":{"userId":""}}']) {
    const result = await fetchSchoolStudentId({
      source: 'yjs', cookieHeader: 'GS_SESSIONID=fixture-portal', fetchImpl: async () => new Response(body)
    });
    assert.equal(result.status, 'no_student_id');
  }
});

test('cancels an oversized homepage without accepting an identity from it', async () => {
  const encoder = new TextEncoder();
  let canceled = false;
  const schoolResponse = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(home));
      controller.enqueue(encoder.encode('x'.repeat(512 * 1024)));
    },
    cancel() { canceled = true; }
  }));
  const result = await fetchSchoolStudentId({ cookieHeader, fetchImpl: async () => schoolResponse });
  assert.equal(result.status, 'school_response_too_large');
  assert.equal(canceled, true);
});
