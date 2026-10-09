import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  boundedCauseChain,
  canFallbackNonStreaming,
  classifyError,
  isCertificateVerificationError,
} from './retry-classification.mjs';
import { shouldFallbackTransport } from './retry-midstream.mjs';
import {
  _classifyHandshakeError,
  _classifyMidstreamError,
  _mustSurfaceCurrentAttempt,
} from './openai-ws-send-attempts/policy.mjs';

const certificateError = (code = 'SELF_SIGNED_CERT_IN_CHAIN') =>
  Object.assign(new Error('certificate verification failed'), { code });

test('certificate denial precedes transport and nonstreaming fallback allowances', () => {
  for (const annotations of [
    { retryClassifier: 'reset', wsHttpFallbackEligible: false },
    { httpStatus: 426 },
    { httpStatus: 503 },
    { truncatedStream: true },
    { firstByteTimeout: true },
  ]) {
    for (const error of [
      certificateError(),
      new TypeError('fetch failed', { cause: certificateError() }),
    ]) {
      Object.assign(error, annotations);
      assert.equal(shouldFallbackTransport(error), false);
      assert.equal(canFallbackNonStreaming(error), false);
    }
  }
  assert.equal(shouldFallbackTransport(Object.assign(new Error('upgrade'), { httpStatus: 426 })), true);
  assert.equal(shouldFallbackTransport(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
  assert.equal(canFallbackNonStreaming(Object.assign(new Error('cut'), { truncatedStream: true })), true);
});

test('certificate verification codes are permanent without denying ordinary TLS faults', () => {
  for (const code of [
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'CERT_REVOKED',
    'CERT_SIGNATURE_FAILURE',
    'CERT_UNTRUSTED',
    'CERT_REJECTED',
    'CERT_CHAIN_TOO_LONG',
    'INVALID_CA',
    'INVALID_PURPOSE',
    'PATH_LENGTH_EXCEEDED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED',
    'ERR_SSL_CERTIFICATE_VERIFY_FAILED',
  ]) {
    const error = certificateError(code);
    assert.equal(isCertificateVerificationError(error), true, code);
    assert.equal(classifyError(error), 'permanent', code);
    assert.equal(_classifyHandshakeError(error), null, code);
    assert.equal(_mustSurfaceCurrentAttempt(error), true, code);
  }
  for (const code of [
    'ECONNRESET',
    'EPROTO',
    'ERR_SSL_WRONG_VERSION_NUMBER',
    'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC',
    'ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC',
    'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
  ]) {
    const error = Object.assign(new Error('transport fault'), { code });
    assert.equal(isCertificateVerificationError(error), false, code);
    assert.equal(classifyError(error), 'transient', code);
    assert.notEqual(_classifyHandshakeError(error), null, code);
  }
});

test('certificate causes outrank fetch, SDK, reset, and stream transient annotations', () => {
  const certificate = certificateError();
  const reset = Object.assign(new Error('reset', { cause: certificate }), { code: 'ECONNRESET' });
  for (const error of [
    certificate,
    new TypeError('fetch failed', { cause: certificate }),
    Object.assign(new Error('connection error', { cause: certificate }), { name: 'APIConnectionError' }),
    Object.assign(new Error('timeout', { cause: reset }), { name: 'APIConnectionTimeoutError' }),
    Object.assign(new Error('response interrupted', { cause: certificate }), {
      httpStatus: 503,
      truncatedStream: true,
      wsCloseCode: 1006,
    }),
  ]) {
    assert.equal(isCertificateVerificationError(error), true);
    assert.equal(classifyError(error), 'permanent');
    assert.equal(_classifyHandshakeError(error), null);
    assert.equal(_classifyMidstreamError(error, {
      sawResponseCreated: true,
      sawCompleted: false,
      attemptIndex: 0,
    }), null);
    assert.equal(_mustSurfaceCurrentAttempt(error), true);
  }
  assert.equal(classifyError(Object.assign(new Error('auth', { cause: certificate }), { httpStatus: 401 })), 'auth');
  assert.equal(classifyError(Object.assign(new Error('cancelled', { cause: certificate }), { name: 'AbortError' })), 'permanent');
});

test('certificate classification reuses the bounded, cycle-safe cause chain', () => {
  const certificate = certificateError();
  let error = certificate;
  for (let index = 0; index < 7; index++) error = new TypeError('fetch failed', { cause: error });
  assert.equal(boundedCauseChain(error).length, 8);
  assert.equal(isCertificateVerificationError(error), true);
  assert.equal(classifyError(error), 'permanent');

  const beyondBound = new TypeError('fetch failed', { cause: error });
  assert.equal(boundedCauseChain(beyondBound).length, 8);
  assert.equal(isCertificateVerificationError(beyondBound), false);

  const cyclic = new TypeError('fetch failed', { cause: certificate });
  certificate.cause = cyclic;
  assert.equal(boundedCauseChain(cyclic).length, 2);
  assert.equal(isCertificateVerificationError(cyclic), true);
  assert.equal(classifyError(cyclic), 'permanent');
});
