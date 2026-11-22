import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = mkdtempSync(path.join(os.tmpdir(), 'shuyo-data-deletion-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = directory;
process.env.COOKIE_SECRET = 'test-cookie-secret';
process.env.STUDENT_ID_HMAC_SECRET = '11'.repeat(32);
process.env.STUDENT_ID_ENCRYPTION_KEY = '22'.repeat(32);
process.env.SHARE_DATA_KEY = '33'.repeat(32);

const { app, adminStore, studentIdentityStore, engagementStore, shareStore, reviewStore } =
  await import('../src/server.js');

test('school verification deletes data without renewing a revoked device', async () => {
  const session = studentIdentityStore.createSession({ studentId: '23123456' });
  engagementStore.createFeedback(session.accountId, {
    title: '问题', content: '内容', contact: '', appVersion: '1', platform: 'ios'
  });
  engagementStore.recordPresence(session.accountId);
  reviewStore.importCatalog([{ 课程号: 'C1', 课程名称: '课程', 上课教师工号: 'T1', 上课教师姓名: '老师', 教学班ID: 'S1' }],
    '2026-2027-1');
  const unitId = reviewStore.course('C1').units[0].id;
  reviewStore.saveReview(session.accountId, unitId, { overall: 4 });
  reviewStore.createFeedback(session.accountId, { kind: 'other', content: '课评', appVersion: '1', platform: 'ios' });
  shareStore.create(session.accountId, 'request-aaaaaaaa', {
    term: { yearCode: '2026', termCode: '3' }, sessions: [], untimedCourses: []
  }, false);
  studentIdentityStore.revokeAllSessions(session.accountId);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (new URL(url).hostname === 'jwxt.shu.edu.cn') {
      assert.equal(options.headers.cookie, 'JSESSIONID=fresh-school-login');
      assert.equal(new URL(url).pathname, '/jwglxt/xtgl/index_initMenu.html');
      return new Response('<input type="hidden" id="sessionUserKey" value="23123456">');
    }
    if (new URL(url).hostname === 'yjs.shu.edu.cn') {
      assert.equal(options.headers.cookie, 'GS_SESSIONID=fresh-school-login');
      assert.equal(options.method, 'POST');
      return Response.json({ code: '0', data: { userId: '23123456' } });
    }
    return originalFetch(url, options);
  };
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, method, body) => originalFetch(base + route, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const yjsProof = {
    schoolSession: { source: 'yjs', cookie: 'GS_SESSIONID=fresh-school-login' },
    expectedStudentId: '23123456'
  };
  try {
    assert.equal((await request('/api/v1/student/data-deletion/verify', 'POST', {
      schoolCookie: 'JSESSIONID=fresh-school-login', expectedStudentId: '87654321'
    })).status, 409);
    const verified = await request('/api/v1/student/data-deletion/verify', 'POST', yjsProof);
    assert.equal(verified.status, 200);
    const grant = (await verified.json()).data;
    assert.equal(grant.maskedStudentId, '23****56');
    assert.equal(studentIdentityStore.listSessions(session.accountId).length, 0);
    assert.equal((await request('/api/v1/student/data', 'DELETE', { token: grant.token })).status, 204);
    assert.equal(studentIdentityStore.getAccount(session.accountId), null);
    assert.equal(engagementStore.listFeedback(session.accountId).length, 0);
    assert.equal(shareStore.current(session.accountId), null);
    assert.equal(reviewStore.unit(unitId).reviewCount, 0);
    assert.equal(reviewStore.listFeedback(session.accountId).length, 0);
    assert.equal((await request('/api/v1/student/data', 'DELETE', { token: grant.token })).status, 401);
    assert.equal((await request('/api/v1/student/sessions', 'POST', {
      schoolCookie: 'JSESSIONID=fresh-school-login', expectedStudentId: '23123456'
    })).status, 403);
    assert.equal(studentIdentityStore.getAccount(session.accountId), null);
    const started = await request('/api/v1/student/sessions', 'POST', {
      schoolCookie: 'JSESSIONID=fresh-school-login', expectedStudentId: '23123456',
      userInitiated: true
    });
    assert.equal(started.status, 201);
    const accountId = (await started.json()).data.accountId;
    assert.notEqual(accountId, session.accountId);
    const yjsSession = await request('/api/v1/student/sessions', 'POST', { ...yjsProof, userInitiated: true });
    assert.equal(yjsSession.status, 201);
    assert.equal((await yjsSession.json()).data.accountId, accountId);
    const revokedProof = await request('/api/v1/student/sessions', 'POST', {
      ...yjsProof, schoolSession: { ...yjsProof.schoolSession, source: 'unknown' }, userInitiated: true
    });
    assert.equal(revokedProof.status, 400);
    assert.equal((await revokedProof.json()).code, 'invalid_school_source');
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(() => {
  shareStore.close();
  engagementStore.close();
  studentIdentityStore.close();
  adminStore.close();
  rmSync(directory, { recursive: true, force: true });
});
